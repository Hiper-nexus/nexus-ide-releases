import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import { readWorkspaceTextFile } from '../orch/workspace-file';
import { canonicalJson } from './canonical-json';
import {
  inspectContextAttestations,
  normalizeContextAuthorityTarget,
} from './context-attestation';
import { extractDesignSystemFacts } from './designmd-ingestor-adapter';
import type {
  ContextCandidate,
  ContextClaimValue,
  ContextDiagnostic,
  ContextFact,
  ContextFactCategory,
  ContextSourceRef,
  ProjectContextCorpus,
} from './context-types';

const MAX_FILES = 1_024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{40,64}$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

const claimValueSchema: z.ZodType<ContextClaimValue> = z.union([
  z.string().max(65_536),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(4_096), z.number().finite(), z.boolean(), z.null()])).max(1_024),
]);

const authoredFactSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    statement: z.string().trim().min(1).max(65_536),
    claimKey: z.string().regex(ID_PATTERN),
    value: claimValueSchema,
    kind: z.enum(['asserted', 'observed', 'inferred', 'deprecated']).default('asserted'),
    category: z
      .enum([
        'glossary',
        'invariant',
        'decision',
        'domain',
        'architecture',
        'regression',
        'test',
      ])
      .optional(),
    domains: z.array(z.string().regex(ID_PATTERN)).max(256).default([]),
    relatedSymbols: z.array(z.string().trim().min(1).max(512)).max(2_048).default([]),
    confidence: z.number().min(0).max(1).optional(),
    validFrom: z.iso.datetime().optional(),
    validUntil: z.iso.datetime().optional(),
    commitSha: z.string().regex(HASH_PATTERN).optional(),
    supersedes: z.array(z.string().regex(ID_PATTERN)).max(256).optional(),
  })
  .strict();

const factFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    facts: z.array(authoredFactSchema).min(1).max(2_048),
  })
  .strict();

const DOCUMENT_ROOTS = [
  '.context/docs',
  '.context/decisions',
  '.context/plans',
  '.context/agents',
  '.context/skills',
] as const;
const ROOT_DOCUMENTS = ['AGENTS.md', 'CLAUDE.md', 'DESIGN.md', 'GEMINI.md'] as const;
const STRUCTURED_ROOTS: ReadonlyArray<{
  root: string;
  category: ContextFactCategory;
}> = [
  { root: '.context/nexus/facts', category: 'domain' },
  { root: '.context/nexus/invariants', category: 'invariant' },
  { root: '.context/nexus/regressions', category: 'regression' },
];

export function validateContextAuthorityContent(
  targetPathInput: string,
  content: string,
): void {
  const targetPath = normalizeContextAuthorityTarget(targetPathInput);
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES || content.includes('\0')) {
    throw new Error('context authority content must be text smaller than 1 MiB');
  }
  const extension = path.posix.extname(targetPath).toLowerCase();
  if (extension === '.md' || extension === '.txt') {
    if (content.trim().length === 0) throw new Error('context document cannot be empty');
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error('structured context must use strict JSON/YAML-JSON syntax', { cause: error });
  }
  const parsed = factFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid structured context: ${parsed.error.message}`);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function exists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertSafeDirectory(root: string, relative: string): string {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`symbolic link is not allowed in context path: ${relative}`);
  }
  if (!stat.isDirectory()) throw new Error(`context path is not a directory: ${relative}`);
  const real = fs.realpathSync(absolute);
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`context directory escapes project: ${relative}`);
  }
  return real;
}

function walkFiles(
  root: string,
  relativeRoot: string,
  extensions: ReadonlySet<string>,
  maxDepth = 6,
): string[] {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!exists(absoluteRoot)) return [];
  assertSafeDirectory(root, relativeRoot);
  const output: string[] = [];

  function visit(relative: string, depth: number): void {
    if (depth > maxDepth) throw new Error(`context tree is too deep: ${relative}`);
    assertSafeDirectory(root, relative);
    const entries = fs
      .readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic link is not allowed in context path: ${child}`);
      }
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        output.push(child);
        if (output.length > MAX_FILES) throw new Error('context file limit exceeded');
      } else if (!entry.isFile()) {
        throw new Error(`non-regular context entry is not allowed: ${child}`);
      }
    }
  }

  visit(relativeRoot, 0);
  return output;
}

function sourceFor(relative: string): ContextSourceRef {
  return Object.freeze({
    type: relative.startsWith('.context/decisions/') ? 'decision' : 'file',
    locator: relative,
  });
}

function authorityRank(relative: string): number {
  if (relative.startsWith('.context/decisions/')) return 1;
  if (relative.startsWith('.context/docs/')) return 3;
  if (relative === 'AGENTS.md') return 3;
  return 4;
}

function inferredDomains(relative: string): readonly string[] {
  const name = path.basename(relative, path.extname(relative)).toLowerCase();
  const generic = new Set([
    'project-overview',
    'business-model',
    'domain-glossary',
    'architecture',
    'testing',
    'agents',
    'claude',
    'gemini',
  ]);
  return generic.has(name) ? Object.freeze([]) : Object.freeze([name]);
}

interface ReadBudget {
  files: number;
  bytes: number;
}

function readBounded(
  scope: ProjectExecutionScope,
  relative: string,
  budget: ReadBudget,
): { content: string; hash: string } {
  const read = readWorkspaceTextFile(scope, relative);
  if (read.size > MAX_FILE_BYTES) throw new Error(`context file is too large: ${relative}`);
  budget.files += 1;
  budget.bytes += read.size;
  if (budget.files > MAX_FILES || budget.bytes > MAX_TOTAL_BYTES) {
    throw new Error('context corpus size limit exceeded');
  }
  return { content: read.content, hash: sha256(read.content) };
}

function freezeFact(fact: ContextFact): ContextFact {
  return Object.freeze({
    ...fact,
    source: Object.freeze({ ...fact.source }),
    domains: Object.freeze([...fact.domains]),
    relatedSymbols: Object.freeze([...fact.relatedSymbols]),
    supersedes: fact.supersedes ? Object.freeze([...fact.supersedes]) : undefined,
    value: Array.isArray(fact.value) ? Object.freeze([...fact.value]) : fact.value,
  });
}

export interface ContextIngestOptions {
  /** Strict v1 accepts JSON documents; `.yaml` may contain JSON (valid YAML 1.2). */
  structuredExtensions?: readonly string[];
}

export function ingestProjectContext(
  scope: ProjectExecutionScope,
  options: ContextIngestOptions = {},
): ProjectContextCorpus {
  const root = fs.realpathSync(scope.rootRealPath);
  const budget: ReadBudget = { files: 0, bytes: 0 };
  const candidates: ContextCandidate[] = [];
  const facts: ContextFact[] = [];
  const diagnostics: ContextDiagnostic[] = [];
  const sourceBindings: Array<{ locator: string; hash: string }> = [];
  const attestationInspection = inspectContextAttestations(scope);
  sourceBindings.push({
    locator: '.context/nexus/attestations',
    hash: attestationInspection.bindingHash,
  });
  diagnostics.push(...attestationInspection.diagnostics.map((item) => Object.freeze({
    severity: 'error' as const,
    code: `attestation:${item.code}`,
    source: item.attestationPath
      ? Object.freeze({ type: 'file' as const, locator: item.attestationPath })
      : undefined,
    message: item.message,
  })));

  const documents = [
    ...ROOT_DOCUMENTS.filter((relative) => exists(path.join(root, relative))),
    ...DOCUMENT_ROOTS.flatMap((relative) =>
      walkFiles(root, relative, new Set(['.md', '.txt'])),
    ),
  ].sort((left, right) => left.localeCompare(right));
  for (const relative of documents) {
    const { content, hash } = readBounded(scope, relative, budget);
    const source = sourceFor(relative);
    sourceBindings.push({ locator: relative, hash });
    candidates.push(
      Object.freeze({
        id: `candidate:${sha256(`${relative}\0${hash}`).slice(0, 32)}`,
        projectId: scope.projectId,
        producerId: `source:${sha256(relative).slice(0, 24)}`,
        statement: content,
        source,
        sourceHash: hash,
        authorityRank: authorityRank(relative),
        domains: inferredDomains(relative),
        status: 'candidate',
      }),
    );
    const documentBaseName = path.basename(relative, path.extname(relative)).toLowerCase();
    if (documentBaseName === 'design' || documentBaseName === 'design-system') {
      const designFacts = extractDesignSystemFacts(content, source, hash).map((fact) => ({
        ...fact,
        projectId: scope.projectId,
      }));
      facts.push(...designFacts.map(freezeFact));
    }
  }

  const structuredExtensions = new Set(
    (options.structuredExtensions ?? ['.json', '.yaml', '.yml']).map((ext) =>
      ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
    ),
  );
  for (const definition of STRUCTURED_ROOTS) {
    const files = walkFiles(root, definition.root, structuredExtensions);
    for (const relative of files) {
      const { content, hash } = readBounded(scope, relative, budget);
      sourceBindings.push({ locator: relative, hash });
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch (error) {
        throw new Error(
          `structured context must use strict JSON/YAML-JSON syntax: ${relative}`,
          { cause: error },
        );
      }
      const parsed = factFileSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`invalid structured context ${relative}: ${parsed.error.message}`);
      }
      const source = sourceFor(relative);
      for (const authored of parsed.data.facts) {
        facts.push(
          freezeFact({
            id: authored.id,
            projectId: scope.projectId,
            statement: authored.statement,
            claimKey: authored.claimKey,
            value: authored.value,
            kind: authored.kind,
            category: authored.category ?? definition.category,
            source,
            sourceHash: hash,
            commitSha: authored.commitSha,
            domains: sortedUnique(authored.domains),
            relatedSymbols: sortedUnique(authored.relatedSymbols),
            confidence:
              authored.confidence ?? (authored.kind === 'inferred' ? 0.5 : 1),
            validFrom: authored.validFrom ?? '1970-01-01T00:00:00.000Z',
            validUntil: authored.validUntil,
            supersedes: authored.supersedes
              ? sortedUnique(authored.supersedes)
              : undefined,
          }),
        );
      }
    }
  }

  const duplicateFact = facts.find(
    (fact, index) => facts.findIndex((candidate) => candidate.id === fact.id) !== index,
  );
  if (duplicateFact) throw new Error(`duplicate context fact id: ${duplicateFact.id}`);
  const contextRevision = sha256(
    canonicalJson({
      schemaVersion: 1,
      projectId: scope.projectId,
      sources: sourceBindings.sort((a, b) => a.locator.localeCompare(b.locator)),
    }),
  );

  return Object.freeze({
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    contextRevision,
    candidates: Object.freeze([...candidates]),
    facts: Object.freeze([...facts]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}
