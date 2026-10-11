/**
 * F-1173 — os checkpoints ocultos de writer ganham tela humana.
 *
 * Até aqui listar/restaurar existiam só como `nexus_checkpoint_list` /
 * `nexus_checkpoint_restore` (MCP). Este módulo dá ao renderer as mesmas três
 * operações (listar, prévia, restaurar) com a MESMA autoridade da ferramenta
 * no papel de orquestrador:
 *
 *  - Escopo: só o workspace vivo deste renderer (`requireLiveRendererWorkspaceScope`),
 *    e a missão precisa existir nos stores desse escopo.
 *  - Árvores: as raízes de execução da missão pelo Main (aba + registro de
 *    worktrees), nunca a de coordenação. O renderer manda `missionId` e uma
 *    ref; a ref só escolhe ENTRE essas raízes pelo hash do escopo. Nenhum
 *    caminho vem do renderer.
 *  - Restauração: raiz selada, writer ocioso (o operador não é sessão, então
 *    toda sessão ocupada na árvore recusa), guardas de .agents/.codex,
 *    .context/estágio PREVC e lane de plano em todos os destinos, e o escopo
 *    do renderer + raiz + writers conferidos de novo antes do backup, depois
 *    dele e antes de cada lote — a fila serializada do hidden-checkpoint faz o resto.
 *
 * Falha volta como `{ ok: false, error }`: a tela mostra o motivo sem o
 * prefixo "Error invoking remote method" do Electron.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WebContents } from 'electron';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type {
  MissionCheckpointEntryView,
  MissionCheckpointFileList,
  MissionCheckpointListResult,
  MissionCheckpointPlanView,
  MissionCheckpointPreviewResult,
  MissionCheckpointRestoreResult,
  MissionCheckpointScopeView,
} from '../../shared/mission-checkpoints';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireLiveRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { handleTrusted } from '../security/trusted-ipc';
import { AsyncProcessGitRunner, type AsyncGitRunner } from '../runtime/git-command';
import {
  CHECKPOINT_REF_PATTERN,
  listHiddenCheckpoints,
  restoreHiddenCheckpoint,
  type CheckpointRestorePlan,
} from '../git/hidden-checkpoint';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  assertCheckpointRestoreTargets,
  assertCheckpointWritersIdle,
  checkpointRootForRef,
  missionExecutionCheckpointRoots,
  missionForCheckpointRestore,
  sealedCheckpointRoot,
  type CheckpointRoot,
} from './tools-checkpoint';

/** Teto de arquivos por lista devolvida à tela (o total real vai junto). */
const MAX_VIEW_FILES = 50;
/** Só os checkpoints mais recentes de cada árvore ganham detalhe de arquivos. */
const MAX_VIEW_CHECKPOINTS = 30;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const missionIdSchema = z.string().min(1).max(128);
const listInputSchema = z.object({ missionId: missionIdSchema }).strict();
const refInputSchema = z
  .object({
    missionId: missionIdSchema,
    ref: z.string().max(200).regex(CHECKPOINT_REF_PATTERN),
  })
  .strict();
const restoreInputSchema = refInputSchema
  .extend({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

export const CHECKPOINT_PLAN_CHANGED =
  'o checkpoint ou a árvore mudou desde a prévia; reveja a prévia antes de restaurar';

/** Recusa por plano divergente: a tela oferece nova prévia. */
class StalePlanError extends Error {
  constructor() {
    super(CHECKPOINT_PLAN_CHANGED);
  }
}

/**
 * Impressão digital do que a restauração ESCREVERIA: o commit do checkpoint
 * e, para cada destino (sobrescrever + criar), se existe no disco, tamanho e
 * mtime. A prévia devolve; a restauração recalcula dentro da fila da raiz,
 * antes de qualquer escrita (`assertTargets`), e recusa se divergir — um
 * writer que criou, apagou ou editou um destino depois da prévia muda a
 * impressão. Conteúdo sobrescrito ainda vai para o backup de qualquer forma.
 */
async function planFingerprint(root: string, ref: string, commit: string, targets: readonly string[]): Promise<string> {
  // lstat assíncrono: com milhares de destinos o Main não para (F-764).
  const files = await Promise.all([...targets].sort().map(async (file) => {
    const stat = await fs.promises.lstat(path.join(root, file)).catch(() => null);
    return stat ? [file, stat.isSymbolicLink() ? 'l' : 'f', stat.size, stat.mtimeMs] : [file, null];
  }));
  return createHash('sha256').update(JSON.stringify({ ref, commit, files })).digest('hex');
}

async function resolveCheckpointCommit(git: AsyncGitRunner, root: string, ref: string): Promise<string | null> {
  const resolved = await git.run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
  const commit = resolved.stdout.trim();
  return resolved.status === 0 && OID.test(commit) ? commit : null;
}

type RendererOwner = Pick<WebContents, 'id' | 'isDestroyed' | 'isCrashed'>;

export interface MissionCheckpointIpcDeps {
  /** Escopo vivo do renderer; com `expected`, recusa se ele mudou. */
  readonly rendererScope?: (owner: RendererOwner, expected?: ProjectExecutionScope) => ProjectExecutionScope;
  readonly git?: AsyncGitRunner;
  /** Registro do canal; padrão `handleTrusted` (só a janela principal, frame principal). */
  readonly handle?: typeof handleTrusted;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capped(files: readonly string[]): MissionCheckpointFileList {
  return { files: files.slice(0, MAX_VIEW_FILES), total: files.length };
}

function planView(root: string, ref: string, plan: CheckpointRestorePlan): MissionCheckpointPlanView {
  return {
    ref,
    root,
    overwrite: capped(plan.overwrite),
    create: capped(plan.create),
    keptExtra: capped(plan.keptExtra),
    conflicts: capped(plan.conflicts),
  };
}

/** A missão precisa existir NESTE escopo; outra missão/projeto não lista nada. */
function requireMissionRoots(scope: ProjectExecutionScope, missionId: string): CheckpointRoot[] {
  const mission = getProjectDomainStores(scope).missions.get(missionId);
  if (!mission) throw new Error('missão não encontrada neste projeto');
  return missionExecutionCheckpointRoots(scope, missionId);
}

/** Mensagem gravada pelo Nexus: só metadado para a tela, nunca autoridade. */
function describeCommitMessage(body: string): Pick<MissionCheckpointEntryView, 'kind' | 'writer'> {
  const lines = body.split('\n').map((line) => line.trim());
  const writerLine = lines.find((line) => line.startsWith('Fim do turno do writer '));
  if (writerLine) {
    const writer = writerLine.slice('Fim do turno do writer '.length).trim();
    return { kind: 'turn', writer: writer.length > 0 ? writer.slice(0, 120) : null };
  }
  if (lines.some((line) => line.startsWith('Cópia de segurança antes de restaurar '))) {
    return { kind: 'backup', writer: null };
  }
  return { kind: 'other', writer: null };
}

async function checkpointDetails(
  git: AsyncGitRunner,
  root: string,
  commit: string,
): Promise<Pick<MissionCheckpointEntryView, 'kind' | 'writer' | 'changed'>> {
  const raw = await git.run(root, ['cat-file', 'commit', commit], { allowFailure: true });
  if (raw.status !== 0) return { kind: 'other', writer: null, changed: { files: [], total: 0 } };
  const separator = raw.stdout.indexOf('\n\n');
  const header = separator >= 0 ? raw.stdout.slice(0, separator) : raw.stdout;
  const body = separator >= 0 ? raw.stdout.slice(separator + 2) : '';
  const parent = header.split('\n').find((line) => line.startsWith('parent '))?.slice(7).trim();
  const diff = await git.run(
    root,
    [
      'diff-tree', '-r', '-z', '--no-renames', '--name-only', '--no-commit-id',
      ...(parent && OID.test(parent) ? [parent, commit] : ['--root', commit]),
    ],
    { allowFailure: true },
  );
  const files = diff.status === 0 ? diff.stdout.split('\0').filter(Boolean) : [];
  return { ...describeCommitMessage(body), changed: capped(files) };
}

async function currentBranch(git: AsyncGitRunner, root: string): Promise<string | null> {
  const head = await git.run(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true });
  const branch = head.stdout.trim();
  return head.status === 0 && branch.length > 0 ? branch : null;
}

async function listMissionCheckpointsForRenderer(
  scope: ProjectExecutionScope,
  missionId: string,
  deps: Pick<MissionCheckpointIpcDeps, 'git'> = {},
): Promise<MissionCheckpointListResult> {
  const git = deps.git ?? new AsyncProcessGitRunner();
  const roots = requireMissionRoots(scope, missionId);
  const scopes: MissionCheckpointScopeView[] = [];
  for (const target of roots) {
    let root: string;
    try {
      root = sealedCheckpointRoot(scope, target.root);
    } catch (error) {
      scopes.push({ root: target.root, branch: null, checkpoints: [], unavailable: message(error) });
      continue;
    }
    const listed = await listHiddenCheckpoints({ cwd: root, scopeId: target.scopeId }, { git });
    if (!listed.ok) {
      scopes.push({ root, branch: null, checkpoints: [], unavailable: listed.reason });
      continue;
    }
    const recent = listed.checkpoints.slice(-MAX_VIEW_CHECKPOINTS).reverse();
    const checkpoints: MissionCheckpointEntryView[] = [];
    for (const entry of recent) {
      checkpoints.push({
        ref: entry.ref,
        ordinal: entry.ordinal,
        createdAt: entry.createdAt * 1000,
        ...(await checkpointDetails(git, root, entry.commit)),
      });
    }
    scopes.push({ root, branch: await currentBranch(git, root), checkpoints });
  }
  return { ok: true, missionId, scopes };
}

async function previewMissionCheckpointForRenderer(
  scope: ProjectExecutionScope,
  input: { readonly missionId: string; readonly ref: string },
  deps: Pick<MissionCheckpointIpcDeps, 'git'> = {},
): Promise<MissionCheckpointPreviewResult> {
  const target = checkpointRootForRef(requireMissionRoots(scope, input.missionId), input.ref);
  const root = sealedCheckpointRoot(scope, target.root);
  const preview = await restoreHiddenCheckpoint(
    { cwd: root, scopeId: target.scopeId, ref: input.ref, apply: false, forbiddenRoot: scope.rootRealPath },
    deps.git ? { git: deps.git } : {},
  );
  if (!preview.ok) return { ok: false, error: `checkpoint: ${preview.reason}` };
  const fingerprint = await planFingerprint(root, input.ref, preview.commit, [...preview.overwrite, ...preview.create]);
  return { ok: true, fingerprint, ...planView(root, input.ref, preview) };
}

async function restoreMissionCheckpointForRenderer(
  scope: ProjectExecutionScope,
  input: { readonly missionId: string; readonly ref: string; readonly fingerprint: string },
  assertRendererCurrent: () => void,
  deps: Pick<MissionCheckpointIpcDeps, 'git'> = {},
): Promise<MissionCheckpointRestoreResult> {
  const target = checkpointRootForRef(requireMissionRoots(scope, input.missionId), input.ref);
  const root = sealedCheckpointRoot(scope, target.root);
  const mission = missionForCheckpointRestore(scope, input.missionId);
  assertCheckpointWritersIdle(undefined, root);
  const commit = await resolveCheckpointCommit(deps.git ?? new AsyncProcessGitRunner(), root, input.ref);
  if (!commit) return { ok: false, error: 'checkpoint: checkpoint-not-found' };
  let result: Awaited<ReturnType<typeof restoreHiddenCheckpoint>>;
  try {
    result = await restoreHiddenCheckpoint(
      {
        cwd: root,
        scopeId: target.scopeId,
        ref: input.ref,
        apply: true,
        forbiddenRoot: scope.rootRealPath,
        assertTargets: async (targets) => {
          // Dentro da fila da raiz e antes de qualquer escrita: o plano é o da prévia?
          if (await planFingerprint(root, input.ref, commit, targets) !== input.fingerprint) throw new StalePlanError();
          assertCheckpointRestoreTargets(scope, input.missionId, mission, targets);
        },
        assertCanWrite: () => {
          assertRendererCurrent();
          sealedCheckpointRoot(scope, root);
          assertCheckpointWritersIdle(undefined, root);
        },
      },
      deps.git ? { git: deps.git } : {},
    );
  } catch (error) {
    if (error instanceof StalePlanError) return { ok: false, error: CHECKPOINT_PLAN_CHANGED, stale: true };
    throw error;
  }
  if (!result.ok) return { ok: false, error: `checkpoint: ${result.reason}` };
  // A ref foi reapontada entre a resolução e a escrita (ordinal reescrito).
  if (result.applied && result.commit !== commit) {
    return { ok: false, error: `${CHECKPOINT_PLAN_CHANGED} (a ref passou a apontar outro commit; o estado anterior está em ${result.backup?.ref ?? 'um checkpoint novo'})` };
  }
  return {
    ok: true,
    applied: result.applied,
    backupRef: result.backup?.ref ?? null,
    ...planView(root, input.ref, result),
  };
}

export function registerMissionCheckpointIpc(deps: MissionCheckpointIpcDeps = {}): void {
  const handle = deps.handle ?? handleTrusted;
  const rendererScope = deps.rendererScope ?? requireLiveRendererWorkspaceScope;
  const gitDeps = deps.git ? { git: deps.git } : {};
  handle(ORCH_CHANNELS.missionCheckpointsList, async (event, raw: unknown): Promise<MissionCheckpointListResult> => {
    const parsed = listInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'pedido inválido' };
    try {
      return await listMissionCheckpointsForRenderer(rendererScope(event.sender), parsed.data.missionId, gitDeps);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  });
  handle(ORCH_CHANNELS.missionCheckpointPreview, async (event, raw: unknown): Promise<MissionCheckpointPreviewResult> => {
    const parsed = refInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'pedido inválido' };
    try {
      return await previewMissionCheckpointForRenderer(rendererScope(event.sender), parsed.data, gitDeps);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  });
  handle(ORCH_CHANNELS.missionCheckpointRestore, async (event, raw: unknown): Promise<MissionCheckpointRestoreResult> => {
    const parsed = restoreInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'pedido inválido' };
    try {
      const scope = rendererScope(event.sender);
      return await restoreMissionCheckpointForRenderer(
        scope,
        parsed.data,
        () => {
          rendererScope(event.sender, scope);
        },
        gitDeps,
      );
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  });
}
