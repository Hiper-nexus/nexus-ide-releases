/**
 * ORC-03 — fim do turno de um writer de missão vira checkpoint oculto.
 *
 * Os dois caminhos que fecham o turno de um worker (`nexus_handoff_submit`
 * pelo MCP e o fechamento pelo PTY/turn-end) chamam isto ANTES de persistir o
 * handoff, para a ref entrar no próprio registro como artifact
 * `nexus.checkpoint`. A árvore fotografada é a raiz de execução do worker
 * (worktree isolada ou da aba), nunca a raiz de coordenação. Ligado por
 * padrão; falha vira artifact `{ ok: false, reason }` e nunca derruba a entrega.
 *
 * Prazo global: o cliente do handoff espera ~45 s e o handler ainda roda o
 * portão de regressão e o Jev. A captura tem `HANDOFF_CHECKPOINT_DEADLINE_MS`
 * no total (fila da raiz + Git); estourou, o artifact diz `timeout` e a
 * captura em curso para sem publicar ref. A duração vai para o trace.
 */
import type { AgentGateContext } from './gate';
import { executionScopeFor } from './gate';
import {
  captureHiddenCheckpoint,
  type CheckpointCaptureResult,
  type HiddenCheckpointDeps,
} from '../git/hidden-checkpoint';
import { trace } from '../observability/main-trace';

export const HANDOFF_CHECKPOINT_ARTIFACT_KIND = 'nexus.checkpoint';
export const HANDOFF_CHECKPOINT_DEADLINE_MS = 10_000;
/** Folga para a captura em curso notar o prazo sozinha e responder `timeout`. */
const DEADLINE_GRACE_MS = 250;

/** Escopo = (missão, árvore): writers da mesma aba formam uma linha do tempo. */
export function missionCheckpointScopeId(missionId: string, executionRoot: string): string {
  return `nexus-mission:${missionId}\n${executionRoot}`;
}

type CheckpointGateContext = Pick<
  AgentGateContext,
  'role' | 'missionId' | 'readOnly' | 'scope' | 'executionScope' | 'sessionId' | 'agentName' | 'label'
>;

export interface HandoffCheckpointDeps extends HiddenCheckpointDeps {
  readonly deadlineMs?: number;
}

export async function captureWriterHandoffCheckpoint(
  ctx: CheckpointGateContext,
  deps: HandoffCheckpointDeps = {},
): Promise<{ readonly kind: string; readonly payload: Record<string, unknown> } | null> {
  if (ctx.role !== 'worker' || !ctx.missionId || ctx.readOnly === true) return null;
  const root = executionScopeFor(ctx).rootRealPath;
  if (root === ctx.scope.rootRealPath) return null;
  const deadlineMs = deps.deadlineMs ?? HANDOFF_CHECKPOINT_DEADLINE_MS;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: CheckpointCaptureResult;
  // F-1018: o prazo daqui também desiste da captura — uma ref publicada depois
  // do `timeout` (update-ref já em curso) é desfeita, não fica sem artifact.
  const abandon = new AbortController();
  try {
    const capture = captureHiddenCheckpoint({
      cwd: root,
      scopeId: missionCheckpointScopeId(ctx.missionId, root),
      forbiddenRoot: ctx.scope.rootRealPath,
      deadlineAt: startedAt + deadlineMs,
      signal: abandon.signal,
      note: [
        `Fim do turno do writer ${ctx.agentName ?? ctx.label}`,
        `Missão: ${ctx.missionId}`,
        ...(ctx.sessionId ? [`Sessão: ${ctx.sessionId}`] : []),
        `Raiz: ${root}`,
      ],
    }, deps.git ? { git: deps.git } : {});
    // Garante a resposta no prazo mesmo com a raiz presa na fila (restauração em curso).
    const expired = new Promise<CheckpointCaptureResult>((resolve) => {
      timer = setTimeout(() => {
        abandon.abort();
        resolve({ ok: false, reason: 'timeout' });
      }, deadlineMs + DEADLINE_GRACE_MS);
    });
    result = await Promise.race([capture, expired]);
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const elapsedMs = Date.now() - startedAt;
  trace({
    kind: 'handoff-checkpoint',
    status: result.ok ? (result.reused ? 'reused' : 'saved') : result.reason === 'timeout' ? 'timeout' : 'failed',
    elapsedMs,
    missionId: ctx.missionId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(result.ok ? { ref: result.ref } : { detail: result.reason.slice(0, 200) }),
  });
  if (!result.ok) console.warn(`[checkpoint] captura no fim do turno falhou (${elapsedMs} ms):`, result.reason);
  // Sem `reused` nem duração: a mesma árvore no replay exato do handoff precisa
  // gerar o MESMO artifact (o store compara artifacts do replay campo a campo).
  const payload: Record<string, unknown> = result.ok
    ? {
        ok: true,
        ref: result.ref,
        commit: result.commit,
        ordinal: result.ordinal,
        baseSha: result.baseSha,
        restore: `nexus_checkpoint_restore({ ref: "${result.ref}" })`,
      }
    : { ok: false, reason: result.reason };
  return { kind: HANDOFF_CHECKPOINT_ARTIFACT_KIND, payload };
}
