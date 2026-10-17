import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
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
import {
  isSessionIdleForCleanup,
  isSessionInAbandonedDialog,
  tapAgentSemanticStatus,
} from './agent-status';
import { getContextBySession } from './gate';
import { getProjectDomainStores } from './project-domain-store-registry';
import { armedDeliveryContract } from './delivery-contract';
import {
  getCachedSystemMemory,
  isUnderMemoryPressure,
  readPaneAdmissionLimits,
  registerPaneAdmissionAdvisor,
  type IdlePaneCandidate,
} from './pane-admission';
import { paneSessionLastOutputAt } from './pane-session-output';
import type { PaneSnapshot } from '../../shared/orch-types';

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
  /** Diálogo sem resposta há muito tempo num PTY parado (ver agent-status). */
  readonly isAbandonedDialog?: (sessionId: string) => boolean;
  /** A sessão já entregou um handoff de sucesso. */
  readonly hasDeliveredSuccess?: (sessionId: string) => boolean;
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
  /**
   * 0.76.45: amostra de memória indisponível neste tick (gate cego).
   */
  readonly isMemorySampleMissing?: () => boolean;
  /**
   * Otimização multi-pane (06/10): pressão severa (livre < 60 % do mínimo)
   * estaciona até 4 panes por tick. Ausente = pressão moderada (até 2).
   */
  readonly isSevereMemoryPressure?: () => boolean;
  /**
   * 16/10: pressão crítica (livre < 30 % do mínimo OU swap acima do teto que
   * a máquina armou) estaciona até 6 panes por tick — o degrau mais agressivo
   * do reaper de emergência. Ausente = nunca crítica.
   */
  readonly isCriticalMemoryPressure?: () => boolean;
}

/** Carência pós-acordar antes de o reaper de emergência poder estacionar de novo. */
export const PANE_WAKE_GRACE_MS = 5 * 60_000;
/** Ticks seguidos sem amostra de memória antes de avisar que o gate está cego. */
const MEMORY_SAMPLE_BLIND_TICKS = 3;
/**
 * Otimização multi-pane (06/10, 16/10): sob pressão o reaper estaciona vários
 * panes ociosos por tick, não apenas um. Um pane por minuto não drena RAM
 * rápido o suficiente quando 4-6 CLIs + validadores já empurraram a máquina
 * para o swap — o freeze acontece antes do segundo tick. Três degraus:
 * - moderada (livre < minFreeMB): 2 por tick;
 * - severa (livre < 60 % do mínimo): 4 por tick;
 * - crítica (livre < 30 % do mínimo OU swap alto): 6 por tick.
 */
const MODERATE_PRESSURE_PARKS_PER_TICK = 2;
const SEVERE_PRESSURE_PARKS_PER_TICK = 4;
const CRITICAL_PRESSURE_PARKS_PER_TICK = 6;
/** Fração do mínimo livre abaixo da qual a pressão é considerada severa. */
const SEVERE_PRESSURE_RATIO = 0.6;
/** Fração do mínimo livre abaixo da qual a pressão é considerada crítica. */
const CRITICAL_PRESSURE_RATIO = 0.3;

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
    isIdle: (sessionId) => isSessionIdleForCleanup(sessionId),
    hasPendingDelivery: (sessionId) => armedDeliveryContract(sessionId) !== null,
    isAbandonedDialog: (sessionId) => isSessionInAbandonedDialog(sessionId),
    hasDeliveredSuccess: (sessionId) => {
      const scope = getContextBySession(sessionId)?.scope;
      if (!scope) return false;
      try {
        return getProjectDomainStores(scope)
          .handoffs.list({ sessionIds: [sessionId], includeDelivered: true })
          .some((handoff) => handoff.status === 'success');
      } catch {
        return false;
      }
    },
    closePane: (paneId) => requestPaneClose(paneId),
    // 0.76.45: estacionar (pane fica, memória vai a zero); main-owned sem
    // renderer cai no fechamento dentro de requestPanePark.
    parkPane: (paneId, reason) => {
      // Adapter sem resume por id (ex.: aider) não tem como acordar com a
      // conversa: estacionar seria fechar com outro nome. Fecha de verdade
      // APENAS se for pane sem dono elegível a fechamento definitivo.
      const sessionId = getPaneAuthzInfo(paneId)?.sessionId ?? null;
      const adapterId = sessionId ? getAgentSessionInfo(sessionId)?.adapterId : undefined;
      const adapter = adapterId ? getAdapter(adapterId) : null;
      const canResume =
        adapter?.kind === 'cli-pty' && (adapter.spawn.resumeIdArgs?.length ?? 0) > 0;
      if (!canResume) {
        const authority = sessionId ? getPaneRuntimeAuthorityBySession(sessionId) : null;
        const isDestructiveCloseEligible =
          authority &&
          authority.role !== 'orchestrator' &&
          (authority.role !== 'worker' || authority.missionId === undefined) &&
          authority.operatorParentSessionId !== undefined;
        if (!isDestructiveCloseEligible) {
          return false;
        }
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
    isSevereMemoryPressure: productionSevereMemoryPressure,
    isCriticalMemoryPressure: productionCriticalMemoryPressure,
    registerAdvisor: () =>
      registerPaneAdmissionAdvisor({
        idleCandidates: (now) =>
          admissionIdleCandidates(
            listPaneSnapshots(),
            now,
            getGuardianIdleForMs,
            paneSessionLastOutputAt,
          ),
      }),
  };
}

/**
 * F-1381: saída do PTY mais nova que isto (uma varredura do guardião) tira o
 * pane da lista de "ociosos" da admissão.
 */
export const ADMISSION_IDLE_MIN_QUIET_MS = PANE_GUARDIAN_SWEEP_INTERVAL_MS;

/**
 * Panes que a recusa/aviso da admissão sugere fechar. O estado do snapshot já
 * conta o one-shot vivo como busy (F-1312); o relógio de ocioso é o do
 * guardião, limitado pela última saída real do PTY (F-1381): a detecção de
 * tela pode publicar `idle` sobre um TUI que segue redesenhando.
 */
export function admissionIdleCandidates(
  panes: readonly Pick<PaneSnapshot, 'kind' | 'state' | 'role' | 'paneId' | 'paneNumber' | 'title' | 'sessionId'>[],
  now: number,
  guardianIdleForMs: (sessionId: string, now: number) => number,
  lastOutputAt: (sessionId: string) => number | undefined,
): IdlePaneCandidate[] {
  const candidates: IdlePaneCandidate[] = [];
  for (const pane of panes) {
    if (pane.kind !== 'cli-agent' || pane.state !== 'idle' || pane.role === 'orchestrator') continue;
    let idleForMs = pane.sessionId ? guardianIdleForMs(pane.sessionId, now) : 0;
    const outputAt = pane.sessionId ? lastOutputAt(pane.sessionId) : undefined;
    if (outputAt !== undefined) {
      const quietMs = Math.max(0, now - outputAt);
      if (quietMs < ADMISSION_IDLE_MIN_QUIET_MS) continue;
      idleForMs = Math.min(idleForMs, quietMs);
    }
    candidates.push({
      paneId: pane.paneId,
      paneNumber: pane.paneNumber,
      title: pane.title,
      idleForMs,
    });
  }
  return candidates;
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

/**
 * Quem pode ser estacionado (CLI suspenso, pane e scrollback preservados na UI):
 * - qualquer worker (com ou sem missão), se estiver idle e sem entrega pendente;
 * - panes do operador (helper ou pane aberto pelo humano no renderer).
 * NUNCA: orquestrador (governa a missão).
 */
export function isGuardianParkablePane(ref: NonWorkerPaneRef): boolean {
  if (ref.role === 'orchestrator') return false;
  return true;
}

function paneIsClosable(
  deps: NonWorkerAutoCloseDeps,
  sessionId: string,
): NonWorkerPaneRef | null {
  if (!deps.isEnabled()) return null;
  if (deps.hasPendingDelivery?.(sessionId)) return null;
  const ref = deps.getPaneRef(sessionId);
  if (!ref) return null;
  if (!isGuardianEligiblePane(ref)) return null;
  if (deps.isIdle(sessionId)) return ref;
  // Diálogo abandonado só libera o helper que JÁ entregou com sucesso (o
  // diálogo é resto do turno depois da entrega). Pane humano, worker de missão
  // e orquestrador já ficaram de fora acima; o reaper de pressão nunca usa isto.
  return deps.isAbandonedDialog?.(sessionId) && deps.hasDeliveredSuccess?.(sessionId)
    ? ref
    : null;
}

export function paneIsParkableUnderPressure(
  deps: NonWorkerAutoCloseDeps,
  sessionId: string,
): NonWorkerPaneRef | null {
  if (!deps.isEnabled()) return null;
  if (!deps.isIdle(sessionId)) return null;
  if (deps.hasPendingDelivery?.(sessionId)) return null;
  const ref = deps.getPaneRef(sessionId);
  if (!ref) return null;
  if (!isGuardianParkablePane(ref)) return null;
  return ref;
}

const armed = new Map<string, ReturnType<typeof setTimeout>>();
/** Varredura (F-572): quando cada sessão foi vista idle pela primeira vez. */
const idleSince = new Map<string, number>();
/** Sessões cujo fechamento já foi pedido; evita pedir duas vezes por tick. */
const closing = new Set<string>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let blindTicks = 0;
let sweepController = new AbortController();
const closeFlights = new Set<Promise<unknown>>();
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
): Promise<boolean> {
  if (closing.has(sessionId)) return Promise.resolve(false);
  closing.add(sessionId);
  const verb = deps.parkPane ? 'estacionando' : 'encerrando';
  deps.log(
    `${verb} pane ocioso sem dono via ${trail} (${reason}) ` +
      `(pane=${ref.paneId}, session=${sessionId}, role=${ref.role ?? 'none'})`,
  );
  const outcome: Promise<'parked' | 'closed' | boolean> = deps.parkPane
    ? Promise.resolve(deps.parkPane(ref.paneId, reason))
    : Promise.resolve(deps.closePane(ref.paneId));
  const flight = outcome.then(
    (closed) => {
      closing.delete(sessionId);
      if (closed) idleSince.delete(sessionId);
      if (!closed) {
        deps.log(
          `fechamento recusado pela autoridade do pane ` +
            `(pane=${ref.paneId}, session=${sessionId})`,
        );
      }
      return Boolean(closed);
    },
    (error) => {
      closing.delete(sessionId);
      deps.log(
        `falha ao encerrar pane ocioso (session=${sessionId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    },
  );
  closeFlights.add(flight);
  void flight.finally(() => closeFlights.delete(flight));
  return flight;
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
export async function sweepIdlePanes(deps: NonWorkerAutoCloseDeps, context?: PeriodicTaskContext): Promise<void> {
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
    await context?.checkpoint();
    if (!new Set(list()).has(sessionId)) idleSince.delete(sessionId);
  }
  for (const sessionId of idleNow) {
    await context?.checkpoint();
    if (!new Set(list()).has(sessionId)) continue;
    const since = idleSince.get(sessionId);
    if (since === undefined) {
      idleSince.set(sessionId, now);
      continue;
    }
    if (now - since < deps.ttlMs) continue;
    const ref = paneIsClosable(deps, sessionId);
    if (ref) {
      await closeIdlePane(deps, ref, sessionId, 'varredura');
      context?.assertCurrent();
      continue;
    }
    // F-150: expiry alone cannot end a human's pane or a mission worker.
    // The broader parking policy below requires actual memory pressure.
  }
  // 0.76.44 / F-588 — reaper de emergência: com a máquina sob pressão (mesmos
  // limiares do gate de spawn), não espera o TTL. Estaciona panes ociosos
  // elegíveis por tick, os mais parados primeiro; os vetos (orquestrador,
  // entrega armada, awaiting-input) continuam. Otimização multi-pane (06/10,
  // 16/10): 2 por tick na pressão moderada, 4 na severa (< 60 % do mínimo
  // livre) e 6 na crítica (< 30 % ou swap alto) — um por minuto não drena RAM
  // antes do freeze.
  if (deps.isUnderMemoryPressure?.()) {
    const severe = deps.isSevereMemoryPressure?.() ?? false;
    const critical = deps.isCriticalMemoryPressure?.() ?? false;
    const parksThisTick = critical
      ? CRITICAL_PRESSURE_PARKS_PER_TICK
      : severe
        ? SEVERE_PRESSURE_PARKS_PER_TICK
        : MODERATE_PRESSURE_PARKS_PER_TICK;
    let parked = 0;
    const candidatesThisTick = new Set(idleSince.keys());
    const attempted = new Set<string>();
    while (parked < parksThisTick && attempted.size < candidatesThisTick.size) {
      await context?.checkpoint();
      if (!deps.isUnderMemoryPressure?.()) break;
      let oldest: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [sessionId, idleAt] of [...idleSince.entries()]) {
        await context?.checkpoint();
        if (!candidatesThisTick.has(sessionId) || attempted.has(sessionId) || !new Set(list()).has(sessionId) || closing.has(sessionId) || !paneIsParkableUnderPressure(deps, sessionId)) continue;
        const wokeAgo = deps.wokeAgoMs?.(sessionId);
        if (wokeAgo !== null && wokeAgo !== undefined && wokeAgo < PANE_WAKE_GRACE_MS) continue;
        if (idleAt < oldestAt) { oldest = sessionId; oldestAt = idleAt; }
      }
      if (!oldest || !new Set(list()).has(oldest)) break;
      const sessionId = oldest;
      attempted.add(sessionId);
      const wokeAgo = deps.wokeAgoMs?.(sessionId);
      if (wokeAgo !== null && wokeAgo !== undefined && wokeAgo < PANE_WAKE_GRACE_MS) continue;
      const parkRef = paneIsParkableUnderPressure(deps, sessionId);
      if (!parkRef) continue;
      // Se não temos parkPane (apenas closePane destrutivo), fechamos apenas
      // se for elegível a fechamento definitivo (isGuardianEligiblePane).
      if (!deps.parkPane && !isGuardianEligiblePane(parkRef)) continue;
      if (!deps.isUnderMemoryPressure?.()) break;
      const verb = deps.parkPane ? 'estacionando' : 'fechando';
      const roleLabel = parkRef.role ?? 'none';
      const tierLabel = critical ? ' crítica' : severe ? ' severa' : '';
      deps.log(
        `pressão de memória${tierLabel}: ${verb} o pane ocioso mais antigo sem esperar o TTL ` +
          `(pane=${parkRef.paneId}, role=${roleLabel}, ocioso há ${Math.round((now - (idleSince.get(sessionId) ?? now)) / 1000)} s)` +
          (severe || critical ? ` [lote ${parked + 1}/${parksThisTick}]` : ''),
      );
      const closed = await closeIdlePane(deps, parkRef, sessionId, 'varredura', 'memory-pressure');
      context?.assertCurrent();
      if (closed) parked += 1;
    }
  }
}

/** Pressão severa: memória livre abaixo de 60 % do mínimo do gate. */
function productionSevereMemoryPressure(): boolean {
  try {
    const sample = getCachedSystemMemory();
    if (!sample || sample.freeMB === null) return false;
    const limits = readPaneAdmissionLimits();
    return sample.freeMB < limits.minFreeMB * SEVERE_PRESSURE_RATIO;
  } catch {
    return false;
  }
}

/**
 * Pressão crítica: memória livre abaixo de 30 % do mínimo do gate OU swap em
 * uso acima do teto que a máquina armou (`maxSwapUsedMB > 0`). É o degrau mais
 * agressivo do reaper — só drena 6 panes/tick quando a máquina está de fato à
 * beira do freeze.
 */
function productionCriticalMemoryPressure(): boolean {
  try {
    const sample = getCachedSystemMemory();
    if (!sample) return false;
    const limits = readPaneAdmissionLimits();
    if (sample.freeMB !== null && sample.freeMB < limits.minFreeMB * CRITICAL_PRESSURE_RATIO) {
      return true;
    }
    return (
      limits.maxSwapUsedMB > 0 &&
      sample.swapUsedMB !== null &&
      sample.swapUsedMB > limits.maxSwapUsedMB
    );
  } catch {
    return false;
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
  sweepController = new AbortController();
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
    sweepTimer = setInterval(() => {
      void runPeriodicTask('pane-guardian', (context) => sweepIdlePanes(deps, context),
        { signal: sweepController.signal, cadenceMs: interval }).catch(() => undefined);
    }, interval);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }
}

export async function shutdownNonWorkerAutoClose(): Promise<void> {
  sweepController.abort(new Error('pane guardian stopped'));
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
  await stopPeriodicTask('pane-guardian');
  await Promise.allSettled([...closeFlights]);
}
