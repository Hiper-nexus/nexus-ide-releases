import { memo, useEffect, useState } from 'react';
import type {
  MissionPaneSpec,
  PaneActivitySummary,
} from '../../shared/orch-types';
import {
  paneActivityDisplay,
  resolvePaneActivity,
} from '../lib/pane-activity-display';
import { useOrchStore } from '../state/orch-store';

const REFRESH_MS = 30_000;

/**
 * Janela em que uma resposta de `listMissionPanes` serve a todos os panes da
 * mesma missão. Cada strip pedia o MESMO IPC por pane — 8 panes eram 8
 * chamadas idênticas por rodada (~16/min) contra o Main. Single-flight +
 * cache curto por missionId: uma rodada vira uma chamada só.
 */
const MISSION_PANES_CACHE_MS = 3_000;

interface MissionPanesEntry {
  inflight?: Promise<MissionPaneSpec[]>;
  specs?: MissionPaneSpec[];
  cachedAt?: number;
}

const missionPanesEntries = new Map<string, MissionPanesEntry>();

function listMissionPanesCoalesced(
  missionId: string,
): Promise<MissionPaneSpec[]> {
  const entry = missionPanesEntries.get(missionId) ?? {};
  missionPanesEntries.set(missionId, entry);
  if (entry.inflight) return entry.inflight;
  if (
    entry.specs !== undefined &&
    entry.cachedAt !== undefined &&
    Date.now() - entry.cachedAt < MISSION_PANES_CACHE_MS
  ) {
    return Promise.resolve(entry.specs);
  }
  const inflight = window.nexus.orch
    .listMissionPanes(missionId)
    .then((specs) => {
      entry.specs = specs;
      entry.cachedAt = Date.now();
      return specs;
    })
    .finally(() => {
      entry.inflight = undefined;
    });
  entry.inflight = inflight;
  return inflight;
}

/** Test hook: esvazia o cache/inflight compartilhado entre cenários. */
export function resetMissionPanesCacheForTests(): void {
  missionPanesEntries.clear();
}

export const PaneActivityStrip = memo(function PaneActivityStrip({ paneId }: { paneId: string }) {
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
        const specs = await listMissionPanesCoalesced(missionId);
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
});
