// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: Effect-TS → async com o AsyncGitRunner do Main; ref refs/nexus-checkpoint/<32 hex>/ordinal/<n>; índice privado em tmp; parent = HEAD; restauração só explícita, sem tocar índice/HEAD e com backup antes; sem porte do miolo sparse.

/**
 * ORC-03 — checkpoint da árvore de trabalho (suja) em ref Git oculta.
 *
 * Origem: CheckpointService.checkpointRefForScopeOrdinal (ref por escopo +
 * ordinal), CheckpointStore e a sequência capture/restore do GitVcsDriver do
 * T3 Code. No Nexus:
 *  - A captura NUNCA move HEAD, nunca cria refs/heads e nunca escreve o índice
 *    real: copia o índice (cache de stat) para um índice privado do Nexus em
 *    tmp (o envelope `privateIndexFile` do GitRunner), `add -A` (inclui
 *    untracked, respeita .gitignore), `write-tree`, `commit-tree` com
 *    identidade fixa do Nexus e parent = HEAD, `update-ref` durável.
 *  - Oid vazio nunca é publicado; ref de 0 byte (rename sem fsync antes de um
 *    desligamento sujo) é ignorada e apagada na captura e na listagem.
 *  - A restauração só roda por comando explícito: escreve os arquivos da
 *    árvore do checkpoint via índice privado + `checkout-index`, depois de
 *    guardar o estado atual como checkpoint novo. Não apaga arquivo ausente
 *    do checkpoint, não toca índice real, HEAD nem branch.
 *  - Falhas voltam como `{ ok: false, reason }` (o TaggedError do upstream).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AsyncProcessGitRunner,
  assertSafeLocalGitConfigAsync,
  GitCommandError,
  type AsyncGitRunner,
  type GitRunOptions,
} from '../runtime/git-command';

export const CHECKPOINT_REF_PREFIX = 'refs/nexus-checkpoint';
export const CHECKPOINT_REF_PATTERN = /^refs\/nexus-checkpoint\/([0-9a-f]{32})\/ordinal\/(0|[1-9][0-9]{0,8})$/;
const ORDINAL_NAME = /^(0|[1-9][0-9]{0,8})$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Autor/committer fixos: o checkpoint não usa user.name/email do operador. */
const CHECKPOINT_IDENTITY: NonNullable<GitRunOptions['env']> = Object.freeze({
  GIT_AUTHOR_NAME: 'Nexus (checkpoint)',
  GIT_AUTHOR_EMAIL: 'checkpoint@nexus.invalid',
  GIT_COMMITTER_NAME: 'Nexus (checkpoint)',
  GIT_COMMITTER_EMAIL: 'checkpoint@nexus.invalid',
});

// Git renames loose objects and refs into place without fsync by default, so
// an unclean restart can leave 0-byte files under refs/nexus-checkpoint/** that
// break every later fetch and push. Checkpoint writes flush before they are
// published; macOS defaults to writeout-only, which does not reach the disk.
const DURABLE_WRITE = ['-c', 'core.fsync=objects,reference', '-c', 'core.fsyncMethod=fsync'] as const;
const INDEX_CONFIG = ['-c', 'core.fsmonitor=false'] as const;
const STAGE_TIMEOUT_MS = 120_000;
const MAX_NESTED_REPO_RETRIES = 16;
const CHECKOUT_CHUNK = 200;

export interface CheckpointFailure {
  readonly ok: false;
  readonly reason: string;
}

export interface CheckpointCaptureSuccess {
  readonly ok: true;
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  readonly ordinal: number;
  /** HEAD no momento da captura (parent do commit); null em repo sem commit. */
  readonly baseSha: string | null;
  /** O ordinal já guardava esta mesma árvore sobre o mesmo HEAD: nada reescrito. */
  readonly reused: boolean;
}

export type CheckpointCaptureResult = CheckpointCaptureSuccess | CheckpointFailure;

export interface CheckpointCaptureInput {
  /** Raiz da worktree (toplevel) a fotografar. */
  readonly cwd: string;
  /** Identidade do escopo; só o sha256 dela entra no nome da ref. */
  readonly scopeId: string;
  /** Ordinal explícito (idempotente) ou, ausente, o próximo do escopo. */
  readonly ordinal?: number;
  /** Linhas extras da mensagem do commit (metadado, nunca autoridade). */
  readonly note?: readonly string[];
  /** Raiz que nunca é fotografada nem escrita (a de coordenação). */
  readonly forbiddenRoot?: string;
  /** Prazo global (epoch ms): estourado, para e devolve `timeout` sem publicar ref. */
  readonly deadlineAt?: number;
  /**
   * Quem pediu desistiu (F-1018): o `update-ref` em curso não é morto, mas a
   * ref que ele publicar depois disso é desfeita e a resposta é `timeout`.
   */
  readonly signal?: AbortSignal;
}

export interface CheckpointEntry {
  readonly ref: string;
  readonly ordinal: number;
  readonly commit: string;
  readonly createdAt: number;
  readonly subject: string;
}

export type CheckpointListResult =
  | {
      readonly ok: true;
      readonly checkpoints: readonly CheckpointEntry[];
      /** Refs de 0 byte encontradas e apagadas nesta listagem. */
      readonly removedEmptyRefs: readonly string[];
    }
  | CheckpointFailure;

export interface CheckpointRestorePlan {
  /** Existem no disco e serão sobrescritos pelo conteúdo do checkpoint. */
  readonly overwrite: readonly string[];
  /** Não existem no disco e serão criados. */
  readonly create: readonly string[];
  /** Existem agora e não estão no checkpoint: ficam como estão. */
  readonly keptExtra: readonly string[];
  /** Diretório ou arquivo no caminho: não escritos (nada é apagado). */
  readonly conflicts: readonly string[];
}

export type CheckpointRestoreResult =
  | (CheckpointRestorePlan & {
      readonly ok: true;
      readonly ref: string;
      readonly commit: string;
      readonly applied: boolean;
      /** Estado anterior guardado antes de escrever (só quando aplicou algo). */
      readonly backup: CheckpointCaptureSuccess | null;
    })
  | CheckpointFailure;

export interface CheckpointRestoreInput {
  readonly cwd: string;
  readonly scopeId: string;
  readonly ref: string;
  /** false = só a prévia do que seria sobrescrito/criado. */
  readonly apply: boolean;
  /** Raiz que nunca é escrita (a de coordenação), comparada por identidade no disco. */
  readonly forbiddenRoot?: string;
  /**
   * Recebe TODOS os destinos (relativos à raiz) antes de qualquer escrita e
   * lança para recusar (guardas de .context, .agents/.codex e workspace).
   */
  readonly assertTargets?: (targets: readonly string[]) => void;
  /**
   * Revalida a autoridade do chamador antes do backup, depois dele e logo
   * antes de cada checkout-index; lançar cancela a restauração.
   */
  readonly assertCanWrite?: () => void;
}

export interface HiddenCheckpointDeps {
  readonly git?: AsyncGitRunner;
}

function fail(reason: string): CheckpointFailure {
  return { ok: false, reason };
}

/** CheckpointService.checkpointRefForScopeOrdinal: 32 hex do sha256 do escopo. */
export function checkpointScopeKey(scopeId: string): string {
  return createHash('sha256').update(scopeId, 'utf8').digest('hex').slice(0, 32);
}

function isOrdinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999;
}

export function checkpointRefForScopeOrdinal(scopeId: string, ordinal: number): string {
  if (!isOrdinal(ordinal)) throw new Error(`invalid checkpoint ordinal: ${ordinal}`);
  return `${CHECKPOINT_REF_PREFIX}/${checkpointScopeKey(scopeId)}/ordinal/${ordinal}`;
}

export function parseCheckpointRef(ref: string): { readonly scopeKey: string; readonly ordinal: number } | null {
  const match = CHECKPOINT_REF_PATTERN.exec(ref);
  return match ? { scopeKey: match[1], ordinal: Number(match[2]) } : null;
}

/** Recusa do chamador (guardas/autoridade): propaga como exceção, nunca vira `{ ok: false }`. */
class CallerRefusal extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
  }
}

class CheckpointTimeout extends Error {
  constructor() {
    super('timeout');
  }
}

/**
 * Prazo global da captura: cada chamada Git herda só o tempo que resta. Um
 * `update-ref` já iniciado não é morto no meio (deixaria `.lock` na ref): o
 * prazo é conferido antes dele.
 */
function withDeadline(git: AsyncGitRunner, deadlineAt: number | undefined): AsyncGitRunner {
  if (deadlineAt === undefined) return git;
  return {
    run: (cwd, args, options = {}) => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return Promise.reject(new CheckpointTimeout());
      if (args.includes('update-ref')) return git.run(cwd, args, options);
      return git.run(cwd, args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30_000, remaining) });
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof GitCommandError) {
    const detail = error.stderr.trim().split('\n').find(Boolean);
    return detail ? `${error.message}: ${detail}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const serialByRoot = new Map<string, Promise<unknown>>();

/** Captura e restauração da mesma árvore não se cruzam (handoffs simultâneos). */
function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = serialByRoot.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(() => undefined, () => undefined);
  serialByRoot.set(key, settled);
  void settled.then(() => {
    if (serialByRoot.get(key) === settled) serialByRoot.delete(key);
  });
  return next;
}

interface DiskIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface Repo {
  readonly ok: true;
  readonly root: string;
  readonly commonDir: string;
  /** Identidade no disco da raiz selada, conferida de novo antes de cada mutação. */
  readonly identity: DiskIdentity;
  readonly forbidden: DiskIdentity | null;
}

async function diskIdentity(target: string): Promise<DiskIdentity | null> {
  const stat = await fs.promises.stat(target).catch(() => null);
  return stat ? { dev: stat.dev, ino: stat.ino } : null;
}

function sameIdentity(left: DiskIdentity | null, right: DiskIdentity | null): boolean {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

/**
 * Raiz selada: o caminho autorizado precisa SER o caminho real (nenhum
 * componente trocado por symlink), um diretório, e nunca a raiz proibida —
 * nem pelo inode nem pela identidade Git (mesmo git-dir).
 */
async function resolveRepo(
  git: AsyncGitRunner,
  cwd: string,
  options: { readonly refuseSparse: boolean; readonly forbiddenRoot?: string },
): Promise<Repo | CheckpointFailure> {
  const sealed = path.resolve(cwd);
  let root: string;
  try {
    root = await fs.promises.realpath(sealed);
  } catch {
    return fail('checkpoint-cwd-missing');
  }
  if (root !== sealed) {
    return fail(`checkpoint-root-not-sealed: ${sealed} resolve para ${root} (symlink no caminho); nada foi feito`);
  }
  const rootStat = await fs.promises.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return fail('checkpoint-root-not-sealed: a raiz não é um diretório real');
  const identity = { dev: rootStat.dev, ino: rootStat.ino };
  const forbidden = options.forbiddenRoot ? await diskIdentity(options.forbiddenRoot) : null;
  if (sameIdentity(identity, forbidden)) {
    return fail('checkpoint-forbidden-root: esta é a raiz de coordenação; checkpoint nunca a escreve');
  }
  try {
    await assertSafeLocalGitConfigAsync(git, root);
  } catch (error) {
    if (error instanceof CheckpointTimeout) throw error;
    return fail(describeError(error));
  }
  const top = await git.run(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.status !== 0) return fail('checkpoint-not-a-git-worktree');
  const topReal = await fs.promises.realpath(top.stdout.trim()).catch(() => '');
  if (topReal !== root) return fail('checkpoint-cwd-not-worktree-root');
  if (options.refuseSparse) {
    const sparse = await git.run(root, ['config', '--bool', 'core.sparseCheckout'], { allowFailure: true });
    if (sparse.stdout.trim() === 'true') {
      return fail(
        'sparse-checkout-unsupported: core.sparseCheckout=true nesta árvore; o checkpoint oculto ' +
          'não fotografa sparse checkout (nada foi gravado)',
      );
    }
  }
  if (options.forbiddenRoot) {
    const gitDir = (await git.run(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    const forbiddenGitDir = await git.run(options.forbiddenRoot, ['rev-parse', '--absolute-git-dir'], {
      allowFailure: true,
    });
    if (forbiddenGitDir.status === 0 && forbiddenGitDir.stdout.trim() === gitDir) {
      return fail('checkpoint-forbidden-root: mesma identidade Git da raiz de coordenação');
    }
  }
  const common = (await git.run(root, ['rev-parse', '--git-common-dir'])).stdout.trim();
  const commonDir = await fs.promises.realpath(path.resolve(root, common));
  return { ok: true, root, commonDir, identity, forbidden };
}

/** Revalidação imediatamente antes de cada mutação: a raiz ainda é a selada. */
async function assertRootStable(repo: Repo): Promise<void> {
  const real = await fs.promises.realpath(repo.root).catch(() => null);
  const stat = await fs.promises.lstat(repo.root).catch(() => null);
  const current = stat ? { dev: stat.dev, ino: stat.ino } : null;
  if (real !== repo.root || !stat?.isDirectory() || !sameIdentity(current, repo.identity) ||
      sameIdentity(current, repo.forbidden)) {
    throw new Error(
      `checkpoint-root-identity-changed: ${repo.root} mudou no disco durante a restauração; nada mais foi escrito`,
    );
  }
}

/**
 * Ref de 0 byte: o rename do Git sem fsync deixou o arquivo vazio. Ela não
 * resolve e quebra fetch/push, então sai daqui. Só arquivos regulares vazios
 * sob diretórios reais (nunca segue symlink plantado).
 */
async function sweepEmptyScopeRefs(commonDir: string, scopeKey: string): Promise<string[]> {
  const removed: string[] = [];
  const base = path.join(commonDir, 'refs', 'nexus-checkpoint');
  const dir = path.join(base, scopeKey, 'ordinal');
  for (const component of [path.join(commonDir, 'refs'), base, path.join(base, scopeKey), dir]) {
    const stat = await fs.promises.lstat(component).catch(() => null);
    if (!stat?.isDirectory()) return removed;
  }
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !ORDINAL_NAME.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const stat = await fs.promises.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size !== 0) continue;
    try {
      await fs.promises.unlink(file);
      removed.push(`${CHECKPOINT_REF_PREFIX}/${scopeKey}/ordinal/${entry.name}`);
    } catch {
      // Outro processo já tratou; a próxima listagem confere de novo.
    }
  }
  return removed;
}

async function resolveHead(git: AsyncGitRunner, root: string): Promise<string | null> {
  const head = await git.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFailure: true });
  const sha = head.stdout.trim();
  return head.status === 0 && OID.test(sha) ? sha : null;
}

async function createPrivateIndex(): Promise<{ readonly path: string; dispose(): Promise<void> }> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexus-git-index-'));
  const real = await fs.promises.realpath(directory);
  return {
    path: path.join(real, 'index'),
    // Remove o índice e um `index.lock` deixado por um Git morto no meio.
    dispose: () => fs.promises.rm(real, { recursive: true, force: true }),
  };
}

/** assume-unchanged (letra minúscula) ou skip-worktree (S) esconderiam edições do `add`. */
async function hasHiddenIndexFlags(git: AsyncGitRunner, root: string, indexPath: string): Promise<boolean> {
  const listed = await git.run(root, [...INDEX_CONFIG, 'ls-files', '-v', '-z'], { privateIndexFile: indexPath });
  for (const record of listed.stdout.split('\0')) {
    const tag = record[0];
    if (tag && (tag === 'S' || (tag >= 'a' && tag <= 'z'))) return true;
  }
  return false;
}

async function seedPrivateIndex(git: AsyncGitRunner, root: string, indexPath: string): Promise<void> {
  try {
    const source = path.resolve(
      root,
      (await git.run(root, ['rev-parse', '--git-path', 'index'])).stdout.trim(),
    );
    const { mtimeMs } = await fs.promises.stat(source);
    // Stay below the source timestamp, preserving Git's racy check for edits
    // made in the same second the real index was written.
    const seconds = Math.floor((mtimeMs - 1) / 1000);
    if (seconds > 0) {
      await fs.promises.copyFile(source, indexPath);
      await fs.promises.utimes(indexPath, seconds, seconds);
      if (!(await hasHiddenIndexFlags(git, root, indexPath))) return;
    }
  } catch {
    // Sem índice real legível: parte do HEAD abaixo.
  }
  await git.run(root, [...INDEX_CONFIG, 'read-tree', 'HEAD'], { privateIndexFile: indexPath });
}

function literalExclude(file: string): string {
  return `:(exclude,literal)${file}`;
}

async function stageWorktree(git: AsyncGitRunner, root: string, indexPath: string): Promise<void> {
  const excluded: string[] = [];
  for (let attempt = 0; attempt <= MAX_NESTED_REPO_RETRIES; attempt += 1) {
    const args = [...INDEX_CONFIG, ...DURABLE_WRITE, 'add', '-A', '--', '.', ...excluded.map(literalExclude)];
    const staged = await git.run(root, args, {
      privateIndexFile: indexPath,
      timeoutMs: STAGE_TIMEOUT_MS,
      allowFailure: true,
    });
    if (staged.status === 0) return;
    // Git cannot stage an embedded repository until it has a commit. The
    // upstream discovers these after the failure; here the path comes from
    // Git's own message (LC_ALL=C in the runner) and is excluded literally.
    const nested = [...staged.stderr.matchAll(/^error: '(.+)' does not have a commit checked out$/gm)]
      .map((match) => match[1].replace(/\/$/, ''))
      .filter((file) => file && !excluded.includes(file));
    if (nested.length === 0) throw new GitCommandError(`Git command failed with exit ${staged.status}`, args, staged);
    excluded.push(...nested);
  }
  throw new Error('checkpoint-stage-failed: repositórios aninhados demais sem commit');
}

/** Árvore da worktree inteira (rastreados + untracked não ignorados). */
async function writeWorktreeTree(git: AsyncGitRunner, root: string, baseSha: string | null): Promise<string> {
  const index = await createPrivateIndex();
  try {
    if (baseSha) await seedPrivateIndex(git, root, index.path);
    await stageWorktree(git, root, index.path);
    const tree = (await git.run(root, [...INDEX_CONFIG, ...DURABLE_WRITE, 'write-tree'], {
      privateIndexFile: index.path,
    })).stdout.trim();
    if (!OID.test(tree)) throw new Error('empty-tree-oid: git write-tree não devolveu uma árvore');
    return tree;
  } finally {
    await index.dispose().catch(() => undefined);
  }
}

async function readScopeRefs(git: AsyncGitRunner, root: string, scopeKey: string): Promise<Map<number, string>> {
  const listed = await git.run(root, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    `${CHECKPOINT_REF_PREFIX}/${scopeKey}/ordinal`,
  ]);
  const refs = new Map<number, string>();
  for (const line of listed.stdout.split('\n')) {
    const [ref, oid] = line.trim().split(' ');
    const parsed = ref ? parseCheckpointRef(ref) : null;
    if (parsed && parsed.scopeKey === scopeKey && oid && OID.test(oid)) refs.set(parsed.ordinal, oid);
  }
  return refs;
}

/** Mesma árvore sobre o mesmo HEAD: o checkpoint existente já é este. */
async function sameSnapshot(
  git: AsyncGitRunner,
  root: string,
  commit: string,
  tree: string,
  baseSha: string | null,
): Promise<boolean> {
  const raw = await git.run(root, ['cat-file', 'commit', commit], { allowFailure: true });
  if (raw.status !== 0) return false;
  const header = raw.stdout.split('\n\n', 1)[0].split('\n');
  const commitTree = header.find((line) => line.startsWith('tree '))?.slice(5);
  const parents = header.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
  return commitTree === tree && parents.join(' ') === (baseSha ?? '');
}

async function publishCheckpoint(
  git: AsyncGitRunner,
  root: string,
  input: {
    readonly scopeKey: string;
    readonly tree: string;
    readonly baseSha: string | null;
    readonly ordinal?: number;
    readonly note?: readonly string[];
    /** Sinal de desistência + Git sem prazo (o desfazer roda já fora dele). */
    readonly abandon?: { readonly signal: AbortSignal; readonly git: AsyncGitRunner };
  },
): Promise<CheckpointCaptureResult> {
  const existing = await readScopeRefs(git, root, input.scopeKey);
  const reuse = (ordinal: number, commit: string): CheckpointCaptureSuccess => ({
    ok: true,
    ref: `${CHECKPOINT_REF_PREFIX}/${input.scopeKey}/ordinal/${ordinal}`,
    commit,
    tree: input.tree,
    ordinal,
    baseSha: input.baseSha,
    reused: true,
  });
  let ordinal: number;
  // Valor antigo esperado: '' = a ref não pode existir (nunca sobrescreve às cegas).
  let expectedOld = '';
  if (input.ordinal !== undefined) {
    ordinal = input.ordinal;
    const current = existing.get(ordinal);
    if (current) {
      if (await sameSnapshot(git, root, current, input.tree, input.baseSha)) return reuse(ordinal, current);
      expectedOld = current;
    }
  } else {
    const latest = existing.size > 0 ? Math.max(...existing.keys()) : undefined;
    const latestCommit = latest === undefined ? undefined : existing.get(latest);
    if (latest !== undefined && latestCommit &&
        await sameSnapshot(git, root, latestCommit, input.tree, input.baseSha)) {
      return reuse(latest, latestCommit);
    }
    ordinal = (latest ?? 0) + 1;
  }
  const ref = `${CHECKPOINT_REF_PREFIX}/${input.scopeKey}/ordinal/${ordinal}`;
  const message = [
    `nexus checkpoint ref=${ref}`,
    '',
    ...(input.note ?? []),
    `Base: ${input.baseSha ?? '(sem HEAD)'}`,
  ].join('\n');
  const commit = (await git.run(
    root,
    [...DURABLE_WRITE, 'commit-tree', input.tree, ...(input.baseSha ? ['-p', input.baseSha] : []), '-m', message],
    { env: CHECKPOINT_IDENTITY },
  )).stdout.trim();
  if (!OID.test(commit)) {
    return fail('empty-commit-oid: git commit-tree não devolveu um commit; nenhuma ref foi publicada');
  }
  await git.run(root, [...DURABLE_WRITE, 'update-ref', '-m', 'nexus: checkpoint', ref, commit, expectedOld]);
  // F-1018: quem pediu desistiu enquanto o `update-ref` rodava (já respondeu
  // `timeout`): a publicação tardia é desfeita por CAS — só se a ref ainda
  // aponta para este commit — e nenhuma ref fica órfã do artifact.
  if (input.abandon?.signal.aborted) {
    await input.abandon.git.run(root, [
      ...DURABLE_WRITE, 'update-ref', '-m', 'nexus: checkpoint abandonado',
      ...(expectedOld ? [ref, expectedOld, commit] : ['-d', ref, commit]),
    ]);
    throw new CheckpointTimeout();
  }
  return { ok: true, ref, commit, tree: input.tree, ordinal, baseSha: input.baseSha, reused: false };
}

/** Fotografa a árvore de trabalho em `refs/nexus-checkpoint/<escopo>/ordinal/<n>`. */
export function captureHiddenCheckpoint(
  input: CheckpointCaptureInput,
  deps: HiddenCheckpointDeps = {},
): Promise<CheckpointCaptureResult> {
  return serialized(path.resolve(input.cwd), async () => {
    const rawGit = deps.git ?? new AsyncProcessGitRunner();
    const git = withDeadline(rawGit, input.deadlineAt);
    if (input.ordinal !== undefined && !isOrdinal(input.ordinal)) return fail('invalid-checkpoint-ordinal');
    try {
      const repo = await resolveRepo(git, input.cwd, {
        refuseSparse: true,
        ...(input.forbiddenRoot ? { forbiddenRoot: input.forbiddenRoot } : {}),
      });
      if (!repo.ok) return repo;
      const scopeKey = checkpointScopeKey(input.scopeId);
      await sweepEmptyScopeRefs(repo.commonDir, scopeKey);
      const baseSha = await resolveHead(git, repo.root);
      const tree = await writeWorktreeTree(git, repo.root, baseSha);
      return await publishCheckpoint(git, repo.root, {
        scopeKey,
        tree,
        baseSha,
        ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.signal ? { abandon: { signal: input.signal, git: rawGit } } : {}),
      });
    } catch (error) {
      // Git morto pelo prazo (SIGKILL) chega como falha genérica: o relógio decide.
      if (error instanceof CheckpointTimeout ||
          (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt)) {
        return fail('timeout');
      }
      return fail(describeError(error));
    }
  });
}

/** Checkpoints do escopo, do mais antigo ao mais novo; apaga refs de 0 byte. */
export async function listHiddenCheckpoints(
  input: { readonly cwd: string; readonly scopeId: string },
  deps: HiddenCheckpointDeps = {},
): Promise<CheckpointListResult> {
  const git = deps.git ?? new AsyncProcessGitRunner();
  try {
    const repo = await resolveRepo(git, input.cwd, { refuseSparse: false });
    if (!repo.ok) return repo;
    const scopeKey = checkpointScopeKey(input.scopeId);
    const removedEmptyRefs = await sweepEmptyScopeRefs(repo.commonDir, scopeKey);
    const listed = await git.run(repo.root, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(contents:subject)',
      `${CHECKPOINT_REF_PREFIX}/${scopeKey}/ordinal`,
    ]);
    const checkpoints: CheckpointEntry[] = [];
    for (const line of listed.stdout.split('\n')) {
      const [ref = '', commit = '', createdAt = '', subject = ''] = line.split('\0');
      const parsed = parseCheckpointRef(ref);
      if (!parsed || parsed.scopeKey !== scopeKey || !OID.test(commit)) continue;
      checkpoints.push({ ref, ordinal: parsed.ordinal, commit, createdAt: Number(createdAt) || 0, subject });
    }
    checkpoints.sort((left, right) => left.ordinal - right.ordinal);
    return { ok: true, checkpoints, removedEmptyRefs };
  } catch (error) {
    return fail(describeError(error));
  }
}

function parseNameStatusZ(stdout: string): Array<{ status: string; file: string }> {
  const fields = stdout.split('\0');
  const entries: Array<{ status: string; file: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const file = fields[index + 1];
    if (status && file) entries.push({ status, file });
  }
  return entries;
}

/**
 * `checkout-index -f` apagaria o que estiver no caminho (diretório no lugar do
 * arquivo, arquivo/symlink no lugar de um diretório pai). Esses caminhos não
 * são escritos: viram conflito na prévia, nada é removido.
 */
async function blockedPath(root: string, file: string): Promise<boolean> {
  const parts = file.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await fs.promises.lstat(current).catch(() => null);
    if (!stat) return false;
    const last = index === parts.length - 1;
    if (last ? stat.isDirectory() : !stat.isDirectory()) return true;
  }
  return false;
}

async function existsNoFollow(file: string): Promise<boolean> {
  return (await fs.promises.lstat(file).catch(() => null)) !== null;
}

/**
 * Escreve por índice privado + `checkout-index`. Antes de CADA lote: confere
 * de novo que nenhum caminho ficou bloqueado e chama `beforeChunk` (raiz
 * selada + autoridade do chamador). Devolve quantos arquivos escreveu.
 */
async function writeCheckpointFiles(
  git: AsyncGitRunner,
  root: string,
  commit: string,
  files: readonly string[],
  beforeChunk: () => Promise<void>,
  progress: { written: number },
): Promise<void> {
  const index = await createPrivateIndex();
  try {
    await git.run(root, [...INDEX_CONFIG, 'read-tree', commit], { privateIndexFile: index.path });
    for (let start = 0; start < files.length; start += CHECKOUT_CHUNK) {
      const chunk = files.slice(start, start + CHECKOUT_CHUNK);
      for (const file of chunk) {
        if (await blockedPath(root, file)) {
          throw new CallerRefusal(new Error(
            `checkpoint-tree-changed: ${file} ganhou diretório/symlink no caminho durante a restauração`,
          ));
        }
      }
      await beforeChunk();
      await git.run(root, [...INDEX_CONFIG, 'checkout-index', '-f', '--', ...chunk], {
        privateIndexFile: index.path,
        timeoutMs: STAGE_TIMEOUT_MS,
      });
      progress.written += chunk.length;
    }
  } finally {
    await index.dispose().catch(() => undefined);
  }
}

/**
 * Restauração explícita: com `apply: false` só diz o que seria sobrescrito e
 * criado; com `apply: true` guarda o estado atual como checkpoint novo e
 * escreve os arquivos da árvore do checkpoint na raiz. Nunca automática.
 */
export function restoreHiddenCheckpoint(
  input: CheckpointRestoreInput,
  deps: HiddenCheckpointDeps = {},
): Promise<CheckpointRestoreResult> {
  return serialized(path.resolve(input.cwd), async () => {
    const git = deps.git ?? new AsyncProcessGitRunner();
    const parsed = parseCheckpointRef(input.ref);
    if (!parsed) return fail('invalid-checkpoint-ref');
    const scopeKey = checkpointScopeKey(input.scopeId);
    if (parsed.scopeKey !== scopeKey) return fail('checkpoint-outside-scope');
    try {
      const repo = await resolveRepo(git, input.cwd, {
        refuseSparse: true,
        ...(input.forbiddenRoot ? { forbiddenRoot: input.forbiddenRoot } : {}),
      });
      if (!repo.ok) return repo;
      const removed = await sweepEmptyScopeRefs(repo.commonDir, scopeKey);
      if (removed.includes(input.ref)) {
        return fail('checkpoint-ref-empty: a ref tinha 0 byte (gravação interrompida) e foi apagada; nada restaurado');
      }
      const resolved = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', `${input.ref}^{commit}`], {
        allowFailure: true,
      });
      const commit = resolved.stdout.trim();
      if (resolved.status !== 0 || !OID.test(commit)) return fail('checkpoint-not-found');
      const targetTree = (await git.run(repo.root, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
      const baseSha = await resolveHead(git, repo.root);
      const currentTree = await writeWorktreeTree(git, repo.root, baseSha);
      const diff = await git.run(repo.root, [
        'diff-tree', '-r', '-z', '--no-renames', '--name-status', currentTree, targetTree,
      ]);
      const overwrite: string[] = [];
      const create: string[] = [];
      const keptExtra: string[] = [];
      const conflicts: string[] = [];
      for (const { status, file } of parseNameStatusZ(diff.stdout)) {
        if (status === 'D') {
          keptExtra.push(file);
        } else if (await blockedPath(repo.root, file)) {
          conflicts.push(file);
        } else if (await existsNoFollow(path.join(repo.root, file))) {
          // Inclui arquivo ignorado que existe no disco e voltaria do checkpoint.
          overwrite.push(file);
        } else {
          create.push(file);
        }
      }
      const plan = { overwrite, create, keptExtra, conflicts };
      const writable = [...overwrite, ...create];
      if (!input.apply || writable.length === 0) {
        return { ok: true, ref: input.ref, commit, applied: false, backup: null, ...plan };
      }
      // Todos os destinos passam pelas guardas do chamador antes de qualquer escrita.
      try {
        input.assertTargets?.(writable);
      } catch (error) {
        throw new CallerRefusal(error);
      }
      const assertCanWrite = async (): Promise<void> => {
        try {
          await assertRootStable(repo);
          input.assertCanWrite?.();
        } catch (error) {
          throw new CallerRefusal(error);
        }
      };
      await assertCanWrite();
      const backup = await publishCheckpoint(git, repo.root, {
        scopeKey,
        tree: currentTree,
        baseSha,
        note: [`Cópia de segurança antes de restaurar ${input.ref}`],
      });
      if (!backup.ok) return fail(`checkpoint-backup-failed: ${backup.reason}; nada restaurado`);
      const progress = { written: 0 };
      try {
        await assertCanWrite();
        await writeCheckpointFiles(git, repo.root, commit, writable, assertCanWrite, progress);
      } catch (error) {
        const detail = describeError(error instanceof CallerRefusal ? error.original : error);
        if (progress.written === 0) {
          if (error instanceof CallerRefusal) throw error;
          return fail(`checkpoint-restore-failed: ${detail}; nada escrito, estado anterior em ${backup.ref}`);
        }
        const partial = `${detail}; restauração interrompida depois de ${progress.written} arquivo(s); ` +
          `o estado anterior está em ${backup.ref}`;
        if (error instanceof CallerRefusal) throw new CallerRefusal(new Error(partial, { cause: error.original }));
        return fail(`checkpoint-restore-partial: ${partial}`);
      }
      return { ok: true, ref: input.ref, commit, applied: true, backup, ...plan };
    } catch (error) {
      // Recusa/cancelamento do chamador propaga como o erro original.
      if (error instanceof CallerRefusal) throw error.original;
      return fail(describeError(error));
    }
  });
}

/** Testes: espera capturas/restaurações em curso terminarem. */
export async function hiddenCheckpointIdle(): Promise<void> {
  while (serialByRoot.size > 0) await Promise.all([...serialByRoot.values()]);
}
