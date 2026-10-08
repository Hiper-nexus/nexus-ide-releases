import { useEffect, useSyncExternalStore } from 'react';
import type { ApprovalRequestView } from '../../shared/approval-decision';

/**
 * Pedidos de aprovação do broker (PRV-02) no renderer: uma lista única,
 * alimentada pelo push do Main, e o registro das sessões cujo card está
 * VISÍVEL — é ele que faz o hook PermissionRequest esperar pelo desktop.
 * Pane fora da tela, janela oculta ou card desmontado = não respondente: o
 * Main devolve `{}` na hora e a TUI decide como sempre.
 */

let requests: readonly ApprovalRequestView[] = [];
const listeners = new Set<() => void>();
let started = false;

function setRequests(next: readonly ApprovalRequestView[]): void {
  requests = next;
  for (const listener of [...listeners]) listener();
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined' || !window.nexus?.approvals) return;
  started = true;
  window.nexus.approvals.onChanged((next) => setRequests(Array.isArray(next) ? next : []));
  void window.nexus.approvals
    .list()
    .then((next) => setRequests(Array.isArray(next) ? next : []))
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** O pedido mais antigo ainda vivo desta sessão PTY (um card por vez). */
export function useApprovalRequestFor(sessionId: string | null): ApprovalRequestView | null {
  const all = useSyncExternalStore(subscribe, () => requests, () => requests);
  if (!sessionId) return null;
  return all.find((request) => request.sessionId === sessionId && request.responseCapability === 'live') ?? null;
}

// ── Superfícies visíveis ────────────────────────────────────────────────────

const surfaceCounts = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = '';
let visibilityHooked = false;

function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function flushSurfaces(): void {
  flushTimer = null;
  const sessionIds = documentVisible() ? [...surfaceCounts.keys()].sort() : [];
  const key = sessionIds.join('\u0000');
  if (key === lastSent || !window.nexus?.approvals) return;
  lastSent = key;
  void window.nexus.approvals.setVisibleSurfaces(sessionIds).catch(() => {
    lastSent = '';
  });
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flushSurfaces, 50);
}

function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', scheduleFlush);
}

/** Enquanto montado e `active`, a sessão conta como respondente no desktop. */
export function useApprovalSurface(sessionId: string | null, active: boolean): void {
  useEffect(() => {
    if (!sessionId || !active) return undefined;
    hookVisibility();
    surfaceCounts.set(sessionId, (surfaceCounts.get(sessionId) ?? 0) + 1);
    scheduleFlush();
    return () => {
      const remaining = (surfaceCounts.get(sessionId) ?? 1) - 1;
      if (remaining <= 0) surfaceCounts.delete(sessionId);
      else surfaceCounts.set(sessionId, remaining);
      scheduleFlush();
    };
  }, [sessionId, active]);
}

export function __resetApprovalRequestsForTests(): void {
  requests = [];
  listeners.clear();
  started = false;
  surfaceCounts.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  lastSent = '';
}
