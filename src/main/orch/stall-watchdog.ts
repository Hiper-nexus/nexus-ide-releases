import { tapSessionData } from '../pty/pty-manager';
import { listPaneSnapshots, getPaneAuthzInfo } from './pane-registry';
import { submitHandoff } from './handoff-store';
import { onHandoffSubmitted } from './idle-delivery';

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

const lastData = new Map<string, number>();
const flagged = new Set<string>();
let scanTimer: ReturnType<typeof setInterval> | null = null;
let untapData: (() => void) | null = null;

function scan(now: number = Date.now(), stallMs: number = STALL_MS): void {
  for (const pane of listPaneSnapshots()) {
    if (!pane.sessionId) continue;
    const authz = getPaneAuthzInfo(pane.paneId);
    const candidate: StallCandidate = {
      role: authz?.role,
      state: pane.state,
      // Sessão que nunca emitiu output desde o boot do watchdog conta a partir
      // de agora (semeia no primeiro scan) — nunca flagra no arranque.
      lastDataAt: lastData.get(pane.sessionId) ?? seedNow(pane.sessionId, now),
      alreadyFlagged: flagged.has(pane.sessionId),
    };
    if (!shouldFlagStall(candidate, now, stallMs)) continue;

    flagged.add(pane.sessionId);
    const minutes = Math.round((now - candidate.lastDataAt) / 60_000);
    const handoff = submitHandoff({
      status: 'stalled',
      summary:
        `watchdog: o worker "${pane.agentName ?? pane.title}" (${pane.paneId}) ` +
        `está sem output há ${minutes} min e não submeteu handoff. ` +
        `Leia o pane (nexus_pane_read) para diagnosticar: pode ser prompt de ` +
        `permissão pendente, CLI travada ou tarefa legítima longa.`,
      missionId: authz?.missionId,
      sessionId: pane.sessionId,
      fromAgent: 'nexus-watchdog',
    });
    onHandoffSubmitted(handoff);
    console.warn(`[watchdog] worker stalled: ${pane.paneId} (${minutes} min)`);
  }
}

function seedNow(sessionId: string, now: number): number {
  lastData.set(sessionId, now);
  return now;
}

export function initStallWatchdog(): void {
  if (scanTimer) return;
  untapData = tapSessionData((sessionId) => {
    lastData.set(sessionId, Date.now());
    // Voltou a falar: re-arma o alerta para um eventual novo travamento.
    flagged.delete(sessionId);
  });
  scanTimer = setInterval(() => scan(), STALL_SCAN_MS);
  scanTimer.unref?.();
}

export function shutdownStallWatchdog(): void {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  untapData?.();
  untapData = null;
  lastData.clear();
  flagged.clear();
}
