import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { listPanes } from '../lib/split-tree';
import { FLEET_SEG_LABEL } from '../../shared/pane-session-view';

/**
 * Rollup da frota: "3 trab · 2 ok · 1 x" num relance.
 * Clique foca quem precisa de atenção — morto primeiro, depois ocupado.
 */

export function FleetChip() {
  const paneStates = useSessionStateStore((s) => s.paneStates);
  const root = useLayoutStore((s) => s.root);
  const focus = useLayoutStore((s) => s.focus);

  let working = 0;
  let ready = 0;
  let sleeping = 0;
  let down = 0;
  let firstDown: string | null = null;
  let firstWorking: string | null = null;
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
      title={`Frota: ${label}${target ? ' — clique para focar quem precisa de atenção' : ''}`}
      aria-label={`Frota: ${label}`}
      onClick={() => {
        if (target) focus(target);
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
