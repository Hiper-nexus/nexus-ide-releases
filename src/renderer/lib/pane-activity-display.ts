import type {
  MissionPaneSpec,
  PaneActivitySummary,
} from '../../shared/orch-types';

export function resolvePaneActivity(
  specs: readonly MissionPaneSpec[],
  paneId: string,
): PaneActivitySummary | null {
  return specs.find((spec) => spec.paneId === paneId)?.activity ?? null;
}

export function paneActivityDisplay(
  activity: PaneActivitySummary | null | undefined,
): { text: string; title: string } | null {
  const firstTask = activity?.title?.trim() ?? '';
  const latest = activity?.lastLine?.trim() ?? '';
  const text = latest || firstTask;
  if (!text) return null;
  return {
    text,
    title:
      firstTask && latest && firstTask !== latest
        ? `${firstTask} — ${latest}`
        : text,
  };
}
