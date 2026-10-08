/**
 * F-794 — rede de segurança do writer isolado: trabalho nunca fica SÓ no
 * working tree.
 *
 * Na Missão Terminais (03/10) o F-764 e o F-768 terminaram validados e sem
 * commit numa worktree em `Application Support`; o Nexus foi fechado e só uma
 * análise manual recuperou os patches. Este módulo guarda as alterações não
 * commitadas da worktree do writer num commit de salvaguarda quando ele
 * entrega o handoff, quando o pane sai/fecha e, como último recurso, quando o
 * escopo do projeto reabre depois de um encerramento do app.
 *
 * Doutrina:
 *  - NÃO toca branch, índice real, HEAD nem arquivos da worktree. O snapshot
 *    usa um índice privado do Nexus (`createPrivateGitIndex`/GIT_INDEX_FILE em
 *    tmp), `write-tree` e `commit-tree`; o commit é filho do HEAD da branch.
 *  - NUNCA usa `git stash`: a pilha é global ao repositório e compartilhada
 *    entre worktrees. O commit fica numa ref própria,
 *    `refs/nexus-salvage/<branch>/<carimbo>`, fora de refs/heads (não aparece
 *    em `git branch`, não é publicada por push padrão, nunca é main).
 *  - Só age na worktree registrada do writer: toplevel exato e HEAD na branch
 *    `nexus/…` alocada. Identidade incerta = recusa registrada, nunca palpite.
 *  - Git assíncrono (AsyncProcessGitRunner), fora do turno que o disparou e
 *    serializado por worktree. Falha vira trace, nunca exceção para quem chamou.
 *  - Idempotente: árvore igual à da última salvaguarda não cria commit novo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  AsyncProcessGitRunner,
  assertSafeLocalGitConfigAsync,
  type AsyncGitRunner,
  type GitRunOptions,
} from '../runtime/git-command';
import { trace } from '../observability/main-trace';
import { ISOLATED_WRITER_BRANCH_PREFIX } from './isolated-writer-policy';
import { KeyedLock } from '../util/keyed-lock';

export const WORKTREE_SALVAGE_REF_PREFIX = 'refs/nexus-salvage';
/** Autor (sintético, prefixo `nexus-`) do aviso ao orquestrador. */
export const WORKTREE_SALVAGE_AUTHOR = 'nexus-worktree-salvage';
export const WORKTREE_SALVAGE_ARTIFACT_KIND = 'nexus.worktree-salvage';

/** Identidade fixa: commit-tree não depende de user.name/email do operador. */
const SALVAGE_IDENTITY: NonNullable<GitRunOptions['env']> = Object.freeze({
  GIT_AUTHOR_NAME: 'Nexus (salvaguarda)',
  GIT_AUTHOR_EMAIL: 'salvaguarda@nexus.invalid',
  GIT_COMMITTER_NAME: 'Nexus (salvaguarda)',
  GIT_COMMITTER_EMAIL: 'salvaguarda@nexus.invalid',
});

/** Acima disso o snapshot leva só os rastreados (não varre milhares de stats). */
const MAX_UNTRACKED_ENTRIES = 5_000;
/** Arquivo novo maior que isso fica fora do snapshot (e é listado no aviso). */
const MAX_UNTRACKED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LISTED_FILES = 200;
const NOTICE_LISTED_FILES = 12;

export type WorktreeSalvageReason = 'handoff' | 'pane-exit' | 'reopen-sweep' | 'gc';

export interface WorktreeSalvageTarget {
  /** Caminho real da worktree registrada do writer. */
  readonly worktreePath: string;
  /** `refs/heads/nexus/…` alocada pelo registry. */
  readonly branchRef: string;
  /** Chave do registry: id da missão ou `operator-hand`. */
  readonly missionId: string;
  readonly taskId: string;
  readonly reason: WorktreeSalvageReason;
  readonly handoffId?: string;
  readonly sessionId?: string;
  readonly agentLabel?: string;
}

export interface WorktreeSalvageFile {
  readonly status: string;
  readonly path: string;
}

export type WorktreeSalvageResult =
  | { readonly kind: 'clean' }
  | { readonly kind: 'unchanged'; readonly ref: string; readonly commit: string }
  | {
      readonly kind: 'saved';
      readonly ref: string;
      readonly commit: string;
      readonly baseSha: string;
      readonly files: readonly WorktreeSalvageFile[];
      readonly fileCount: number;
      /** Arquivos novos deixados de fora (grandes demais). */
      readonly skipped: readonly string[];
      /** Arquivos novos não varridos (excesso); o snapshot leva só rastreados. */
      readonly untrackedOmitted: number;
    }
  | { readonly kind: 'refused'; readonly reason: string };

export interface WorktreeSalvageDeps {
  readonly git?: AsyncGitRunner;
  readonly now?: () => number;
}

const SALVAGE_SCHEMA_REASON: Record<WorktreeSalvageReason, string> = {
  handoff: 'entrega do handoff',
  'pane-exit': 'pane encerrado',
  'reopen-sweep': 'reabertura do projeto depois de um encerramento',
  gc: 'worktree suja parada há mais de um dia (mantida)',
};

function refused(reason: string): WorktreeSalvageResult {
  return { kind: 'refused', reason };
}

/** `20261003T143513123Z`: ordenável e válido como componente de ref. */
export function salvageStamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:.]/g, '');
}

export function salvageRefPrefix(branchRef: string): string {
  return `${WORKTREE_SALVAGE_REF_PREFIX}/${branchRef.slice('refs/heads/'.length)}`;
}

/** `git status --porcelain=v1 -z`: renomeação traz o caminho de origem a seguir. */
function parsePorcelainZ(stdout: string): { untracked: string[]; changed: number } {
  const untracked: string[] = [];
  let changed = 0;
  const fields = stdout.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const xy = field.slice(0, 2);
    const file = field.slice(3);
    changed += 1;
    if (xy === '??') untracked.push(file);
    // R/C: o próximo campo é o caminho anterior, não uma entrada nova.
    if (xy[0] === 'R' || xy[0] === 'C') index += 1;
  }
  return { untracked, changed };
}

function parseNameStatusZ(stdout: string): WorktreeSalvageFile[] {
  const files: WorktreeSalvageFile[] = [];
  const fields = stdout.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const file = fields[index + 1];
    if (!status || !file) continue;
    files.push({ status, path: file });
  }
  return files;
}

/** Pathspec literal (sem glob/magia do conteúdo do arquivo). */
function excludeLiteral(file: string): string {
  return `:(exclude,literal)${file}`;
}

async function createAsyncPrivateIndex(): Promise<{ path: string; dispose: () => Promise<void> }> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexus-git-index-'));
  const real = await fs.promises.realpath(directory);
  return {
    path: path.join(real, 'index'),
    dispose: async () => {
      await fs.promises.rm(real, { recursive: true, force: true });
    },
  };
}

function commitMessage(
  target: WorktreeSalvageTarget,
  baseSha: string,
  skipped: readonly string[],
  untrackedOmitted: number,
): string {
  const lines = [
    `nexus: salvaguarda da worktree do writer (${SALVAGE_SCHEMA_REASON[target.reason]})`,
    '',
    'O Nexus guardou as alterações não commitadas desta worktree para que o',
    'trabalho não fique só no working tree. Branch, índice e arquivos da',
    'worktree não foram alterados.',
    '',
    `Missão: ${target.missionId}`,
    `Tarefa: ${target.taskId}`,
    `Branch: ${target.branchRef.slice('refs/heads/'.length)}`,
    `Base: ${baseSha}`,
  ];
  if (target.handoffId) lines.push(`Handoff: ${target.handoffId}`);
  if (target.sessionId) lines.push(`Sessão: ${target.sessionId}`);
  if (skipped.length > 0) {
    lines.push(`Fora do snapshot (maiores que 25 MB): ${skipped.length} arquivo(s)`);
  }
  if (untrackedOmitted > 0) {
    lines.push(`Arquivos novos não varridos (excesso): ${untrackedOmitted}`);
  }
  return lines.join('\n');
}

/** Uma salvaguarda por worktree de cada vez: handoff e saída podem coincidir. */
const worktreeLock = new KeyedLock();

/**
 * Guarda as alterações não commitadas da worktree do writer num commit sob
 * `refs/nexus-salvage/`. Lança só em falha de Git inesperada; quem dispara
 * pelo produto usa `scheduleWorktreeSalvage`, que nunca lança.
 */
export function salvageIsolatedWriterWorktree(
  target: WorktreeSalvageTarget,
  deps: WorktreeSalvageDeps = {},
): Promise<WorktreeSalvageResult> {
  return worktreeLock.run(target.worktreePath, () => runSalvage(target, deps));
}

async function runSalvage(
  target: WorktreeSalvageTarget,
  deps: WorktreeSalvageDeps,
): Promise<WorktreeSalvageResult> {
  const git = deps.git ?? new AsyncProcessGitRunner();
  const now = deps.now ?? Date.now;
  if (!target.branchRef.startsWith(ISOLATED_WRITER_BRANCH_PREFIX)) {
    return refused('branch-outside-nexus-namespace');
  }
  let real: string;
  try {
    real = await fs.promises.realpath(target.worktreePath);
  } catch {
    return refused('worktree-missing');
  }
  if (real !== path.resolve(target.worktreePath)) return refused('worktree-path-mismatch');
  try {
    await assertSafeLocalGitConfigAsync(git, real);
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'unsafe-git-config');
  }
  const top = await git.run(real, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.status !== 0 || path.resolve(top.stdout.trim()) !== real) {
    return refused('worktree-toplevel-mismatch');
  }
  const head = await git.run(real, ['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true });
  if (head.status !== 0 || head.stdout.trim() !== target.branchRef) {
    return refused('worktree-head-not-on-allocated-branch');
  }
  const status = await git.run(real, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.stdout.length === 0) return { kind: 'clean' };
  const { untracked } = parsePorcelainZ(status.stdout);
  const skipped: string[] = [];
  let untrackedOmitted = 0;
  if (untracked.length > MAX_UNTRACKED_ENTRIES) {
    untrackedOmitted = untracked.length;
  } else {
    for (const file of untracked) {
      try {
        const stat = await fs.promises.lstat(path.join(real, file));
        if (stat.isFile() && stat.size > MAX_UNTRACKED_FILE_BYTES) skipped.push(file);
      } catch {
        // Sumiu entre o status e o stat: o `add` abaixo simplesmente não o vê.
      }
    }
  }
  const baseSha = (await git.run(real, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  const index = await createAsyncPrivateIndex();
  try {
    // Parte do índice REAL (cache de stat): o `add` não precisa re-hashear a
    // árvore inteira. O índice real é só lido, nunca escrito.
    const indexPath = (await git.run(real, ['rev-parse', '--git-path', 'index'])).stdout.trim();
    try {
      await fs.promises.copyFile(path.resolve(real, indexPath), index.path);
    } catch {
      await git.run(real, ['read-tree', 'HEAD'], { privateIndexFile: index.path });
    }
    const addArgs = untrackedOmitted > 0
      ? ['add', '-u', '--', '.']
      : ['add', '-A', '--', '.', ...skipped.map(excludeLiteral)];
    await git.run(real, addArgs, { privateIndexFile: index.path, timeoutMs: 120_000 });
    const tree = (await git.run(real, ['write-tree'], { privateIndexFile: index.path })).stdout.trim();
    const headTree = (await git.run(real, ['rev-parse', `${baseSha}^{tree}`])).stdout.trim();
    // Só ignorados/vazios mudaram: nada a guardar.
    if (tree === headTree) return { kind: 'clean' };
    const prefix = salvageRefPrefix(target.branchRef);
    const latest = (await git.run(real, [
      'for-each-ref', '--sort=-refname', '--count=1',
      '--format=%(objectname) %(refname)', `${prefix}/`,
    ])).stdout.trim();
    if (latest) {
      const [latestCommit, latestRef] = latest.split(' ');
      const latestTree = await git.run(real, ['rev-parse', `${latestCommit}^{tree}`], { allowFailure: true });
      if (latestCommit && latestRef && latestTree.status === 0 && latestTree.stdout.trim() === tree) {
        return { kind: 'unchanged', ref: latestRef, commit: latestCommit };
      }
    }
    const commit = (await git.run(
      real,
      ['commit-tree', tree, '-p', baseSha, '-m', commitMessage(target, baseSha, skipped, untrackedOmitted)],
      { env: SALVAGE_IDENTITY },
    )).stdout.trim();
    const ref = `${prefix}/${salvageStamp(now())}`;
    // Valor antigo vazio: a ref não pode existir (nunca sobrescreve).
    await git.run(real, ['update-ref', '-m', 'nexus: salvaguarda da worktree', ref, commit, '']);
    const diff = await git.run(real, ['diff', '--name-status', '--no-renames', '-z', baseSha, commit]);
    const files = parseNameStatusZ(diff.stdout);
    return {
      kind: 'saved',
      ref,
      commit,
      baseSha,
      files: files.slice(0, MAX_LISTED_FILES),
      fileCount: files.length,
      skipped,
      untrackedOmitted,
    };
  } finally {
    await index.dispose().catch(() => undefined);
  }
}

export interface WorktreeSalvageNotice {
  readonly scope: ProjectExecutionScope;
  readonly target: WorktreeSalvageTarget;
  readonly result: Extract<WorktreeSalvageResult, { kind: 'saved' }>;
}

/**
 * Texto do aviso ao orquestrador: o que foi guardado, onde, e como integrar.
 * Puro para teste.
 */
export function salvageNoticeSummary(
  target: WorktreeSalvageTarget,
  result: Extract<WorktreeSalvageResult, { kind: 'saved' }>,
): string {
  const who = target.agentLabel ? `do writer "${target.agentLabel}" ` : '';
  const branch = target.branchRef.slice('refs/heads/'.length);
  const listed = result.files.slice(0, NOTICE_LISTED_FILES).map((file) => file.path);
  const more = result.fileCount > listed.length ? ` (+${result.fileCount - listed.length})` : '';
  const skipped = result.skipped.length > 0
    ? ` ${result.skipped.length} arquivo(s) grande(s) ficaram fora do snapshot.`
    : '';
  return (
    `[salvaguarda] A worktree ${who}na branch ${branch} tinha ${result.fileCount} ` +
    `arquivo(s) sem commit (${SALVAGE_SCHEMA_REASON[target.reason]}). O Nexus guardou tudo no ` +
    `commit ${result.commit.slice(0, 12)} (ref ${result.ref}, filho de ` +
    `${result.baseSha.slice(0, 12)}); branch, índice e arquivos da worktree não mudaram.${skipped} ` +
    `Integre com \`git cherry-pick ${result.commit.slice(0, 12)}\` ou confira com ` +
    `\`git diff ${result.baseSha.slice(0, 12)} ${result.commit.slice(0, 12)}\`. ` +
    `Arquivos: ${listed.join(', ')}${more}.`
  );
}

export type WorktreeSalvageNotifier = (notice: WorktreeSalvageNotice) => void;

let notifier: WorktreeSalvageNotifier | null = null;

/**
 * O aviso ao orquestrador é injetado (handoff sintético + entrega) para este
 * módulo não importar o despacho de handoffs: o Main configura no boot.
 */
export function setWorktreeSalvageNotifier(next: WorktreeSalvageNotifier | null): void {
  notifier = next;
}

function traceSalvage(
  target: WorktreeSalvageTarget,
  result: WorktreeSalvageResult | { kind: 'error'; reason: string },
): void {
  trace({
    kind: 'worktree-salvage',
    outcome: result.kind,
    reason: target.reason,
    missionId: target.missionId,
    taskId: target.taskId,
    branch: target.branchRef.slice('refs/heads/'.length),
    ...(target.handoffId ? { handoffId: target.handoffId } : {}),
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(result.kind === 'saved'
      ? {
          ref: result.ref,
          commit: result.commit,
          base: result.baseSha,
          fileCount: result.fileCount,
          skippedLarge: result.skipped.length,
          untrackedOmitted: result.untrackedOmitted,
        }
      : {}),
    ...(result.kind === 'unchanged' ? { ref: result.ref, commit: result.commit } : {}),
    ...(result.kind === 'refused' || result.kind === 'error' ? { detail: result.reason.slice(0, 200) } : {}),
  });
}

/**
 * Disparo do produto: roda depois do turno atual, registra no trace e avisa o
 * orquestrador quando um snapshot NOVO foi gravado. Nunca lança.
 */
const scheduled = new Set<Promise<unknown>>();

export function scheduleWorktreeSalvage(
  target: WorktreeSalvageTarget,
  options: { readonly scope?: ProjectExecutionScope; readonly notify?: boolean; readonly deps?: WorktreeSalvageDeps } = {},
): Promise<WorktreeSalvageResult | null> {
  const run = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => salvageIsolatedWriterWorktree(target, options.deps))
    .then((result) => {
      traceSalvage(target, result);
      if (result.kind === 'saved' && options.notify !== false && options.scope && notifier) {
        try {
          notifier({ scope: options.scope, target, result });
        } catch (error) {
          console.warn('[worktree-salvage] aviso ao orquestrador falhou:', error);
        }
      }
      return result;
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      traceSalvage(target, { kind: 'error', reason });
      console.warn('[worktree-salvage] salvaguarda falhou:', reason);
      return null;
    });
  scheduled.add(run);
  void run.finally(() => scheduled.delete(run));
  return run;
}

/** Testes: espera as salvaguardas agendadas e em curso terminarem. */
export async function worktreeSalvageIdle(): Promise<void> {
  while (scheduled.size > 0 || worktreeLock.size > 0) {
    await Promise.all([...scheduled, worktreeLock.idle()]);
  }
}
