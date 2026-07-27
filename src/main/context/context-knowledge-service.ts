import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  openWorkspaceFileForRead,
  removeWorkspaceFile,
  replaceWorkspaceTextFileAtomically,
} from '../orch/workspace-file';
import type { ScopedStoreOptions } from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  ProcessGitRunner,
  assertSafeLocalGitConfig,
  type GitRunner,
} from '../runtime/git-command';
import {
  contextAttestationPath,
  createContextAttestation,
  inspectContextAttestations,
  parseContextAttestation,
  writeContextAttestation,
  type ContextAttestation,
  type ContextAttestationActor,
  type ContextAttestationSource,
} from './context-attestation';
import {
  ContextDraftStore,
  type ContextDraftRecord,
  type ContextDraftStatus,
} from './context-draft-store';
import { validateContextAuthorityContent } from './context-ingestor';
import {
  BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET,
  inspectContextReadiness,
  isExactBundledDesignSystemSensor,
} from './context-doctor';
import { buildProjectSymbolIndex } from './symbol-index';

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;

export interface ContextKnowledgeServiceOptions extends ScopedStoreOptions {
  readonly appVersion: string;
  readonly gitRunner?: GitRunner;
}

/**
 * Fonte proposta pelo agente. sourceHash é opcional: agentes hospedados não
 * têm tool de hash, então o Nexus computa o sha256 do arquivo do workspace no
 * propose — o binding continua exato (verifySources re-verifica sempre a
 * partir do disco em review/apply). Quando o agente FORNECE o hash, ele é
 * tratado como afirmação de conteúdo exato e divergência rejeita a proposta.
 */
export interface ProposedContextSource {
  readonly type: ContextAttestationSource['type'];
  readonly locator: string;
  readonly sourceHash?: string;
}

export interface ProposeKnowledgeDraftInput {
  readonly missionId?: string | null;
  readonly targetPath: string;
  readonly content: string;
  /**
   * CAS opcional do alvo: string = hash exato esperado; null = o alvo não
   * pode existir; omitido = vincular ao estado ATUAL do alvo (agentes não
   * conseguem computar hashes — o Nexus observa e registra o binding).
   */
  readonly expectedTargetHash?: string | null;
  readonly sources: readonly ProposedContextSource[];
}

export interface ReviewKnowledgeDraftInput {
  readonly decision: 'approve' | 'reject';
  readonly reviewer: ContextAttestationActor;
  readonly rationale: string;
}

export interface AppliedKnowledgeDraft {
  readonly draft: ContextDraftRecord;
  readonly attestation: ContextAttestation;
  readonly attestationPath: string;
  readonly replacedAttestationPaths: readonly string[];
}

export interface CommittedKnowledgeDrafts {
  readonly commitSha: string;
  readonly drafts: readonly ContextDraftRecord[];
  readonly recovered: boolean;
}

interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
}

function hashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function workspaceFileHash(
  scope: ProjectExecutionScope,
  relativePath: string,
): { hash: string; size: number } {
  const handle = openWorkspaceFileForRead(scope, relativePath);
  try {
    if (handle.stat.size > MAX_SOURCE_BYTES) {
      throw new Error(`context evidence source exceeds 16 MiB: ${relativePath}`);
    }
    const content = fs.readFileSync(handle.fd);
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (content.includes(0)) {
      throw new Error(`context evidence source contains NUL: ${relativePath}`);
    }
    return { hash: hashBuffer(content), size: content.byteLength };
  } finally {
    handle.close();
  }
}

function workspaceFileHashOrNull(
  scope: ProjectExecutionScope,
  relativePath: string,
): string | null {
  try {
    return workspaceFileHash(scope, relativePath).hash;
  } catch (error) {
    if (error instanceof Error && /file not found:/i.test(error.message)) return null;
    throw error;
  }
}

function verifySources(
  scope: ProjectExecutionScope,
  sources: readonly ContextAttestationSource[],
): void {
  let totalBytes = 0;
  for (const source of sources) {
    const observed = workspaceFileHash(scope, source.locator);
    totalBytes += observed.size;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      throw new Error('context evidence sources exceed the 64 MiB total budget');
    }
    if (observed.hash !== source.sourceHash) {
      throw new Error(`context source hash changed or is false: ${source.locator}`);
    }
  }
}

function splitNullRecords(raw: string): string[] {
  const records = raw.split('\0');
  if (records.at(-1) === '') records.pop();
  return records;
}

function parseGitStatus(raw: string): readonly GitStatusEntry[] {
  const records = splitNullRecords(raw);
  const output: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('Git returned malformed porcelain status');
    }
    const status = record.slice(0, 2);
    if (/[RC]/.test(status)) {
      // Porcelain -z emits a second path for renames/copies. Context authority
      // never accepts these ambiguous transitions in an automated commit.
      index += 1;
      throw new Error('context commit does not accept renames or copies');
    }
    const filePath = record.slice(3);
    if (!filePath.startsWith('.context/') || filePath.includes('\0')) {
      throw new Error(`Git returned an invalid context path: ${filePath}`);
    }
    output.push(Object.freeze({ status, path: filePath }));
  }
  return Object.freeze(output);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function assertTargetHash(
  scope: ProjectExecutionScope,
  draft: Pick<ContextDraftRecord, 'targetPath' | 'expectedTargetHash' | 'contentHash'>,
  allowAlreadyApplied: boolean,
): 'expected' | 'applied' {
  const current = workspaceFileHashOrNull(scope, draft.targetPath);
  if (current === draft.expectedTargetHash) return 'expected';
  if (allowAlreadyApplied && current === draft.contentHash) return 'applied';
  throw new Error(`context target changed since proposal: ${draft.targetPath}`);
}

export class ContextKnowledgeService {
  readonly scope: ProjectExecutionScope;
  readonly #store: ContextDraftStore;
  readonly #appVersion: string;
  readonly #git: GitRunner;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ContextKnowledgeServiceOptions,
  ) {
    const appVersion = options.appVersion.trim();
    if (!appVersion || appVersion.length > 64) {
      throw new Error('context knowledge appVersion is required');
    }
    this.scope = Object.freeze({ ...scope });
    this.#appVersion = appVersion;
    this.#git = options.gitRunner ?? new ProcessGitRunner();
    this.#store = new ContextDraftStore(runtimeManager, this.scope, options);
  }

  get(id: string): ContextDraftRecord | null {
    return this.#store.get(id);
  }

  list(options: { status?: ContextDraftStatus; missionId?: string | null } = {}): readonly ContextDraftRecord[] {
    return this.#store.list(options);
  }

  /** Draft ativo (proposed/approved) que ocupa o target, cross-mission. */
  activeForTarget(targetPath: string): ContextDraftRecord | null {
    return this.#store.activeForTarget(targetPath);
  }

  /** Libera o wedge de draft-fantasma: supera o draft ativo do target. */
  supersedeActiveForTarget(targetPath: string): ContextDraftRecord | null {
    return this.#store.supersedeActiveForTarget(targetPath);
  }

  propose(
    input: ProposeKnowledgeDraftInput,
    author: ContextAttestationActor,
  ): ContextDraftRecord {
    validateContextAuthorityContent(input.targetPath, input.content);
    const sources: ContextAttestationSource[] = input.sources.map((source) =>
      source.sourceHash !== undefined
        ? { type: source.type, locator: source.locator, sourceHash: source.sourceHash }
        : {
            type: source.type,
            locator: source.locator,
            sourceHash: workspaceFileHash(this.scope, source.locator).hash,
          },
    );
    verifySources(this.scope, sources);
    const actualTargetHash = workspaceFileHashOrNull(this.scope, input.targetPath);
    if (
      input.expectedTargetHash !== undefined &&
      actualTargetHash !== input.expectedTargetHash
    ) {
      throw new Error(`context target changed before proposal: ${input.targetPath}`);
    }
    return this.#store.propose({
      missionId: input.missionId,
      targetPath: input.targetPath,
      content: input.content,
      expectedTargetHash: actualTargetHash,
      sources,
      author,
    });
  }

  review(id: string, input: ReviewKnowledgeDraftInput): ContextDraftRecord {
    const draft = this.#store.get(id);
    if (!draft) throw new Error('context draft not found');
    if (input.decision === 'approve') {
      validateContextAuthorityContent(draft.targetPath, draft.content);
      verifySources(this.scope, draft.sources);
      assertTargetHash(this.scope, draft, false);
    }
    return this.#store.review(id, input);
  }

  apply(id: string): AppliedKnowledgeDraft {
    const current = this.#store.get(id);
    if (!current) throw new Error('context draft not found');
    if (current.status === 'applied') return this.#readApplied(current);
    if (current.status !== 'approved' || !current.reviewer || current.reviewedAt === null) {
      throw new Error('only an independently approved context draft can be applied');
    }
    validateContextAuthorityContent(current.targetPath, current.content);
    verifySources(this.scope, current.sources);
    const targetState = assertTargetHash(this.scope, current, true);

    const inspection = inspectContextAttestations(this.scope);
    const recoverableDiagnostics = inspection.diagnostics.filter(
      (item) =>
        item.targetPath === current.targetPath &&
        item.code === 'target-hash-mismatch' &&
        item.attestationPath,
    );
    const blockers = inspection.diagnostics.filter(
      (item) => !recoverableDiagnostics.includes(item),
    );
    if (blockers.length > 0) {
      throw new Error(`context attestation tree is not ready: ${blockers[0].message}`);
    }

    const oldPaths = new Set<string>();
    for (const attestation of inspection.attestations) {
      if (attestation.targetPath === current.targetPath) {
        oldPaths.add(contextAttestationPath(attestation.id));
      }
    }
    for (const item of recoverableDiagnostics) {
      if (item.attestationPath) oldPaths.add(item.attestationPath);
    }
    for (const oldPath of oldPaths) {
      removeWorkspaceFile(this.scope, oldPath, { missingOk: true });
    }

    if (targetState === 'expected') {
      replaceWorkspaceTextFileAtomically(this.scope, current.targetPath, current.content);
    }
    const attestation = createContextAttestation(this.scope, {
      targetPath: current.targetPath,
      targetHash: current.contentHash,
      sources: current.sources,
      author: current.author,
      reviewer: current.reviewer,
      reviewedAt: new Date(current.reviewedAt).toISOString(),
      nexusVersion: this.#appVersion,
    });
    const attestationPath = writeContextAttestation(this.scope, attestation);
    const applied = this.#store.markApplied(id, attestation.id);
    return Object.freeze({
      draft: applied,
      attestation,
      attestationPath,
      replacedAttestationPaths: Object.freeze([...oldPaths].sort()),
    });
  }

  commitApplied(): CommittedKnowledgeDrafts {
    let pending = this.#store.list({ status: 'applied' })
      .filter((draft) => draft.appliedCommit === null);
    if (pending.length === 0) throw new Error('no applied context drafts are waiting for commit');

    this.#repairLegacySupersededDrafts(pending);
    pending = this.#store.list({ status: 'applied' })
      .filter((draft) => draft.appliedCommit === null);
    if (pending.length === 0) {
      throw new Error('no current applied context drafts are waiting for commit');
    }

    const readiness = inspectContextReadiness(this.scope, {
      knownSymbols: buildProjectSymbolIndex(this.scope).symbols,
    });
    if (!readiness.ready) {
      throw new Error(
        `context commit requires a ready corpus: ${readiness.blockers.map((item) => item.code).join(', ')}`,
      );
    }
    const inspection = inspectContextAttestations(this.scope);
    if (inspection.diagnostics.length > 0) {
      throw new Error(`context commit has invalid attestations: ${inspection.diagnostics[0].message}`);
    }
    const attestations = new Map(
      inspection.attestations.map((attestation) => [attestation.id, attestation]),
    );
    for (const draft of pending) {
      if (!draft.attestationId) throw new Error(`applied draft has no attestation: ${draft.id}`);
      const attestation = attestations.get(draft.attestationId);
      if (
        !attestation ||
        attestation.targetPath !== draft.targetPath ||
        attestation.targetHash !== draft.contentHash
      ) {
        throw new Error(`applied draft attestation does not bind its content: ${draft.id}`);
      }
      if (workspaceFileHashOrNull(this.scope, draft.targetPath) !== draft.contentHash) {
        throw new Error(`applied context target changed before commit: ${draft.targetPath}`);
      }
    }

    assertSafeLocalGitConfig(this.#git, this.scope.rootRealPath);
    this.#assertSourcesCommitted(pending);
    const stagedBefore = splitNullRecords(
      this.#git.run(this.scope.rootRealPath, ['diff', '--cached', '--name-only', '-z']).stdout,
    );
    if (stagedBefore.length > 0) {
      throw new Error('context commit refuses a repository with pre-staged changes');
    }

    const status = parseGitStatus(this.#git.run(this.scope.rootRealPath, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.context',
    ]).stdout);
    if (status.length === 0) return this.#recoverCommitted(pending);

    const targetPaths = new Set(pending.map((draft) => draft.targetPath));
    const allowed = new Set<string>([
      '.context/config/policy.json',
      '.context/config/sensors.json',
      ...pending.map((draft) => draft.targetPath),
      ...pending.map((draft) => contextAttestationPath(draft.attestationId as string)),
    ]);
    for (const entry of status) {
      if (allowed.has(entry.path)) continue;
      if (
        entry.path === BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET &&
        isExactBundledDesignSystemSensor(this.scope)
      ) {
        allowed.add(entry.path);
        continue;
      }
      if (
        entry.status.includes('D') &&
        entry.path.startsWith('.context/nexus/attestations/') &&
        this.#isDeletedAttestationFor(entry.path, targetPaths)
      ) {
        allowed.add(entry.path);
        continue;
      }
      throw new Error(`unexpected context change blocks commit: ${entry.path}`);
    }
    const changedPaths = [...new Set(status.map((entry) => entry.path))].sort();
    this.#git.run(this.scope.rootRealPath, ['add', '--', ...changedPaths]);
    const staged = splitNullRecords(this.#git.run(this.scope.rootRealPath, [
      'diff', '--cached', '--name-only', '-z', '--', '.context',
    ]).stdout).sort();
    if (!sameStrings(staged, changedPaths)) {
      throw new Error('context staging did not bind the exact reviewed path set');
    }

    this.#git.run(
      this.scope.rootRealPath,
      [
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        'docs(context): apply independently reviewed project context',
        '--',
        ...changedPaths,
      ],
      {
        env: {
          GIT_AUTHOR_NAME: 'Nexus Context',
          GIT_AUTHOR_EMAIL: 'nexus-context@local.invalid',
          GIT_COMMITTER_NAME: 'Nexus Context',
          GIT_COMMITTER_EMAIL: 'nexus-context@local.invalid',
        },
      },
    );
    const commitSha = this.#git.run(
      this.scope.rootRealPath,
      ['rev-parse', '--verify', 'HEAD'],
    ).stdout.trim();
    const committed = pending.map((draft) => this.#store.markCommitted(draft.id, commitSha));
    return Object.freeze({
      commitSha,
      drafts: Object.freeze(committed),
      recovered: false,
    });
  }

  #readApplied(draft: ContextDraftRecord): AppliedKnowledgeDraft {
    if (!draft.attestationId) throw new Error('applied draft is missing its attestation id');
    const inspection = inspectContextAttestations(this.scope);
    if (inspection.diagnostics.length > 0) {
      throw new Error(`applied context attestation is invalid: ${inspection.diagnostics[0].message}`);
    }
    const attestation = inspection.attestations.find(
      (candidate) => candidate.id === draft.attestationId,
    );
    if (!attestation) throw new Error('applied context attestation is missing');
    return Object.freeze({
      draft,
      attestation,
      attestationPath: contextAttestationPath(attestation.id),
      replacedAttestationPaths: Object.freeze([]),
    });
  }

  #repairLegacySupersededDrafts(
    pending: readonly ContextDraftRecord[],
  ): void {
    const inspection = inspectContextAttestations(this.scope);
    if (inspection.diagnostics.length > 0) return;
    const currentByTarget = new Map(
      inspection.attestations.map((attestation) => [attestation.targetPath, attestation]),
    );
    for (const draft of pending) {
      const current = currentByTarget.get(draft.targetPath);
      if (!current || current.id === draft.attestationId) continue;
      if (workspaceFileHashOrNull(this.scope, draft.targetPath) !== current.targetHash) continue;
      this.#store.markSuperseded(draft.id);
    }
  }

  #assertSourcesCommitted(drafts: readonly ContextDraftRecord[]): void {
    const seen = new Set<string>();
    for (const source of drafts.flatMap((draft) => draft.sources)) {
      const key = `${source.locator}\0${source.sourceHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = this.#git.run(
        this.scope.rootRealPath,
        ['show', `HEAD:${source.locator}`],
        { allowFailure: true },
      );
      if (result.status !== 0 || createHash('sha256').update(result.stdout).digest('hex') !== source.sourceHash) {
        throw new Error(
          `context source is not committed at the attested hash: ${source.locator}`,
        );
      }
    }
  }

  #isDeletedAttestationFor(
    attestationPath: string,
    targetPaths: ReadonlySet<string>,
  ): boolean {
    const result = this.#git.run(
      this.scope.rootRealPath,
      ['show', `HEAD:${attestationPath}`],
      { allowFailure: true },
    );
    if (result.status !== 0) return false;
    try {
      const attestation = parseContextAttestation(JSON.parse(result.stdout) as unknown);
      return contextAttestationPath(attestation.id) === attestationPath &&
        targetPaths.has(attestation.targetPath);
    } catch {
      return false;
    }
  }

  #recoverCommitted(pending: readonly ContextDraftRecord[]): CommittedKnowledgeDrafts {
    const headResult = this.#git.run(
      this.scope.rootRealPath,
      ['rev-parse', '--verify', 'HEAD'],
      { allowFailure: true },
    );
    if (headResult.status !== 0) {
      throw new Error('context files are unchanged but no Git commit can be recovered');
    }
    const commitSha = headResult.stdout.trim();
    for (const draft of pending) {
      if (!draft.attestationId) throw new Error('applied context draft has no attestation');
      const target = this.#git.run(
        this.scope.rootRealPath,
        ['show', `HEAD:${draft.targetPath}`],
        { allowFailure: true },
      );
      const sidecar = this.#git.run(
        this.scope.rootRealPath,
        ['show', `HEAD:${contextAttestationPath(draft.attestationId)}`],
        { allowFailure: true },
      );
      if (
        target.status !== 0 ||
        sidecar.status !== 0 ||
        createHash('sha256').update(target.stdout).digest('hex') !== draft.contentHash
      ) {
        throw new Error('context commit has no changes and cannot prove prior commit completion');
      }
      const parsed = parseContextAttestation(JSON.parse(sidecar.stdout) as unknown);
      if (parsed.id !== draft.attestationId || parsed.targetHash !== draft.contentHash) {
        throw new Error('recovered context commit attestation does not match the applied draft');
      }
    }
    const committed = pending.map((draft) => this.#store.markCommitted(draft.id, commitSha));
    return Object.freeze({
      commitSha,
      drafts: Object.freeze(committed),
      recovered: true,
    });
  }
}
