/**
 * ORC-03 — listar e restaurar, de forma explícita, os checkpoints ocultos que
 * o Nexus grava no fim de cada turno de writer de missão (handoff-checkpoint).
 *
 * Autoridade: só dentro de uma missão. O worker enxerga a própria raiz de
 * execução; o orquestrador, as raízes de execução da missão (aba e worktrees
 * do registro do Main). A árvore alvo sai sempre dessa lista — a ref só
 * escolhe entre elas pelo hash do escopo —, nunca de argumento ou caminho, e a
 * raiz de coordenação nunca entra. `nexus_checkpoint_list` é leitura;
 * `nexus_checkpoint_restore` é efeito de missão (confirmação, fora de read-only).
 */
import { executionScopeFor, type AgentGateContext } from './gate';
import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import { requireStr, str } from './tool-util';
import { getProjectDomainStores } from './project-domain-store-registry';
import { missionExecutionScope } from './mission-execution-scope';
import { missionCheckpointScopeId } from './handoff-checkpoint';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import {
  checkpointScopeKey,
  listHiddenCheckpoints,
  parseCheckpointRef,
  restoreHiddenCheckpoint,
} from '../git/hidden-checkpoint';

const MAX_LISTED_FILES = 200;

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
      const preview = await restoreHiddenCheckpoint({ cwd: target.root, scopeId: target.scopeId, ref, apply: false });
      if (!preview.ok) throw new Error(`checkpoint: ${preview.reason}`);
      return {
        root: target.root,
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
      const listed = await listHiddenCheckpoints({ cwd: target.root, scopeId: target.scopeId });
      scopes.push(listed.ok
        ? {
            root: target.root,
            checkpoints: listed.checkpoints,
            ...(listed.removedEmptyRefs.length > 0 ? { removedEmptyRefs: listed.removedEmptyRefs } : {}),
          }
        : { root: target.root, unavailable: listed.reason });
    }
    return { missionId: ctx.missionId, scopes };
  },
};

const checkpointRestore: McpToolDef = {
  name: 'nexus_checkpoint_restore',
  description:
    'Explicitly restore the files of a hidden checkpoint (from nexus_checkpoint_list) into the ' +
    'execution worktree it was captured from. Saves the current tree as a new checkpoint first, ' +
    'overwrites/creates only files present in the checkpoint, never deletes files, and never ' +
    'touches HEAD, branch or the index. Run nexus_checkpoint_list with ref first to see what it overwrites; ' +
    'only while the writer of that worktree is idle.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Checkpoint ref (refs/nexus-checkpoint/<32 hex>/ordinal/<n>).' },
    },
    required: ['ref'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.readOnly === true) throw new Error('checkpoint: sessão read-only não restaura arquivos');
    const ref = requireStr(args, 'ref');
    const target = rootForRef(missionCheckpointRoots(ctx), ref);
    const result = await restoreHiddenCheckpoint({
      cwd: target.root,
      scopeId: target.scopeId,
      ref,
      apply: true,
      beforeWrite: () => assertMcpInvocationCurrent(invocation),
    });
    if (!result.ok) throw new Error(`checkpoint: ${result.reason}`);
    return {
      root: target.root,
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
