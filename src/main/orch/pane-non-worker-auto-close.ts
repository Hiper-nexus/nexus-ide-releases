/**
 * Pane guardian — auto-fechar panes ociosos (P1-4, paridade Bridge commit
 * 869c08f7; endurecido no F-572).
 *
 * Histórico: o módulo nasceu em 05/08 e NUNCA foi ligado no boot (só o teste
 * chamava initNonWorkerAutoClose). Em 16/09 um orquestrador sem missão abriu
 * 33 panes e fechou 6; ~25 workers sem missão ficaram parados depois de um
 * handoff recusado (F-565) e 22 panes × ~1 GB (CLI + servidores MCP filhos)
 * esgotaram a RAM de um Mac de 24 GB até o freeze. Nada no motor fechava um
 * pane que não estivesse fazendo nada. Este módulo é esse motor.
 *
 * Duas trilhas, o mesmo predicado de fechamento:
 * - trilha de eventos: status semântico idle/completed arma um timer de TTL
 *   (CLIs com hooks);
 * - varredura periódica: sessões idle no PTY que nunca emitiram status
 *   (CLIs sem hooks, pane parado num prompt de erro) contam o idle desde a
 *   primeira observação e fecham ao vencer o TTL.
 *
 * Fail-safe por construção:
 * - opt-out via feature.pane.nonWorkerAutoClose (default ON);
 * - nunca toca orquestradores nem workers COM missão (a missão governa);
 * - worker SEM missão é a classe órfã do F-565 e É elegível;
 * - re-avalia todas as condições ao armar E ao disparar;
 * - `isIdle` é o veto físico (awaiting-input/diálogo aberto nunca fecha);
 * - qualquer transição de busy cancela o timer e zera o relógio da varredura.
 */

import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getSessionState, tapSessionExit } from '../pty/pty-manager';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getPaneAuthzInfo,
  getPaneRuntimeAuthorityBySession,
  getPaneWokeAt,
  listPaneSnapshots,
  requestPaneClose,
  requestPanePark,
} from './pane-registry';
import { getAgentSessionInfo } from '../pty/pty-manager';
import { getAdapter } from '../adapters/adapter-registry';
import { isSessionInjectableIdle, tapAgentSemanticStatus } from './agent-status';
import { armedDeliveryContract } from './delivery-contract';
import {
  getCachedSystemMemory,
  isUnderMemoryPressure,
  readPaneAdmissionLimits,
  registerPaneAdmissionAdvisor,
} from './pane-admission';

/** 30 minutos de idle antes de auto-fechar um pane sem dono. */
export const NON_WORKER_AUTO_CLOSE_TTL_MS = 30 * 60_000;
/** Cadência da varredura de sessões idle no PTY. */
export const PANE_GUARDIAN_SWEEP_INTERVAL_MS = 60_000;

export interface NonWorkerPaneRef {
  readonly paneId: string;
  readonly sessionId: string;
  /** Undefined para panes sem contexto de missão. */
  readonly role: string | undefined;
  /** Missão que governa o pane; undefined = ninguém governa (classe órfã). */
  readonly missionId?: string;
  /**
   * Sessão do operador que abriu este pane por nexus_pane_spawn (mão do
   * operador). Ausente = pane aberto pelo humano no renderer ("+ Pane") —
   * esse nunca é fechado por ninguém além do humano.
   */
  readonly operatorParentSessionId?: string;
}

export interface NonWorkerAutoCloseDeps {
  readonly isEnabled: () => boolean;
  readonly getPaneRef: (sessionId: string) => NonWorkerPaneRef | null;
  readonly isIdle: (sessionId: string) => boolean;
  readonly closePane: (paneId: string) => Promise<boolean> | boolean;
  readonly ttlMs: number;
  readonly log: (message: string) => void;
  /**
   * Sessões de agente atualmente idle no PTY (F-572). Ausente = sem
   * varredura (só a trilha de eventos).
   */
  readonly listIdleSessions?: () => readonly string[];
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
  /** Contrato de entrega armado (`expect` do spawn) ainda por cumprir. */
  readonly hasPendingDelivery?: (sessionId: string) => boolean;
  /**
   * Registra o conselheiro do gate de admissão (quem NOMEIA os panes
   * ociosos). Mora aqui, e não no pty-ipc, para o pty-ipc não importar este
   * módulo — esse edge fechava um ciclo ESM na suíte (F-572).
   */
  readonly registerAdvisor?: () => void;
  /**
   * 0.76.44: a máquina já está sob pressão (mesmos limiares do gate de
   * spawn). Aí a varredura não espera o TTL: fecha um pane ocioso elegível
   * por tick, o mais parado primeiro.
   */
  readonly isUnderMemoryPressure?: () => boolean;
  /**
   * 0.76.45: estacionar em vez de fechar (CLI encerrado, pane fica com o
   * scrollback e "Acordar" por resume). Quando presente, tem precedência
   * sobre closePane; devolve false se não conseguiu (aí nada é fechado).
   */
  readonly parkPane?: (
    paneId: string,
    reason: 'idle' | 'memory-pressure',
  ) => Promise<'parked' | 'closed' | false> | 'parked' | 'closed' | false;
  /**
   * 0.76.45: há quanto tempo (ms) o pane desta sessão acordou de um
   * estacionamento; null = nunca. O reaper de emergência dá carência de
   * PANE_WAKE_GRACE_MS para não fazer ping-pong estaciona→acorda→estaciona.
   */
  readonly wokeAgoMs?: (sessionId: string) => number | null;
  /** 0.76.45: amostra de memória indisponível neste tick (gate cego). */
  readonly isMemorySampleMissing?: () => boolean;
}

/** Carência pós-acordar antes de o reaper de emergência poder estacionar de novo. */
export const PANE_WAKE_GRACE_MS = 5 * 60_000;
/** Ticks seguidos sem amostra de memória antes de avisar que o gate está cego. */
const MEMORY_SAMPLE_BLIND_TICKS = 3;

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
        missionId: authority.missionId,
        operatorParentSessionId: authority.operatorParentSessionId,
      };
    },
    isIdle: (sessionId) => isSessionInjectableIdle(sessionId),
    hasPendingDelivery: (sessionId) => armedDeliveryContract(sessionId) !== null,
    closePane: (paneId) => requestPaneClose(paneId),
    // 0.76.45: estacionar (pane fica, memória vai a zero); main-owned sem
    // renderer cai no fechamento dentro de requestPanePark.
    parkPane: (paneId, reason) => {
      // Adapter sem resume por id (ex.: aider) não tem como acordar com a
      // conversa: estacionar seria fechar com outro nome. Fecha de verdade.
      const sessionId = getPaneAuthzInfo(paneId)?.sessionId ?? null;
      const adapterId = sessionId ? getAgentSessionInfo(sessionId)?.adapterId : undefined;
      const adapter = adapterId ? getAdapter(adapterId) : null;
      const canResume =
        adapter?.kind === 'cli-pty' && (adapter.spawn.resumeIdArgs?.length ?? 0) > 0;
      if (!canResume) {
        return Promise.resolve(requestPaneClose(paneId)).then((closed) =>
          closed ? 'closed' : false,
        );
      }
      return requestPanePark(paneId, reason);
    },
    wokeAgoMs: (sessionId) => {
      const paneId = getPaneRuntimeAuthorityBySession(sessionId)?.paneId;
      const wokeAt = paneId ? getPaneWokeAt(paneId) : null;
      return wokeAt === null ? null : Date.now() - wokeAt;
    },
    ttlMs: NON_WORKER_AUTO_CLOSE_TTL_MS,
    log: (message) => console.warn(`[pane-guardian] ${message}`),
    listIdleSessions: () =>
      listPaneSnapshots()
        .filter(
          (pane) =>
            pane.kind === 'cli-agent' &&
            typeof pane.sessionId === 'string' &&
            getSessionState(pane.sessionId) === 'idle',
        )
        .map((pane) => pane.sessionId as string),
    sweepIntervalMs: PANE_GUARDIAN_SWEEP_INTERVAL_MS,
    // A amostra em cache vence em 5 s e se renova sozinha: cada tick da
    // varredura (60 s) enxerga a memória de agora, não a do boot.
    isUnderMemoryPressure: () =>
      isUnderMemoryPressure(getCachedSystemMemory(), readPaneAdmissionLimits()),
    isMemorySampleMissing: () => getCachedSystemMemory() === null,
    registerAdvisor: () =>
      registerPaneAdmissionAdvisor({
        idleCandidates: (now) =>
          listPaneSnapshots()
            .filter(
              (pane) =>
                pane.kind === 'cli-agent' &&
                pane.state === 'idle' &&
                pane.role !== 'orchestrator',
            )
            .map((pane) => ({
              paneId: pane.paneId,
              paneNumber: pane.paneNumber,
              title: pane.title,
              idleForMs: pane.sessionId ? getGuardianIdleForMs(pane.sessionId, now) : 0,
            })),
      }),
  };
}

/**
 * Quem pode ser fechado sem dono:
 * - worker SEM missão (classe órfã do F-565);
 * - pane sem papel aberto pela MÃO DO OPERADOR via nexus_pane_spawn
 *   (tem operatorParentSessionId) — um helper esquecido.
 * Nunca: orquestrador, worker de missão, ou pane aberto pelo humano no
 * renderer (sem pai) — esse é a própria mão do operador, mesmo ocioso.
 */
export function isGuardianEligiblePane(ref: NonWorkerPaneRef): boolean {
  if (ref.role === 'orchestrator') return false;
  if (ref.role === 'worker') return ref.missionId === undefined;
  return ref.operatorParentSessionId !== undefined;
}

function paneIsClosable(
  deps: NonWorkerAutoCloseDeps,
  sessionId: string,
): NonWorkerPaneRef | null {
  if (!deps.isEnabled()) return null;
  if (!deps.isIdle(sessionId)) return null;
  if (deps.hasPendingDelivery?.(sessionId)) return null;
  const ref = deps.getPaneRef(sessionId);
  if (!ref) return null;
  if (!isGuardianEligiblePane(ref)) return null;
  return ref;
}

const armed = new Map<string, ReturnType<typeof setTimeout>>();
/** Varredura (F-572): quando cada sessão foi vista idle pela primeira vez. */
const idleSince = new Map<string, number>();
/** Sessões cujo fechamento já foi pedido; evita pedir duas vezes por tick. */
const closing = new Set<string>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let blindTicks = 0;
let untapStatus: (() => void) | null = null;
let untapExit: (() => void) | null = null;

function cancelTimer(sessionId: string): void {
  const timer = armed.get(sessionId);
  if (timer) clearTimeout(timer);
  armed.delete(sessionId);
}

function closeIdlePane(
  deps: NonWorkerAutoCloseDeps,
  ref: NonWorkerPaneRef,
  sessionId: string,
  trail: 'evento' | 'varredura',
  reason: 'idle' | 'memory-pressure' = 'idle',
): void {
  if (closing.has(sessionId)) return;
  closing.add(sessionId);
  const verb = deps.parkPane ? 'estacionando' : 'encerrando';
  deps.log(
    `${verb} pane ocioso sem dono via ${trail} (${reason}) ` +
      `(pane=${ref.paneId}, session=${sessionId}, role=${ref.role ?? 'none'})`,
  );
  const outcome: Promise<'parked' | 'closed' | boolean> = deps.parkPane
    ? Promise.resolve(deps.parkPane(ref.paneId, reason))
    : Promise.resolve(deps.closePane(ref.paneId));
  void outcome.then(
    (closed) => {
      closing.delete(sessionId);
      if (!closed) {
        deps.log(
          `fechamento recusado pela autoridade do pane ` +
            `(pane=${ref.paneId}, session=${sessionId})`,
        );
      }
    },
    (error) => {
      closing.delete(sessionId);
      deps.log(
        `falha ao encerrar pane ocioso (session=${sessionId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );
}

function armTimer(deps: NonWorkerAutoCloseDeps, sessionId: string): void {
  if (armed.has(sessionId)) return;
  const timer = setTimeout(() => {
    armed.delete(sessionId);
    const ref = paneIsClosable(deps, sessionId);
    if (!ref) return;
    closeIdlePane(deps, ref, sessionId, 'evento');
  }, deps.ttlMs);
  if (typeof timer.unref === 'function') timer.unref();
  armed.set(sessionId, timer);
}

/**
 * Um tick da varredura: quem está idle no PTY começa a contar; quem saiu do
 * idle zera; quem venceu o TTL e continua elegível fecha. Exportado para o
 * teste e para o doctor poderem forçar um tick.
 */
export function sweepIdlePanes(deps: NonWorkerAutoCloseDeps): void {
  const list = deps.listIdleSessions;
  if (!list) return;
  const now = (deps.now ?? Date.now)();
  if (deps.isMemorySampleMissing?.()) {
    blindTicks += 1;
    if (blindTicks === MEMORY_SAMPLE_BLIND_TICKS) {
      deps.log(
        'sem amostra de memória há ' + blindTicks + ' varreduras: o gate de pressão está cego ' +
          '(só o aviso de teto vale); verifique process.getSystemMemoryInfo/sysctl',
      );
    }
  } else {
    blindTicks = 0;
  }
  const idleNow = new Set(list());
  for (const sessionId of [...idleSince.keys()]) {
    if (!idleNow.has(sessionId)) idleSince.delete(sessionId);
  }
  for (const sessionId of idleNow) {
    const since = idleSince.get(sessionId);
    if (since === undefined) {
      idleSince.set(sessionId, now);
      continue;
    }
    if (now - since < deps.ttlMs) continue;
    const ref = paneIsClosable(deps, sessionId);
    if (!ref) continue;
    closeIdlePane(deps, ref, sessionId, 'varredura');
  }
  // 0.76.44 — reaper de emergência: com a máquina sob pressão (mesmos
  // limiares do gate de spawn), não espera o TTL. Fecha UM pane ocioso
  // elegível por tick, o mais parado primeiro; os vetos (orquestrador, worker
  // de missão, pane do humano, entrega armada, awaiting-input) continuam.
  if (deps.isUnderMemoryPressure?.()) {
    const oldestFirst = [...idleSince.entries()]
      .filter(([sessionId]) => idleNow.has(sessionId) && !closing.has(sessionId))
      .sort((a, b) => a[1] - b[1]);
    for (const [sessionId] of oldestFirst) {
      const wokeAgo = deps.wokeAgoMs?.(sessionId);
      if (wokeAgo !== null && wokeAgo !== undefined && wokeAgo < PANE_WAKE_GRACE_MS) continue;
      const ref = paneIsClosable(deps, sessionId);
      if (!ref) continue;
      deps.log(
        `pressão de memória: fechando o pane ocioso mais antigo sem esperar o TTL ` +
          `(pane=${ref.paneId}, ocioso há ${Math.round((now - (idleSince.get(sessionId) ?? now)) / 1000)} s)`,
      );
      closeIdlePane(deps, ref, sessionId, 'varredura', 'memory-pressure');
      break;
    }
  }
}

/** Há quanto tempo a varredura vê esta sessão idle (0 = nunca vista idle). */
export function getGuardianIdleForMs(sessionId: string, now = Date.now()): number {
  const since = idleSince.get(sessionId);
  return since === undefined ? 0 : Math.max(0, now - since);
}

export function initNonWorkerAutoClose(
  deps: NonWorkerAutoCloseDeps = productionDeps(),
): void {
  if (untapStatus) return;
  deps.registerAdvisor?.();
  untapStatus = tapAgentSemanticStatus((entry) => {
    if (entry.status === 'idle' || entry.status === 'completed') {
      if (paneIsClosable(deps, entry.sessionId)) {
        armTimer(deps, entry.sessionId);
      }
      return;
    }
    cancelTimer(entry.sessionId);
    idleSince.delete(entry.sessionId);
  });
  untapExit = tapSessionExit((sessionId) => {
    cancelTimer(sessionId);
    idleSince.delete(sessionId);
    closing.delete(sessionId);
  });
  if (deps.listIdleSessions) {
    const interval = deps.sweepIntervalMs ?? PANE_GUARDIAN_SWEEP_INTERVAL_MS;
    sweepTimer = setInterval(() => sweepIdlePanes(deps), interval);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }
}

export function shutdownNonWorkerAutoClose(): void {
  untapStatus?.();
  untapStatus = null;
  untapExit?.();
  untapExit = null;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  for (const sessionId of [...armed.keys()]) cancelTimer(sessionId);
  idleSince.clear();
  closing.clear();
  blindTicks = 0;
}
