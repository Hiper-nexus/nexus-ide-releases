import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ensureWorkspaceDirectory,
  openWorkspaceFileForRead,
  readWorkspaceTextFile,
  replaceWorkspaceTextFileAtomically,
} from '../orch/workspace-file';
import { canonicalJson } from './canonical-json';
import type { ContextSourceType } from './context-types';

const ATTESTATION_ROOT = '.context/nexus/attestations';
const MAX_ATTESTATIONS = 4_096;
const MAX_ATTESTATION_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ATTESTATION_ID_PATTERN = /^att-[a-f0-9]{40}$/;
const PORTABLE_SEGMENT = /^[^<>:"|?*\u0000-\u001f]+$/;

const sourceTypeSchema = z.enum([
  'file',
  'git',
  'test',
  'schema',
  'connector',
  'decision',
]);
const sourceSchema = z.object({
  type: sourceTypeSchema,
  locator: z.string().trim().min(1).max(4_096),
  sourceHash: z.string().regex(HASH_PATTERN),
}).strict();
const portableIdentitySchema = z.object({
  id: z.string().trim().min(1).max(256),
  provider: z.string().trim().min(1).max(256),
  sessionFingerprint: z.string().regex(HASH_PATTERN),
}).strict();
const attestationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(ATTESTATION_ID_PATTERN),
  projectId: z.string().trim().min(1).max(256),
  targetPath: z.string().trim().min(1).max(4_096),
  targetHash: z.string().regex(HASH_PATTERN),
  sources: z.array(sourceSchema).min(1).max(256),
  author: portableIdentitySchema,
  reviewer: portableIdentitySchema,
  reviewedAt: z.iso.datetime(),
  issuerInstallationId: z.string().trim().min(1).max(256),
  nexusVersion: z.string().trim().min(1).max(64),
}).strict().superRefine((value, context) => {
  if (
    value.author.id === value.reviewer.id ||
    value.author.sessionFingerprint === value.reviewer.sessionFingerprint
  ) {
    context.addIssue({ code: 'custom', message: 'context review must be independent' });
  }
  // Provider remains portable provenance, not reviewer identity. The actor id
  // and one-way physical-session fingerprint above prevent self-attestation.
  const locators = value.sources.map((source) => source.locator);
  if (new Set(locators).size !== locators.length) {
    context.addIssue({ code: 'custom', message: 'context attestation sources must be unique' });
  }
});

export interface ContextAttestationSource {
  readonly type: ContextSourceType;
  readonly locator: string;
  readonly sourceHash: string;
}

export interface ContextAttestationIdentity {
  readonly id: string;
  readonly provider: string;
  readonly sessionFingerprint: string;
}

export interface ContextAttestation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly targetPath: string;
  readonly targetHash: string;
  readonly sources: readonly ContextAttestationSource[];
  readonly author: ContextAttestationIdentity;
  readonly reviewer: ContextAttestationIdentity;
  readonly reviewedAt: string;
  readonly issuerInstallationId: string;
  readonly nexusVersion: string;
}

export interface ContextAttestationActor {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: string;
}

export interface CreateContextAttestationInput {
  readonly targetPath: string;
  readonly targetHash: string;
  readonly sources: readonly ContextAttestationSource[];
  readonly author: ContextAttestationActor;
  readonly reviewer: ContextAttestationActor;
  readonly reviewedAt: string;
  readonly nexusVersion: string;
}

export type ContextAttestationDiagnosticCode =
  | 'invalid-attestation-entry'
  | 'invalid-attestation'
  | 'attestation-project-mismatch'
  | 'target-hash-mismatch'
  | 'source-hash-mismatch'
  | 'duplicate-target-attestation';

export interface ContextAttestationDiagnostic {
  readonly code: ContextAttestationDiagnosticCode;
  readonly message: string;
  readonly attestationPath?: string;
  readonly targetPath?: string;
}

export interface ContextAttestationInspection {
  readonly attestations: readonly ContextAttestation[];
  readonly diagnostics: readonly ContextAttestationDiagnostic[];
  readonly bindingHash: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertPortableRelativePath(rawPath: string, label: string): string {
  const normalized = rawPath.trim();
  if (
    normalized.length === 0 ||
    normalized.includes('\\') ||
    path.posix.isAbsolute(normalized) ||
    normalized !== path.posix.normalize(normalized)
  ) {
    throw new Error(`${label} must be a normalized portable relative path`);
  }
  const segments = normalized.split('/');
  if (
    segments.some((segment) =>
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      !PORTABLE_SEGMENT.test(segment),
    )
  ) {
    throw new Error(`${label} is not portable across supported computers`);
  }
  return normalized;
}

export function normalizeContextAuthorityTarget(rawPath: string): string {
  const targetPath = assertPortableRelativePath(rawPath, 'context target path');
  const isDocument =
    (targetPath.startsWith('.context/docs/') ||
      targetPath.startsWith('.context/decisions/')) &&
    ['.md', '.txt'].includes(path.posix.extname(targetPath).toLowerCase());
  const isStructured =
    [
      '.context/nexus/facts/',
      '.context/nexus/invariants/',
      '.context/nexus/regressions/',
    ].some((prefix) => targetPath.startsWith(prefix)) &&
    ['.json', '.yaml', '.yml'].includes(path.posix.extname(targetPath).toLowerCase());
  if (!isDocument && !isStructured) {
    throw new Error(`context target is not an attestable authority path: ${targetPath}`);
  }
  return targetPath;
}

function portableIdentity(
  projectId: string,
  raw: ContextAttestationActor,
): ContextAttestationIdentity {
  const actor = z.object({
    id: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(4_096),
    provider: z.string().trim().min(1).max(256),
  }).strict().parse(raw);
  return Object.freeze({
    id: actor.id,
    provider: actor.provider,
    sessionFingerprint: sha256(
      `${projectId}\0${actor.provider}\0${actor.sessionId}`,
    ),
  });
}

function freezeAttestation(raw: z.infer<typeof attestationSchema>): ContextAttestation {
  return Object.freeze({
    ...raw,
    sources: Object.freeze(
      raw.sources.map((source) => Object.freeze({ ...source })),
    ),
    author: Object.freeze({ ...raw.author }),
    reviewer: Object.freeze({ ...raw.reviewer }),
  });
}

export function parseContextAttestation(raw: unknown): ContextAttestation {
  const parsed = attestationSchema.parse(raw);
  const targetPath = normalizeContextAuthorityTarget(parsed.targetPath);
  const sources = normalizeContextAttestationSources(parsed.sources, targetPath);
  return freezeAttestation({ ...parsed, targetPath, sources });
}

export function normalizeContextAttestationSources(
  rawSources: readonly ContextAttestationSource[],
  targetPathInput: string,
): ContextAttestationSource[] {
  const targetPath = normalizeContextAuthorityTarget(targetPathInput);
  const sources = rawSources.map((rawSource) => {
    const source = sourceSchema.parse(rawSource);
    const locator = assertPortableRelativePath(source.locator, 'attestation source');
    if (locator === targetPath) {
      throw new Error('context target cannot attest itself as a source');
    }
    if (locator.startsWith(`${ATTESTATION_ROOT}/`)) {
      throw new Error('attestation files cannot be used as circular evidence');
    }
    if (source.type === 'connector' && !locator.startsWith('.context/nexus/evidence/')) {
      throw new Error('connector evidence must be captured under .context/nexus/evidence');
    }
    return { ...source, locator };
  }).sort((left, right) => left.locator.localeCompare(right.locator));
  if (new Set(sources.map((source) => source.locator)).size !== sources.length) {
    throw new Error('context attestation sources must be unique');
  }
  if (sources.length === 0 || sources.length > 256) {
    throw new Error('context attestation requires 1-256 sources');
  }
  return sources;
}

function readHash(scope: ProjectExecutionScope, relativePath: string): string {
  const handle = openWorkspaceFileForRead(scope, relativePath);
  try {
    if (handle.stat.size > 16 * 1024 * 1024) {
      throw new Error(`attestation source exceeds 16 MiB: ${relativePath}`);
    }
    const content = fs.readFileSync(handle.fd);
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (content.includes(0)) throw new Error(`attestation source contains NUL: ${relativePath}`);
    return sha256(content);
  } finally {
    handle.close();
  }
}

function verifyBytes(
  scope: ProjectExecutionScope,
  attestation: ContextAttestation,
): ContextAttestationDiagnostic[] {
  const diagnostics: ContextAttestationDiagnostic[] = [];
  let targetHash: string;
  try {
    targetHash = readHash(scope, attestation.targetPath);
  } catch (error) {
    diagnostics.push({
      code: 'target-hash-mismatch',
      message: `attested target is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      targetPath: attestation.targetPath,
    });
    return diagnostics;
  }
  if (targetHash !== attestation.targetHash) {
    diagnostics.push({
      code: 'target-hash-mismatch',
      message: `attested target changed after review: ${attestation.targetPath}`,
      targetPath: attestation.targetPath,
    });
  }
  for (const source of attestation.sources) {
    try {
      if (readHash(scope, source.locator) !== source.sourceHash) {
        diagnostics.push({
          code: 'source-hash-mismatch',
          message: `attestation source changed after review: ${source.locator}`,
          targetPath: attestation.targetPath,
        });
      }
    } catch (error) {
      diagnostics.push({
        code: 'source-hash-mismatch',
        message: `attestation source is unavailable: ${source.locator}: ${error instanceof Error ? error.message : String(error)}`,
        targetPath: attestation.targetPath,
      });
    }
  }
  return diagnostics;
}

export function createContextAttestation(
  scope: ProjectExecutionScope,
  input: CreateContextAttestationInput,
): ContextAttestation {
  const targetPath = normalizeContextAuthorityTarget(input.targetPath);
  const sources = normalizeContextAttestationSources(input.sources, targetPath);
  const author = portableIdentity(scope.projectId, input.author);
  const reviewer = portableIdentity(scope.projectId, input.reviewer);
  const core = {
    schemaVersion: 1 as const,
    projectId: scope.projectId,
    targetPath,
    targetHash: input.targetHash,
    sources,
    author,
    reviewer,
    reviewedAt: input.reviewedAt,
    issuerInstallationId: scope.installationId,
    nexusVersion: input.nexusVersion,
  };
  const id = `att-${sha256(canonicalJson(core)).slice(0, 40)}`;
  const attestation = parseContextAttestation({ ...core, id });
  if (attestation.projectId !== scope.projectId) {
    throw new Error('context attestation project mismatch');
  }
  const diagnostics = verifyBytes(scope, attestation);
  if (diagnostics.length > 0) throw new Error(diagnostics[0].message);
  return attestation;
}

export function contextAttestationPath(id: string): string {
  const parsed = z.string().regex(ATTESTATION_ID_PATTERN).parse(id);
  return `${ATTESTATION_ROOT}/${parsed}.json`;
}

export function writeContextAttestation(
  scope: ProjectExecutionScope,
  attestationInput: ContextAttestation,
): string {
  const attestation = parseContextAttestation(attestationInput);
  if (attestation.projectId !== scope.projectId) {
    throw new Error('context attestation belongs to another project');
  }
  const diagnostics = verifyBytes(scope, attestation);
  if (diagnostics.length > 0) throw new Error(diagnostics[0].message);
  ensureWorkspaceDirectory(scope, ATTESTATION_ROOT);
  const relative = contextAttestationPath(attestation.id);
  replaceWorkspaceTextFileAtomically(
    scope,
    relative,
    `${canonicalJson(attestation)}\n`,
  );
  return relative;
}

function diagnostic(
  code: ContextAttestationDiagnosticCode,
  message: string,
  attestationPath?: string,
  targetPath?: string,
): ContextAttestationDiagnostic {
  return Object.freeze({ code, message, attestationPath, targetPath });
}

export function inspectContextAttestations(
  scope: ProjectExecutionScope,
): ContextAttestationInspection {
  const absoluteRoot = path.join(scope.rootRealPath, ATTESTATION_ROOT);
  if (!fs.existsSync(absoluteRoot)) {
    return Object.freeze({
      attestations: Object.freeze([]),
      diagnostics: Object.freeze([]),
      bindingHash: sha256(canonicalJson({ schemaVersion: 1, files: [] })),
    });
  }
  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return Object.freeze({
      attestations: Object.freeze([]),
      diagnostics: Object.freeze([
        diagnostic('invalid-attestation-entry', 'attestation root must be a real directory'),
      ]),
      bindingHash: sha256(canonicalJson({ schemaVersion: 1, invalidRoot: true })),
    });
  }

  const entries = fs.readdirSync(absoluteRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > MAX_ATTESTATIONS) {
    throw new Error('context attestation limit exceeded');
  }
  const diagnostics: ContextAttestationDiagnostic[] = [];
  const attestations: ContextAttestation[] = [];
  const fileBindings: Array<{ path: string; hash: string }> = [];
  const candidates: Array<{
    readonly attestation: ContextAttestation;
    readonly byteDiagnostics: readonly ContextAttestationDiagnostic[];
    /** Attests bytes the target no longer has — a superseded review. */
    readonly stale: boolean;
  }> = [];
  for (const entry of entries) {
    const relative = `${ATTESTATION_ROOT}/${entry.name}`;
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
      diagnostics.push(diagnostic(
        'invalid-attestation-entry',
        `invalid context attestation entry: ${relative}`,
        relative,
      ));
      continue;
    }
    try {
      const read = readWorkspaceTextFile(scope, relative);
      if (read.size > MAX_ATTESTATION_BYTES) {
        throw new Error('attestation exceeds 1 MiB');
      }
      fileBindings.push({ path: relative, hash: sha256(read.content) });
      const attestation = parseContextAttestation(JSON.parse(read.content) as unknown);
      if (entry.name !== `${attestation.id}.json`) {
        throw new Error('attestation filename does not match its id');
      }
      if (attestation.projectId !== scope.projectId) {
        diagnostics.push(diagnostic(
          'attestation-project-mismatch',
          `attestation belongs to another project: ${relative}`,
          relative,
          attestation.targetPath,
        ));
        continue;
      }
      const byteDiagnostics = verifyBytes(scope, attestation).map((item) =>
        diagnostic(item.code, item.message, relative, item.targetPath),
      );
      candidates.push({
        attestation,
        byteDiagnostics,
        stale: byteDiagnostics.some((item) => item.code === 'target-hash-mismatch'),
      });
    } catch (error) {
      diagnostics.push(diagnostic(
        'invalid-attestation',
        `invalid context attestation ${relative}: ${error instanceof Error ? error.message : String(error)}`,
        relative,
      ));
    }
  }

  // Re-reviewing a doc writes a new attestation and leaves the previous file on
  // disk. That older file attests bytes the target no longer has, so it failed
  // target-hash-mismatch forever and permanently blocked context readiness.
  // When a sibling attestation still matches the target's current bytes, the
  // stale one is a superseded review and grants nothing — drop it silently.
  // With no matching sibling nothing is superseded, so review drift on the only
  // attestation still fails closed.
  const targetsWithCurrentReview = new Set(
    candidates
      .filter((candidate) => !candidate.stale)
      .map((candidate) => candidate.attestation.targetPath),
  );
  for (const candidate of candidates) {
    if (
      candidate.stale &&
      targetsWithCurrentReview.has(candidate.attestation.targetPath)
    ) {
      continue;
    }
    if (candidate.byteDiagnostics.length > 0) {
      diagnostics.push(...candidate.byteDiagnostics);
      continue;
    }
    attestations.push(candidate.attestation);
  }

  const duplicateTargets = new Set<string>();
  const seenTargets = new Set<string>();
  for (const attestation of attestations) {
    if (seenTargets.has(attestation.targetPath)) duplicateTargets.add(attestation.targetPath);
    seenTargets.add(attestation.targetPath);
  }
  for (const targetPath of [...duplicateTargets].sort()) {
    diagnostics.push(diagnostic(
      'duplicate-target-attestation',
      `multiple active attestations claim the same target: ${targetPath}`,
      undefined,
      targetPath,
    ));
  }
  const valid = attestations
    .filter((attestation) => !duplicateTargets.has(attestation.targetPath))
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return Object.freeze({
    attestations: Object.freeze(valid),
    diagnostics: Object.freeze(diagnostics),
    bindingHash: sha256(canonicalJson({
      schemaVersion: 1,
      files: fileBindings.sort((left, right) => left.path.localeCompare(right.path)),
      diagnostics: diagnostics.map((item) => ({
        code: item.code,
        attestationPath: item.attestationPath,
        targetPath: item.targetPath,
      })),
    })),
  });
}
