import type { ExternalIssue } from '../../shared/integrations-types';
import {
  formatIssueMissionBrief,
  formatIssueMissionTitle,
} from '../../shared/issue-mission-brief';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';

/** Abre o fluxo de missão existente com o título/body da issue como brief. */
export function startMissionFromIssue(issue: ExternalIssue): void {
  useProductNavigationStore.getState().openNewMission();
  const setup = useMissionSetupStore.getState();
  setup.setTitle(formatIssueMissionTitle(issue));
  setup.setObjective(formatIssueMissionBrief(issue));
}
