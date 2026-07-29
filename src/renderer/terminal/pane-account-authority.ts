import type { PaneModel } from '../../shared/types';

/**
 * Main owns account selection for mission/orchestration spawns. An absent
 * account in that sealed request means "provider default", not permission for
 * the renderer to discover and substitute a vault account.
 */
export function shouldAutoPinPaneAccount(
  pane: PaneModel,
  resolvedMissionId: string | undefined,
): boolean {
  return (
    pane.kind === 'cli-agent' &&
    Boolean(pane.adapterId) &&
    !pane.accountId &&
    !resolvedMissionId &&
    !pane.missionId &&
    !pane.orchRequestId
  );
}
