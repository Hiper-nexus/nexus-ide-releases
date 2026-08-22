import { useEffect, useState } from 'react';
import type { PaneActivitySummary } from '../../shared/orch-types';
import {
  paneActivityDisplay,
  resolvePaneActivity,
} from '../lib/pane-activity-display';
import { useOrchStore } from '../state/orch-store';

const REFRESH_MS = 30_000;

export function PaneActivityStrip({ paneId }: { paneId: string }) {
  const missionId = useOrchStore((state) => state.paneMissions[paneId]);
  // O ponto "running" numa missão terminal lê como trabalho vivo — com a
  // missão concluída/falha o indicador fica neutro e só o texto informa.
  const missionTerminal = useOrchStore((state) => {
    if (!missionId) return false;
    const summary = state.missionSummaries.find((m) => m.id === missionId);
    return summary?.state === 'completed' || summary?.state === 'failed';
  });
  const [activity, setActivity] = useState<PaneActivitySummary | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (!missionId) {
      setActivity(null);
      return () => undefined;
    }

    const refresh = async () => {
      try {
        const specs = await window.nexus.orch.listMissionPanes(missionId);
        if (!disposed) setActivity(resolvePaneActivity(specs, paneId));
      } catch {
        if (!disposed) setActivity(null);
      }
      if (!disposed) timer = setTimeout(refresh, REFRESH_MS);
    };

    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [missionId, paneId]);

  const display = paneActivityDisplay(activity);
  if (!display) return null;
  return (
    <div className="pane-activity" role="status" title={display.title}>
      <span
        className={`pane-activity__pulse${missionTerminal ? ' pane-activity__pulse--done' : ''}`}
        aria-hidden="true"
      />
      <span className="pane-activity__text">{display.text}</span>
    </div>
  );
}
