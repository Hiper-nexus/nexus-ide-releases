import type { ProjectExecutionScope } from '../../shared/types';
import { tapSessionData, tapSessionExit } from '../pty/pty-manager';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
} from '../persistence/renderer-workspace-scope';
import {
  getOwnedPaneAuthzInfoBySession,
  listPaneSnapshots,
  type OwnedPaneAuthzInfo,
} from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { onHandoffSubmitted } from './idle-delivery';
import { sameProjectScope } from './project-scoped-broadcast';

/**
 * Watchdog de stall (benchmark §4.4): um worker que fica BUSY em silêncio por
 * tempo demais — CLI travada, prompt de permissão perdido, rede caída — deixa
 * o orquestrador esperando um handoff que nunca vem e a missão morre em
 * silêncio. O watchdog varre a cada 30s e, após N minutos sem NENHUM output,
 * submete um handoff sintético `stalled` que acorda o orquestrador pela mesma
 * via de entrega dos handoffs reais (idle-delivery).
 *
 * Ação deliberadamente NÃO destrutiva: o watchdog nunca mata o worker (um
 * build longo é silêncio legítimo) — ele informa, e o orquestrador decide
 * (ler o pane, esperar mais, fechar). Um flag por sessão evita spam: só
 * re-alerta se o worker voltar a produzir output e travar DE NOVO.
 */

export const STALL_SCAN_MS = 30_000;
export const STALL_MS = 10 * 60_000;

export interface StallCandidate {
  role?: 'orchestrator' | 'worker';
  state: string;
  lastDataAt: number;
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
  return now - c.lastDataAt >= stallMs;
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
  lastDataAt: number;
  isFlagged: boolean;
}

const watches = new Map<string, WatchState>();
const ownerKeys = new WeakMap<OwnedPaneAuthzInfo['owner'], number>();
let nextOwnerKey = 1;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let untapData: (() => void) | null = null;
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

function scan(now: number = Date.now(), stallMs: number = STALL_MS): void {
  const liveKeys = new Set<string>();
  for (const pane of listPaneSnapshots()) {
    if (!pane.sessionId) continue;
    const authority = resolveAuthority(pane.sessionId);
    if (!authority || authority.paneId !== pane.paneId) continue;
    const key = watchKey(authority);
    liveKeys.add(key);
    let watch = watches.get(key);
    if (!watch) {
      watch = { authority, lastDataAt: now, isFlagged: false };
      watches.set(key, watch);
    }
    const candidate: StallCandidate = {
      role: 'worker',
      state: pane.state,
      // Sessão que nunca emitiu output desde o boot do watchdog conta a partir
      // de agora (semeia no primeiro scan) — nunca flagra no arranque.
      lastDataAt: watch.lastDataAt,
      alreadyFlagged: watch.isFlagged,
    };
    if (!shouldFlagStall(candidate, now, stallMs)) continue;

    watch.isFlagged = true;
    const minutes = Math.round((now - candidate.lastDataAt) / 60_000);
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
    console.warn(`[watchdog] worker stalled: ${pane.paneId} (${minutes} min)`);
  }
  for (const key of [...watches.keys()]) {
    if (!liveKeys.has(key)) watches.delete(key);
  }
}

export function initStallWatchdog(): void {
  if (scanTimer) return;
  untapData = tapSessionData((sessionId) => {
    const authority = resolveAuthority(sessionId);
    if (!authority) return;
    const key = watchKey(authority);
    watches.set(key, {
      authority,
      lastDataAt: Date.now(),
      isFlagged: false,
    });
    // Voltou a falar: re-arma o alerta para um eventual novo travamento.
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
  scanTimer = setInterval(() => {
    try {
      scan();
    } catch (error) {
      console.warn('[watchdog] scan failed:', error);
    }
  }, STALL_SCAN_MS);
  scanTimer.unref?.();
}

export function shutdownStallWatchdog(): void {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  untapData?.();
  untapData = null;
  untapExit?.();
  untapExit = null;
  unsubscribeScopeChanges?.();
  unsubscribeScopeChanges = null;
  watches.clear();
}
