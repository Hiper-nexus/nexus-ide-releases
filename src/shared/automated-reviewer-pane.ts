/**
 * Stable identity used by the internal PREVC merge-review lane.
 *
 * Older releases persisted these short-lived panes without an explicit
 * transient marker. Keep this classifier deliberately exact so crash recovery
 * can discard those legacy rows without touching ordinary mission workers.
 */
export interface AutomatedReviewerPaneIdentityCandidate {
  readonly missionId?: string;
  readonly adapterId?: string;
  readonly title?: string;
  readonly agentName?: string;
  readonly role?: 'orchestrator' | 'worker';
}

export function isAutomatedReviewerPaneIdentity(
  pane: AutomatedReviewerPaneIdentityCandidate,
): boolean {
  if (
    pane.role !== 'worker' ||
    !pane.missionId ||
    !pane.adapterId ||
    !pane.title ||
    !pane.agentName
  ) {
    return false;
  }

  const titlePrefix = `review-${pane.missionId}-`;
  if (!pane.title.startsWith(titlePrefix)) return false;
  const identitySuffix = pane.title.slice(titlePrefix.length);
  // Production identity is `${index + 1}-${uuidWithoutHyphens.slice(0, 12)}`.
  if (!/^[1-9]\d*-[a-f0-9]{12}$/.test(identitySuffix)) return false;

  return pane.agentName === `reviewer-${pane.adapterId}-${identitySuffix}`;
}
