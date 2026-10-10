/**
 * ORC-03 — listar e restaurar, de forma explícita, os checkpoints ocultos que
 * o Nexus grava no fim de cada turno de writer de missão (handoff-checkpoint).
 *
 * Autoridade: só dentro de uma missão. O worker enxerga a própria raiz de
 * execução; o orquestrador, as raízes de execução da missão (aba e worktrees
 * do registro do Main). A árvore alvo sai sempre dessa lista — a ref só
 * escolhe entre elas pelo hash do escopo —, nunca de argumento ou caminho.
 *
 * A raiz é SELADA (resolveRootForScope: caminho real = caminho autorizado,
 * nunca a coordenação, por caminho nem por inode) e revalidada antes de cada
 * mutação, junto com a autoridade do chamador e o writer ocioso. Todos os
 * destinos calculados pelo Git passam pelas guardas de .context (autoridade
 * de workflow), .agents/.codex e plano antes de qualquer escrita.
 * `nexus_checkpoint_list` é leitura; `nexus_checkpoint_restore` é
 * execution-effect (confirmação, estágio de execução, fora de read-only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { executionScopeFor, getContextBySession, type AgentGateContext } from './gate';
import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import { requireStr, str } from './tool-util';
import { getProjectDomainStores } from './project-domain-store-registry';
import { missionExecutionScope } from './mission-execution-scope';
import { missionCheckpointScopeId } from './handoff-checkpoint';
import { isInsidePath, resolveRootForScope } from './workspace-path';
import {
  assertGovernedWorkspaceControlBoundary,
  pathTargetsCodexControlRoot,
} from './governed-workspace-control-boundary';
import { resolveProductionWorkflowAuthority } from './mcp-dispatch';
import { isSessionInjectableIdle } from './agent-status';
import { listAgentSessions } from '../pty/pty-manager';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { isPlanLane, isPlanLaneWritablePath } from '../../shared/mission-intent';
import {
  checkpointScopeKey,
  listHiddenCheckpoints,
  parseCheckpointRef,
  restoreHiddenCheckpoint,
} from '../git/hidden-checkpoint';

const MAX_LISTED_FILES = 200;
const RESTORE_TOOL = 'nexus_checkpoint_restore';

interface CheckpointRoot {
  readonly root: string;
  readonly scopeId: string;
  readonly scopeKey: string;
}

/** Raízes de execução da missão pela autoridade do Main, nunca por argumento. */
export function missionCheckpointRoots(ctx: AgentGateContext): CheckpointRoot[] {
  const missionId = ctx.missionId;
  if (!missionId) {
    throw new Error('checkpoint: disponível só dentro de uma missão (o Nexus grava um por turno de writer da missão)');
  }
  const roots = new Set<string>();
  if (ctx.role === 'worker') {
    roots.add(executionScopeFor(ctx).rootRealPath);
  } else if (ctx.role === 'orchestrator') {
    try {
      const mission = getProjectDomainStores(ctx.scope).missions.get(missionId);
      if (mission) roots.add(missionExecutionScope(ctx.scope, mission).rootRealPath);
    } catch (error) {
      console.warn('[checkpoint] raiz de execução da missão indisponível:', error);
    }
    try {
      for (const record of requireWorktreeRuntimeRegistry().listMission(ctx.scope, missionId)) {
        roots.add(record.worktreePath);
      }
    } catch (error) {
      console.warn('[checkpoint] registro de worktrees indisponível:', error);
    }
  } else {
    throw new Error('checkpoint: só o orquestrador ou um worker da missão');
  }
  roots.delete(ctx.scope.rootRealPath);
  return [...roots].sort().map((root) => {
    const scopeId = missionCheckpointScopeId(missionId, root);
    return { root, scopeId, scopeKey: checkpointScopeKey(scopeId) };
  });
}

/**
 * Raiz selada: `resolveRootForScope` recusa caminho cujo real difere do
 * autorizado (symlink trocado) e o inode da coordenação nunca passa.
 */
function sealedExecutionRoot(ctx: AgentGateContext, root: string): string {
  const sealed = resolveRootForScope({ ...ctx.scope, rootRealPath: root });
  const coordination = fs.statSync(ctx.scope.rootRealPath);
  const target = fs.statSync(sealed);
  if (sealed === path.resolve(ctx.scope.rootRealPath) ||
      (target.dev === coordination.dev && target.ino === coordination.ino)) {
    throw new Error('checkpoint: a raiz de coordenação nunca é restaurada');
  }
  return sealed;
}

/** Sessões que escrevem nesta árvore e não estão ociosas (estado real do PTY + hook). */
function busyWriters(ctx: AgentGateContext, root: string): string[] {
  return listAgentSessions()
    .filter((info) =>
      info.sessionId !== ctx.sessionId &&
      // F-1157: só a lane que o Hardened confina à leitura não escreve.
      getContextBySession(info.sessionId)?.readOnlyEnforced !== true &&
      (info.scope?.rootRealPath === root || (typeof info.cwd === 'string' && isInsidePath(root, info.cwd))) &&
      !isSessionInjectableIdle(info.sessionId))
    .map((info) => info.agentName ?? info.sessionId);
}

function assertWritersIdle(ctx: AgentGateContext, root: string): void {
  const busy = busyWriters(ctx, root);
  if (busy.length > 0) {
    throw new Error(
      `checkpoint: writer ocupado na árvore ${root} (${busy.join(', ')}); restaurar agora perderia o que ele ` +
        'está escrevendo. Espere o turno terminar (nexus_pane_wait_idle) e repita.',
    );
  }
}

function missionForRestore(ctx: AgentGateContext): Parameters<typeof isPlanLane>[0] {
  try {
    const mission = getProjectDomainStores(ctx.scope).missions.get(ctx.missionId!);
    if (mission) return mission;
  } catch (error) {
    throw new Error('mission authority unavailable; checkpoint restore denied', { cause: error });
  }
  throw new Error('mission authority unavailable; checkpoint restore denied');
}

/** Todos os destinos pelas guardas existentes, antes de qualquer escrita. */
function assertRestoreTargets(
  ctx: AgentGateContext,
  mission: Parameters<typeof isPlanLane>[0],
  targets: readonly string[],
): void {
  const control = targets.find(pathTargetsCodexControlRoot);
  if (control) {
    throw new Error(`checkpoint: restauração recusada em namespace protegido (.agents/.codex): ${control}`);
  }
  assertGovernedWorkspaceControlBoundary(ctx, RESTORE_TOOL, targets);
  const authority = resolveProductionWorkflowAuthority(ctx.scope, ctx.missionId!);
  for (const target of targets) {
    authority.assertExecutionEffectAllowed(RESTORE_TOOL, { path: target }, ctx.readOnlyEnforced === true);
  }
  if (isPlanLane(mission)) {
    const outside = targets.find((target) => !isPlanLaneWritablePath(target));
    if (outside) throw new Error(`plan lane denies write to ${outside}; only plan.md or docs/plan.md`);
  }
}

function rootForRef(roots: readonly CheckpointRoot[], ref: string): CheckpointRoot {
  const parsed = parseCheckpointRef(ref);
  if (!parsed) {
    throw new Error('checkpoint: ref inválida — use uma ref de nexus_checkpoint_list (refs/nexus-checkpoint/<32 hex>/ordinal/<n>)');
  }
  const target = roots.find((candidate) => candidate.scopeKey === parsed.scopeKey);
  if (!target) throw new Error('checkpoint: esta ref não pertence a uma árvore de execução desta missão');
  return target;
}

function capped(files: readonly string[]): { readonly files: readonly string[]; readonly total: number } {
  return { files: files.slice(0, MAX_LISTED_FILES), total: files.length };
}

const checkpointList: McpToolDef = {
  name: 'nexus_checkpoint_list',
  description:
    'List the hidden checkpoints Nexus captured at the end of each mission writer turn ' +
    '(refs/nexus-checkpoint/…, never a branch; HEAD and index untouched). ' +
    'Pass ref to preview exactly which files nexus_checkpoint_restore would overwrite or create. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Checkpoint ref to preview (from a previous list).' },
    },
  },
  handler: async (args, ctx) => {
    const roots = missionCheckpointRoots(ctx);
    const ref = str(args, 'ref');
    if (ref) {
      const target = rootForRef(roots, ref);
      const root = sealedExecutionRoot(ctx, target.root);
      const preview = await restoreHiddenCheckpoint({
        cwd: root, scopeId: target.scopeId, ref, apply: false, forbiddenRoot: ctx.scope.rootRealPath,
      });
      if (!preview.ok) throw new Error(`checkpoint: ${preview.reason}`);
      return {
        root,
        ref,
        commit: preview.commit,
        wouldOverwrite: capped(preview.overwrite),
        wouldCreate: capped(preview.create),
        keptExtra: capped(preview.keptExtra),
        conflicts: capped(preview.conflicts),
        note: 'Prévia: nada foi escrito. A restauração guarda o estado atual como checkpoint novo antes de escrever e nunca apaga arquivos.',
      };
    }
    const scopes = [];
    for (const target of roots) {
      let root: string;
      try {
        root = sealedExecutionRoot(ctx, target.root);
      } catch (error) {
        scopes.push({ root: target.root, unavailable: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const listed = await listHiddenCheckpoints({ cwd: root, scopeId: target.scopeId });
      scopes.push(listed.ok
        ? {
            root,
            checkpoints: listed.checkpoints,
            ...(listed.removedEmptyRefs.length > 0 ? { removedEmptyRefs: listed.removedEmptyRefs } : {}),
          }
        : { root, unavailable: listed.reason });
    }
    return { missionId: ctx.missionId, scopes };
  },
};

const checkpointRestore: McpToolDef = {
  name: RESTORE_TOOL,
  description:
    'Explicitly restore the files of a hidden checkpoint (from nexus_checkpoint_list) into the ' +
    'execution worktree it was captured from. Refused while a writer of that worktree is busy. ' +
    'Saves the current tree as a new checkpoint first, overwrites/creates only files present in ' +
    'the checkpoint (never .context, .agents or .codex), never deletes files, and never touches ' +
    'HEAD, branch or the index. Run nexus_checkpoint_list with ref first to see what it overwrites.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Checkpoint ref (refs/nexus-checkpoint/<32 hex>/ordinal/<n>).' },
    },
    required: ['ref'],
  },
  handler: async (args, ctx, invocation) => {
    // F-1157: só a lane que o Hardened confina à leitura não restaura.
    if (ctx.readOnlyEnforced === true) throw new Error('checkpoint: sessão read-only (Hardened) não restaura arquivos');
    const ref = requireStr(args, 'ref');
    const target = rootForRef(missionCheckpointRoots(ctx), ref);
    const root = sealedExecutionRoot(ctx, target.root);
    const mission = missionForRestore(ctx);
    assertWritersIdle(ctx, root);
    // A exclusividade da raiz (captura + aplicação) é da fila serializada do
    // hidden-checkpoint; o writer ocioso e a autoridade são conferidos de novo
    // antes do backup, depois dele e antes de cada lote escrito.
    const result = await restoreHiddenCheckpoint({
      cwd: root,
      scopeId: target.scopeId,
      ref,
      apply: true,
      forbiddenRoot: ctx.scope.rootRealPath,
      assertTargets: (targets) => assertRestoreTargets(ctx, mission, targets),
      assertCanWrite: () => {
        assertMcpInvocationCurrent(invocation);
        sealedExecutionRoot(ctx, root);
        assertWritersIdle(ctx, root);
      },
    });
    if (!result.ok) throw new Error(`checkpoint: ${result.reason}`);
    return {
      root,
      ref,
      commit: result.commit,
      applied: result.applied,
      overwritten: capped(result.overwrite),
      created: capped(result.create),
      keptExtra: capped(result.keptExtra),
      conflicts: capped(result.conflicts),
      ...(result.backup ? { backupRef: result.backup.ref, backupCommit: result.backup.commit } : {}),
    };
  },
};

export function buildCheckpointTools(): McpToolDef[] {
  return [checkpointList, checkpointRestore];
}
