/**
 * ORC-03 — fim do turno de um writer de missão vira checkpoint oculto.
 *
 * Os dois caminhos que fecham o turno de um worker (`nexus_handoff_submit`
 * pelo MCP e o fechamento pelo PTY/turn-end) chamam isto ANTES de persistir o
 * handoff, para a ref entrar no próprio registro como artifact
 * `nexus.checkpoint`. A árvore fotografada é a raiz de execução do worker
 * (worktree isolada ou da aba), nunca a raiz de coordenação. Ligado por
 * padrão; falha vira artifact `{ ok: false, reason }` e nunca derruba a entrega.
 */
import type { AgentGateContext } from './gate';
import { executionScopeFor } from './gate';
import {
  captureHiddenCheckpoint,
  type HiddenCheckpointDeps,
} from '../git/hidden-checkpoint';

export const HANDOFF_CHECKPOINT_ARTIFACT_KIND = 'nexus.checkpoint';

/** Escopo = (missão, árvore): writers da mesma aba formam uma linha do tempo. */
export function missionCheckpointScopeId(missionId: string, executionRoot: string): string {
  return `nexus-mission:${missionId}\n${executionRoot}`;
}

type CheckpointGateContext = Pick<
  AgentGateContext,
  'role' | 'missionId' | 'readOnly' | 'scope' | 'executionScope' | 'sessionId' | 'agentName' | 'label'
>;

export async function captureWriterHandoffCheckpoint(
  ctx: CheckpointGateContext,
  deps: HiddenCheckpointDeps = {},
): Promise<{ readonly kind: string; readonly payload: Record<string, unknown> } | null> {
  if (ctx.role !== 'worker' || !ctx.missionId || ctx.readOnly === true) return null;
  const root = executionScopeFor(ctx).rootRealPath;
  if (root === ctx.scope.rootRealPath) return null;
  let payload: Record<string, unknown>;
  try {
    const result = await captureHiddenCheckpoint({
      cwd: root,
      scopeId: missionCheckpointScopeId(ctx.missionId, root),
      note: [
        `Fim do turno do writer ${ctx.agentName ?? ctx.label}`,
        `Missão: ${ctx.missionId}`,
        ...(ctx.sessionId ? [`Sessão: ${ctx.sessionId}`] : []),
        `Raiz: ${root}`,
      ],
    }, deps);
    // Sem `reused`: a mesma árvore no replay exato do handoff precisa gerar o
    // MESMO artifact (o store compara artifacts do replay campo a campo).
    payload = result.ok
      ? {
          ok: true,
          ref: result.ref,
          commit: result.commit,
          ordinal: result.ordinal,
          baseSha: result.baseSha,
          restore: `nexus_checkpoint_restore({ ref: "${result.ref}" })`,
        }
      : { ok: false, reason: result.reason };
  } catch (error) {
    payload = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (payload.ok !== true) {
    console.warn('[checkpoint] captura no fim do turno falhou:', payload.reason);
  }
  return { kind: HANDOFF_CHECKPOINT_ARTIFACT_KIND, payload };
}
