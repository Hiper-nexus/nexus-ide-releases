/**
 * Auto-fechar panes não-worker idle (P1-4, paridade Bridge commit 869c08f7).
 *
 * Panes spawados manualmente pelo usuário ou por agentes de ferramenta (sem
 * role de missão) são encerrados após ficarem idle por NON_WORKER_AUTO_CLOSE_TTL_MS.
 * O primitivo de detecção de idle é o mesmo do worker-handoff-ttl (isIdle +
 * tapAgentSemanticStatus), reutilizado sem reimplementação.
 *
 * Fail-safe por construção:
 * - opt-out via feature.pane.nonWorkerAutoClose (default ON);
 * - nunca toca panes com role 'worker' ou 'orchestrator';
 * - re-avalia todas as condições ao armar E ao disparar;
 * - qualquer transição de busy cancela o timer.
 */

import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { tapSessionExit } from '../pty/pty-manager';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getPaneRuntimeAuthorityBySession,
  requestPaneClose,
} from './pane-registry';
import { isSessionInjectableIdle, tapAgentSemanticStatus } from './agent-status';

/** 5 minutos de idle antes de auto-fechar um pane não-worker. */
export const NON_WORKER_AUTO_CLOSE_TTL_MS = 300_000;

export interface NonWorkerPaneRef {
  readonly paneId: string;
  readonly sessionId: string;
  /** Undefined para panes sem contexto de missão. */
  readonly role: string | undefined;
}

export interface NonWorkerAutoCloseDeps {
  readonly isEnabled: () => boolean;
  readonly getPaneRef: (sessionId: string) => NonWorkerPaneRef | null;
  readonly isIdle: (sessionId: string) => boolean;
  readonly closePane: (paneId: string) => Promise<boolean> | boolean;
  readonly ttlMs: number;
  readonly log: (message: string) => void;
}

function productionDeps(): NonWorkerAutoCloseDeps {
  return {
    isEnabled: () =>
      getFeatureFlagRegistry().isEnabled(
        FEATURE_FLAG_IDS.paneNonWorkerAutoClose,
      ),
    getPaneRef: (sessionId) => {
      const authority = getPaneRuntimeAuthorityBySession(sessionId);
      if (!authority) return null;
      return {
        paneId: authority.paneId,
        sessionId: authority.sessionId ?? sessionId,
        role: authority.role,
      };
    },
    isIdle: (sessionId) => isSessionInjectableIdle(sessionId),
    closePane: (paneId) => requestPaneClose(paneId),
    ttlMs: NON_WORKER_AUTO_CLOSE_TTL_MS,
    log: (message) => console.warn(`[pane-non-worker-auto-close] ${message}`),
  };
}

function paneIsClosable(
  deps: NonWorkerAutoCloseDeps,
  sessionId: string,
): NonWorkerPaneRef | null {
  if (!deps.isEnabled()) return null;
  if (!deps.isIdle(sessionId)) return null;
  const ref = deps.getPaneRef(sessionId);
  if (!ref) return null;
  if (ref.role === 'worker' || ref.role === 'orchestrator') return null;
  return ref;
}

const armed = new Map<string, ReturnType<typeof setTimeout>>();
let untapStatus: (() => void) | null = null;
let untapExit: (() => void) | null = null;

function cancelTimer(sessionId: string): void {
  const timer = armed.get(sessionId);
  if (timer) clearTimeout(timer);
  armed.delete(sessionId);
}

function armTimer(deps: NonWorkerAutoCloseDeps, sessionId: string): void {
  if (armed.has(sessionId)) return;
  const timer = setTimeout(() => {
    armed.delete(sessionId);
    const ref = paneIsClosable(deps, sessionId);
    if (!ref) return;
    deps.log(
      `encerrando pane não-worker idle ` +
        `(pane=${ref.paneId}, session=${sessionId})`,
    );
    void Promise.resolve(deps.closePane(ref.paneId)).then(
      (closed) => {
        if (!closed) {
          deps.log(
            `fechamento recusado pela autoridade do pane ` +
              `(pane=${ref.paneId}, session=${sessionId})`,
          );
        }
      },
      (error) => {
        deps.log(
          `falha ao encerrar pane não-worker (session=${sessionId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  }, deps.ttlMs);
  if (typeof timer.unref === 'function') timer.unref();
  armed.set(sessionId, timer);
}

export function initNonWorkerAutoClose(
  deps: NonWorkerAutoCloseDeps = productionDeps(),
): void {
  if (untapStatus) return;
  untapStatus = tapAgentSemanticStatus((entry) => {
    if (entry.status === 'idle' || entry.status === 'completed') {
      if (paneIsClosable(deps, entry.sessionId)) {
        armTimer(deps, entry.sessionId);
      }
      return;
    }
    cancelTimer(entry.sessionId);
  });
  untapExit = tapSessionExit((sessionId) => {
    cancelTimer(sessionId);
  });
}

export function shutdownNonWorkerAutoClose(): void {
  untapStatus?.();
  untapStatus = null;
  untapExit?.();
  untapExit = null;
  for (const sessionId of [...armed.keys()]) cancelTimer(sessionId);
}
