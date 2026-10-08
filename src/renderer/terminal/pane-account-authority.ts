import type { PaneModel } from '../../shared/types';

/**
 * Adapters whose unpinned spawn the Main already resolves with the headroom
 * rule (`prepareProviderSpawn` → `pickUnpinnedAccountWithHeadroom`). F-995:
 * the renderer used to pin the ACTIVE Claude account before the spawn, so the
 * Main saw a "pinned" pane, never ran the headroom rule and the receipt
 * listed the free sibling as "menos folga". The Main returns the account it
 * chose (`res.accountId`) and the renderer persists THAT one for resume.
 */
const MAIN_SELECTS_UNPINNED_ACCOUNT: ReadonlySet<string> = new Set(['claude']);

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
    !MAIN_SELECTS_UNPINNED_ACCOUNT.has(pane.adapterId ?? '') &&
    !pane.accountId &&
    !resolvedMissionId &&
    !pane.missionId &&
    !pane.orchRequestId
  );
}
