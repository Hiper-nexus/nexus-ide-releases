import type { ProjectExecutionScope } from '../../shared/types';
import {
  orchWriteSession,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
} from '../persistence/renderer-workspace-scope';
import {
  getOwnedPaneAuthzInfoBySession,
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  requestMissionPaneClose,
  type OwnedPaneAuthzInfo,
} from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { onHandoffSubmitted } from './idle-delivery';
import { sameProjectScope } from './project-scoped-broadcast';
import { publishObserverFrame, snapshotObserverFrames } from './observer-bus';

/**
 * Watchdog de stall (benchmark §4.4): um worker que fica BUSY em silêncio por
 * tempo demais — CLI travada, prompt de permissão perdido, rede caída — deixa
 * o orquestrador esperando um handoff que nunca vem e a missão morre em
 * silêncio. O watchdog varre a cada 30s e, após N minutos sem NENHUM output,
 * submete um handoff sintético `stalled` que acorda o orquestrador pela mesma
 * via de entrega dos handoffs reais (idle-delivery).
 *
 * Ação deliberadamente NÃO destrutiva: o watchdog nunca mata nem reinicia o
 * worker (um build longo é silêncio legítimo) — ele informa, e o orquestrador
 * decide (ler o pane, esperar mais, fechar). Reiniciar automaticamente e
 * injetar "Continue" pode repetir efeitos que a sessão anterior já executou.
 * Um flag por sessão evita spam: só re-alerta se o worker voltar a produzir
 * output/atividade e travar DE NOVO.
 *
 * Falha DISTINTA — boot não-executante (paridade Overclock, P0-6): um worker
 * nasce com a tarefa no argv (birth-executing) e deve começar a executar em
 * segundos. Se ele boota mas NUNCA engaja a tarefa — prompt vazio, login preso
 * que não bate padrão conhecido, sessão que fica idle além da janela de boot
 * (~15s) — é o "pane vazio" que jamais entrega handoff e trava a missão para
 * sempre. Ao contrário do silêncio-BUSY (silêncio legítimo de um build longo),
 * um boot não-executante é uma FALHA: o watchdog o reapa (fecha o pane com a
 * mesma autoridade física do teardown) e acorda o orquestrador via handoff
 * sintético `failed`, para re-despachar/respawnar. A rede de segurança do
 * everExecuted garante ZERO falso-positivo: um worker que entrou em busy/
 * waiting (executou) nunca é reapeado por este caminho.
 */

export const STALL_SCAN_MS = 30_000;
export const STALL_MS = 10 * 60_000;
/**
 * Carência da PROBE (paridade Overclock): sinalizar não basta — o worker mudo
 * é CUTUCADO e, se a cutucada não produzir NENHUM sinal de vida dentro desta
 * janela, o silêncio deixa de ser suspeita e vira falha visível na missão.
 * Sem esta escada o alerta acontecia uma vez e morria ali: se ninguém agisse
 * sobre ele, o worker mudo continuava mudo para sempre.
 */
export const STALL_PROBE_GRACE_MS = 2 * 60_000;
/**
 * Janela de boot: um worker que nunca executou dentro deste intervalo desde que
 * o watchdog o observou é tratado como boot não-executante. ~15s espelha o
 * `pane_wait_idle` do Overclock (confirmação de boot ≤15s).
 */
export const BOOT_STALL_MS = 15_000;

export interface StallCandidate {
  role?: 'orchestrator' | 'worker';
  state: string;
  lastActivityAt: number;
  alreadyFlagged: boolean;
}

/** Decisão pura (unit-testável): este worker deve ser sinalizado agora? */
export function shouldFlagStall(
  c: StallCandidate,
  now: number,
  stallMs: number = STALL_MS,
): boolean {
  if (c.role !== 'worker') return false;
  if (c.state !== 'busy') return false;
  if (c.alreadyFlagged) return false;
  return now - c.lastActivityAt >= stallMs;
}

export interface StallEscalationCandidate {
  role?: 'orchestrator' | 'worker';
  state: string;
  /** Quando a probe foi escrita no pane; null = nenhuma probe enviada. */
  probedAt: number | null;
  lastActivityAt: number;
  alreadyEscalated: boolean;
}

/**
 * Decisão pura: a probe ficou sem resposta e o silêncio deve virar sinal
 * visível de missão? Qualquer atividade DEPOIS da probe conta como resposta —
 * é exatamente o caso que se quer preservar (probar recupera worker mudo).
 */
export function shouldEscalateStall(
  c: StallEscalationCandidate,
  now: number,
  graceMs: number = STALL_PROBE_GRACE_MS,
): boolean {
  if (c.role !== 'worker') return false;
  if (c.state === 'exited') return false;
  if (c.probedAt === null) return false;
  if (c.alreadyEscalated) return false;
  // Respondeu: houve atividade a partir da probe. `>=` e não `>` porque no
  // instante da sondagem `lastActivityAt` é, por construção, mais velho que o
  // limite de stall — empate só acontece quando a resposta chega no mesmo
  // milissegundo, e isso é uma resposta.
  if (c.lastActivityAt >= c.probedAt) return false;
  return now - c.probedAt >= graceMs;
}

export interface BootStallCandidate {
  role?: 'orchestrator' | 'worker';
  state: string;
  /** Já foi observado em qualquer estado engajado (busy/waiting) desde o boot? */
  everExecuted: boolean;
  /** Quando o watchdog começou a observar este worker. */
  bootAt: number;
  alreadyReaped: boolean;
}

/**
 * Decisão pura (unit-testável): este worker é um boot não-executante que deve
 * ser reapeado agora? Só workers; nunca quem já executou (everExecuted) ou já
 * saiu do idle; idle > janela de boot; idempotente.
 */
export function shouldReapNonExecutingBoot(
  c: BootStallCandidate,
  now: number,
  bootWindowMs: number = BOOT_STALL_MS,
): boolean {
  if (c.role !== 'worker') return false;
  if (c.everExecuted) return false;
  if (c.state === 'exited') return false;
  // Qualquer estado não-idle significa que o CLI engajou a tarefa (executando
  // ou esperando permissão) — não é um pane vazio.
  if (c.state !== 'idle') return false;
  if (c.alreadyReaped) return false;
  return now - c.bootAt >= bootWindowMs;
}

interface WatchAuthority {
  readonly owner: OwnedPaneAuthzInfo['owner'];
  readonly paneId: string;
  readonly sessionId: string;
  readonly missionId: string;
  readonly scope: ProjectExecutionScope;
}

interface WatchState {
  readonly authority: WatchAuthority;
  /** Quando o watchdog começou a observar (nunca resetado por atividade). */
  readonly bootAt: number;
  lastActivityAt: number;
  isFlagged: boolean;
  /** Já observado em estado engajado (busy/waiting) — desarma o boot-reap. */
  everExecuted: boolean;
  isReaped: boolean;
  /** Quando a probe foi escrita no pane deste worker mudo. */
  probedAt: number | null;
  isEscalated: boolean;
}

const PROBE_TEXT =
  '[NEXUS_STALL_PROBE] Você está sem produzir saída há muito tempo e o ' +
  'orquestrador está bloqueado esperando seu handoff. Responda AGORA em uma ' +
  'linha: o que está executando neste momento? Se estiver travado (prompt de ' +
  'permissão pendente, rede, tool sem resposta), entregue o handoff com ' +
  'status "blocked" e diga o motivo.';

/**
 * Cutuca o worker mudo. Escrever num pane BUSY normalmente é proibido (corrompe
 * o turno vivo), mas aqui o silêncio é a prova de que não há turno vivo:
 * `recordActivity` é re-armado por QUALQUER byte de PTY *e* por qualquer
 * heartbeat de estado do provider, então dez minutos sem nenhum dos dois
 * significam que o turno morreu. Falha de escrita é informação, não exceção.
 */
function probeMuteWorker(sessionId: string): boolean {
  try {
    if (
      !orchWriteSession(sessionId, `\x1b[200~${PROBE_TEXT}\x1b[201~`, {
        markInputBusy: false,
      })
    ) {
      return false;
    }
    return orchWriteSession(sessionId, '\r', { markInputBusy: false });
  } catch {
    return false;
  }
}

const watches = new Map<string, WatchState>();
const ownerKeys = new WeakMap<OwnedPaneAuthzInfo['owner'], number>();
let nextOwnerKey = 1;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let untapData: (() => void) | null = null;
let untapState: (() => void) | null = null;
let untapExit: (() => void) | null = null;
let unsubscribeScopeChanges: (() => void) | null = null;

function ownerKey(owner: OwnedPaneAuthzInfo['owner']): number {
  const existing = ownerKeys.get(owner);
  if (existing) return existing;
  const key = nextOwnerKey++;
  ownerKeys.set(owner, key);
  return key;
}

function watchKey(authority: WatchAuthority): string {
  return JSON.stringify([
    ownerKey(authority.owner),
    authority.scope.installationId,
    authority.scope.projectId,
    authority.scope.checkoutId,
    authority.scope.rootRealPath,
    authority.missionId,
    authority.paneId,
    authority.sessionId,
  ]);
}

function resolveAuthority(sessionId: string): WatchAuthority | null {
  const pane = getOwnedPaneAuthzInfoBySession(sessionId);
  const rendererScope = pane ? getRendererWorkspaceScope(pane.owner) : null;
  if (
    !pane ||
    pane.sessionId !== sessionId ||
    pane.kind !== 'cli-agent' ||
    pane.role !== 'worker' ||
    !pane.missionId ||
    !pane.scope ||
    !rendererScope ||
    !sameProjectScope(rendererScope, pane.scope)
  ) {
    return null;
  }
  return Object.freeze({
    owner: pane.owner,
    paneId: pane.paneId,
    sessionId,
    missionId: pane.missionId,
    scope: Object.freeze({ ...pane.scope }),
  });
}

/** Estados que provam que o CLI engajou a tarefa (executando ou aguardando). */
function isEngagedState(state: string): boolean {
  return state !== 'idle' && state !== 'exited';
}

function scan(
  now: number = Date.now(),
  stallMs: number = STALL_MS,
  bootWindowMs: number = BOOT_STALL_MS,
): void {
  const liveKeys = new Set<string>();
  for (const pane of listPaneSnapshots()) {
    if (!pane.sessionId) continue;
    const authority = resolveAuthority(pane.sessionId);
    if (!authority || authority.paneId !== pane.paneId) continue;
    const key = watchKey(authority);
    liveKeys.add(key);
    let watch = watches.get(key);
    if (!watch) {
      watch = {
        authority,
        bootAt: now,
        lastActivityAt: now,
        isFlagged: false,
        everExecuted: isEngagedState(pane.state),
        isReaped: false,
        probedAt: null,
        isEscalated: false,
      };
      watches.set(key, watch);
    }
    // Um scan que flagra o worker em estado engajado prova que ele executou —
    // captura transições que o tap de estado possa ter perdido.
    if (isEngagedState(pane.state)) watch.everExecuted = true;

    // Boot não-executante (P0-6): nasceu, nunca executou, idle além da janela.
    const bootCandidate: BootStallCandidate = {
      role: 'worker',
      state: pane.state,
      everExecuted: watch.everExecuted,
      bootAt: watch.bootAt,
      alreadyReaped: watch.isReaped,
    };
    if (shouldReapNonExecutingBoot(bootCandidate, now, bootWindowMs)) {
      watch.isReaped = true;
      reapNonExecutingBoot(authority, pane, now);
      continue;
    }

    const candidate: StallCandidate = {
      role: 'worker',
      state: pane.state,
      // Sessão que nunca emitiu output desde o boot do watchdog conta a partir
      // de agora (semeia no primeiro scan) — nunca flagra no arranque.
      lastActivityAt: watch.lastActivityAt,
      alreadyFlagged: watch.isFlagged,
    };
    // Probe sem resposta: a suspeita vira falha visível da missão.
    if (
      shouldEscalateStall(
        {
          role: 'worker',
          state: pane.state,
          probedAt: watch.probedAt,
          lastActivityAt: watch.lastActivityAt,
          alreadyEscalated: watch.isEscalated,
        },
        now,
      )
    ) {
      watch.isEscalated = true;
      escalateUnansweredProbe(authority, pane, now, watch.probedAt ?? now);
      continue;
    }

    if (!shouldFlagStall(candidate, now, stallMs)) continue;

    watch.isFlagged = true;
    const minutes = Math.round((now - candidate.lastActivityAt) / 60_000);
    const previousFrames = snapshotObserverFrames(authority.sessionId);
    publishObserverFrame({
      sessionId: authority.sessionId,
      paneId: authority.paneId,
      missionId: authority.missionId,
      at: now,
      kind: 'stall_suspected',
      payload: {
        silentForMs: Math.max(0, now - candidate.lastActivityAt),
        lastSeq: previousFrames.at(-1)?.seq ?? null,
        detector: 'stall-watchdog',
      },
    });
    const handoff = getProjectDomainStores(authority.scope).handoffs.submit({
      status: 'stalled',
      summary:
        `watchdog: o worker "${pane.agentName ?? pane.title}" (${pane.paneId}) ` +
        `está sem output há ${minutes} min e não submeteu handoff. ` +
        `Leia o pane (nexus_pane_read) para diagnosticar: pode ser prompt de ` +
        `permissão pendente, CLI travada ou tarefa legítima longa.`,
      missionId: authority.missionId,
      sessionId: pane.sessionId,
      fromAgent: 'nexus-watchdog',
    });
    onHandoffSubmitted(handoff, authority.scope);
    // Sinalizar não basta: cutuca o worker mudo na mesma passada. Probar
    // recupera a maioria dos mudos; e se não recuperar, a probe sem resposta
    // é o que autoriza a escalada acima na varredura seguinte.
    watch.probedAt = probeMuteWorker(authority.sessionId) ? now : null;
    console.warn(
      `[watchdog] worker stalled: ${pane.paneId} (${minutes} min)` +
        (watch.probedAt === null ? ' — probe não pôde ser escrita' : ' — probe enviada'),
    );
  }
  for (const key of [...watches.keys()]) {
    if (!liveKeys.has(key)) watches.delete(key);
  }
}

/**
 * A probe ficou sem resposta: o worker não é "talvez travado", ele está mudo
 * de verdade. Emite o frame de observação distinto e um handoff `failed` — que
 * é o estado VISÍVEL na missão (o `stalled` anterior é suspeita, não veredito)
 * para o orquestrador re-despachar em vez de esperar mais.
 */
function escalateUnansweredProbe(
  authority: WatchAuthority,
  pane: ReturnType<typeof listPaneSnapshots>[number],
  now: number,
  probedAt: number,
): void {
  const previousFrames = snapshotObserverFrames(authority.sessionId);
  publishObserverFrame({
    sessionId: authority.sessionId,
    paneId: authority.paneId,
    missionId: authority.missionId,
    at: now,
    kind: 'stall_suspected',
    payload: {
      silentForMs: Math.max(0, now - probedAt),
      lastSeq: previousFrames.at(-1)?.seq ?? null,
      detector: 'stall-probe-unanswered',
    },
  });
  const minutes = Math.round((now - probedAt) / 60_000);
  const handoff = getProjectDomainStores(authority.scope).handoffs.submit({
    status: 'failed',
    summary:
      `watchdog: o worker "${pane.agentName ?? pane.title}" (${pane.paneId}) ` +
      `não respondeu à sondagem por ${minutes} min — silêncio confirmado, ` +
      `não é tarefa longa. Ele não vai entregar handoff sozinho: leia o pane ` +
      `(nexus_pane_read) e re-despache ou respawne a tarefa.`,
    missionId: authority.missionId,
    sessionId: authority.sessionId,
    fromAgent: 'nexus-watchdog',
  });
  onHandoffSubmitted(handoff, authority.scope);
  console.warn(
    `[watchdog] stall probe unanswered: ${pane.paneId} (${minutes} min)`,
  );
}

/**
 * Reapa um boot não-executante: fecha o pane com a identidade física exata (a
 * mesma autoridade do teardown da missão) e acorda o orquestrador com um
 * handoff sintético `failed`, pela mesma via dos handoffs reais — para que a
 * missão re-despache/respawne em vez de esperar para sempre por um pane vazio.
 */
function reapNonExecutingBoot(
  authority: WatchAuthority,
  pane: ReturnType<typeof listPaneSnapshots>[number],
  now: number,
): void {
  const previousFrames = snapshotObserverFrames(authority.sessionId);
  publishObserverFrame({
    sessionId: authority.sessionId,
    paneId: authority.paneId,
    missionId: authority.missionId,
    at: now,
    kind: 'stall_suspected',
    payload: {
      silentForMs: BOOT_STALL_MS,
      lastSeq: previousFrames.at(-1)?.seq ?? null,
      detector: 'boot-stall-watchdog',
    },
  });

  const handoff = getProjectDomainStores(authority.scope).handoffs.submit({
    status: 'failed',
    summary:
      `watchdog: o worker "${pane.agentName ?? pane.title}" (${pane.paneId}) ` +
      `nasceu mas nunca começou a executar (idle há mais de ` +
      `${Math.round(BOOT_STALL_MS / 1000)}s sem entrar em execução). ` +
      `Boot não-executante ("pane vazio"): prompt vazio, login preso ou boot ` +
      `que travou. O pane foi reapeado; re-despache/respawne a tarefa.`,
    missionId: authority.missionId,
    sessionId: authority.sessionId,
    fromAgent: 'nexus-watchdog',
  });
  onHandoffSubmitted(handoff, authority.scope);

  const runtime = getPaneRuntimeAuthorityBySession(authority.sessionId);
  if (
    runtime &&
    runtime.role === 'worker' &&
    runtime.missionId &&
    runtime.scope &&
    runtime.paneId === authority.paneId
  ) {
    void Promise.resolve(
      requestMissionPaneClose({
        paneId: runtime.paneId,
        missionId: runtime.missionId,
        scope: runtime.scope,
        ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
        role: 'worker',
        ...(runtime.workerIncarnationId
          ? { workerIncarnationId: runtime.workerIncarnationId }
          : {}),
      }),
    ).catch((error) => {
      console.warn('[watchdog] boot reap close failed:', error);
    });
  }
  console.warn(
    `[watchdog] non-executing boot reaped: ${pane.paneId} (idle boot > ${Math.round(
      BOOT_STALL_MS / 1000,
    )}s)`,
  );
}

function recordActivity(
  sessionId: string,
  now: number = Date.now(),
  executed = false,
): void {
  const authority = resolveAuthority(sessionId);
  if (!authority) return;
  const key = watchKey(authority);
  const existing = watches.get(key);
  if (existing) {
    // Preserva bootAt/everExecuted/isReaped — só atividade nova re-arma o
    // silêncio-BUSY; o boot-reap depende do histórico de execução.
    existing.lastActivityAt = now;
    existing.isFlagged = false;
    if (executed) existing.everExecuted = true;
    return;
  }
  watches.set(key, {
    authority,
    bootAt: now,
    lastActivityAt: now,
    isFlagged: false,
    everExecuted: executed,
    isReaped: false,
    probedAt: null,
    isEscalated: false,
  });
}

export function initStallWatchdog(): void {
  if (scanTimer) return;
  prepareStallWatchdog();
  scanTimer = setInterval(() => reconcileStallWatchdog(), STALL_SCAN_MS);
  scanTimer.unref?.();
}

/** Install PTY/scope observers without creating an independent scan loop. */
export function prepareStallWatchdog(): void {
  if (untapData || untapState || untapExit || unsubscribeScopeChanges) return;
  untapData = tapSessionData((sessionId) => {
    recordActivity(sessionId);
    // Voltou a falar: re-arma o alerta para um eventual novo travamento.
  });
  // Provider hooks publish busy/idle/waiting heartbeats while a tool is active,
  // even when its TUI emits no new printable bytes. Ignoring those heartbeats
  // made the Doctor call a visibly coding agent "travado".
  untapState = tapSessionState((sessionId, state) => {
    // Um estado engajado (busy/waiting) prova que o worker executou — marca
    // everExecuted para desarmar o boot-reap definitivamente.
    if (state !== 'exited') recordActivity(sessionId, Date.now(), isEngagedState(state));
  });
  untapExit = tapSessionExit((sessionId) => {
    for (const [key, watch] of [...watches]) {
      if (watch.authority.sessionId === sessionId) watches.delete(key);
    }
  });
  unsubscribeScopeChanges = onRendererWorkspaceScopeChange(
    (owner, previous) => {
      if (!previous) return;
      for (const [key, watch] of [...watches]) {
        if (
          watch.authority.owner.id === owner.id &&
          sameProjectScope(watch.authority.scope, previous)
        ) {
          watches.delete(key);
        }
      }
    },
  );
}

/** One main-coordinator scan. */
export function reconcileStallWatchdog(now: number = Date.now()): void {
  try {
    scan(now);
  } catch (error) {
    console.warn('[watchdog] scan failed:', error);
  }
}

export function shutdownStallWatchdog(): void {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  untapData?.();
  untapData = null;
  untapState?.();
  untapState = null;
  untapExit?.();
  untapExit = null;
  unsubscribeScopeChanges?.();
  unsubscribeScopeChanges = null;
  watches.clear();
}
