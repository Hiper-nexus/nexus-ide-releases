import { useEffect, useState } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useOmpRpcStore } from '../state/omp-rpc-store';
import { listPanes } from '../lib/split-tree';
import { FLEET_SEG_LABEL } from '../../shared/pane-session-view';
import type { OmpRpcSessionSummary } from '../../shared/omp-rpc-types';

/**
 * Rollup da frota: "3 trab · 2 ok · 1 x" num relance.
 * Clique foca quem precisa de atenção — morto primeiro, depois ocupado.
 * Conta panes PTY + sessões omp rpc-ui (painel e mission workers).
 */

function ompCountsAsWorking(summary: OmpRpcSessionSummary): boolean {
  return (
    summary.state === 'busy' ||
    summary.state === 'spawning' ||
    summary.snapshot.isStreaming
  );
}

export function FleetChip() {
  // Use displayStates so "1 trab · 3 ok" does not thrash on short busy↔idle gaps.
  const paneStates = useSessionStateStore((s) => s.displayStates);
  const root = useLayoutStore((s) => s.root);
  const focus = useLayoutStore((s) => s.focus);
  const ompPanelBusy = useOmpRpcStore(
    (s) =>
      s.starting ||
      s.snapshot?.state === 'busy' ||
      s.snapshot?.state === 'spawning' ||
      s.snapshot?.isStreaming === true,
  );
  const ompPanelReady = useOmpRpcStore(
    (s) => Boolean(s.sessionId) && s.snapshot?.state === 'idle',
  );
  const toggleOmp = useOmpRpcStore((s) => s.togglePanel);
  const [ompMissionSessions, setOmpMissionSessions] = useState<
    OmpRpcSessionSummary[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void window.nexus.ompRpc.listSessions().then((rows) => {
        if (!cancelled) {
          setOmpMissionSessions(rows.filter((row) => row.kind === 'mission'));
        }
      });
    };
    refresh();
    const stop = window.nexus.ompRpc.onEvent(() => refresh());
    const timer = window.setInterval(refresh, 4_000);
    return () => {
      cancelled = true;
      stop();
      window.clearInterval(timer);
    };
  }, []);

  let working = 0;
  let ready = 0;
  let sleeping = 0;
  let down = 0;
  let firstDown: string | null = null;
  let firstWorking: string | null = null;
  let openOmpOnClick = false;
  for (const pane of listPanes(root)) {
    const st = paneStates.get(pane.id);
    if (!st) continue;
    if (st === 'busy' || st === 'spawning') {
      working += 1;
      firstWorking ??= pane.id;
    } else if (st === 'exited') {
      down += 1;
      firstDown ??= pane.id;
    } else if (st === 'hibernated') {
      sleeping += 1;
    } else {
      ready += 1;
    }
  }
  // Panel session (single) when not already a mission worker row.
  if (ompPanelBusy) {
    working += 1;
    openOmpOnClick = true;
  } else if (ompPanelReady) {
    ready += 1;
  }
  for (const row of ompMissionSessions) {
    if (ompCountsAsWorking(row)) {
      working += 1;
      openOmpOnClick = true;
    } else if (row.state === 'exited') {
      down += 1;
      openOmpOnClick = true;
    } else if (row.state === 'idle' || row.state === 'ready') {
      ready += 1;
    }
  }
  if (working + ready + sleeping + down === 0) return null;

  const target = firstDown ?? firstWorking;
  const label = [
    working > 0 ? `${working} trabalhando` : null,
    ready > 0 ? `${ready} pronto${ready === 1 ? '' : 's'}` : null,
    sleeping > 0 ? `${sleeping} dormindo` : null,
    down > 0 ? `${down} morto${down === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      type="button"
      className="fleet-chip"
      title={`Frota: ${label}${target || openOmpOnClick ? ' — clique para focar quem precisa de atenção' : ''}`}
      aria-label={`Frota: ${label}`}
      onClick={() => {
        if (target) focus(target);
        else if (openOmpOnClick) toggleOmp();
      }}
    >
      {working > 0 && (
        <span className="fleet-chip__seg fleet-chip__seg--working">
          <span className="fleet-chip__dot" aria-hidden="true" />
          {working}
          <span className="fleet-chip__word">{FLEET_SEG_LABEL.working}</span>
        </span>
      )}
      {ready > 0 && (
        <span className="fleet-chip__seg fleet-chip__seg--ready">
          <span className="fleet-chip__dot" aria-hidden="true" />
          {ready}
          <span className="fleet-chip__word">{FLEET_SEG_LABEL.ready}</span>
        </span>
      )}
      {sleeping > 0 && (
        <span className="fleet-chip__seg fleet-chip__seg--sleeping">
          <span className="fleet-chip__dot" aria-hidden="true" />
          {sleeping}
          <span className="fleet-chip__word">{FLEET_SEG_LABEL.sleeping}</span>
        </span>
      )}
      {down > 0 && (
        <span className="fleet-chip__seg fleet-chip__seg--down">
          <span className="fleet-chip__dot" aria-hidden="true" />
          {down}
          <span className="fleet-chip__word">{FLEET_SEG_LABEL.down}</span>
        </span>
      )}
    </button>
  );
}
