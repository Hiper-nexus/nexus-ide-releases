/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExternalIssue } from '../../shared/integrations-types';
import { setActiveWorkspacePath } from '../state/active-workspace';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { startMissionFromIssue } from './start-mission-from-issue';

const issue: ExternalIssue = {
  id: 'gh-3',
  provider: 'github',
  number: 3,
  title: 'Corrigir timeout',
  url: 'https://github.com/acme/app/issues/3',
  state: 'open',
  labels: [],
};

describe('startMissionFromIssue', () => {
  beforeEach(() => {
    setActiveWorkspacePath('/tmp/issue-mission');
    useMissionSetupStore.getState().beginFreshMission('/tmp/issue-mission');
    useProductNavigationStore.getState().openLauncher();
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
  });

  it('abre o setup de missão com o brief da issue', () => {
    startMissionFromIssue(issue);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(useMissionSetupStore.getState().draft.title).toBe('#3 Corrigir timeout');
    expect(useMissionSetupStore.getState().draft.objective).toContain('Fixes #3');
    expect(useMissionSetupStore.getState().draft.objective).toContain(
      'https://github.com/acme/app/issues/3',
    );
  });
});
