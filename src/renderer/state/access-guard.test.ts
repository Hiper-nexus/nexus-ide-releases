/** @vitest-environment jsdom */
import { beforeEach, expect, it } from 'vitest';
import { useAccessStore } from './access-store';
import { useToastStore } from './toast-store';
import { allowPaneCreation, reportLicenseDenial, TRIAL_AGENT_LIMIT_COPY } from './access-guard';
import { useLayoutStore } from './layout-store';
import { listPanes } from '../lib/split-tree';
beforeEach(() => { useToastStore.setState({ toasts: [] }); useAccessStore.setState({ canUseApp: false, maxAgents: 0, blockedReason: 'login-required' }); });
it('refuses creates and splits without changing the saved tree', () => {
  const before = useLayoutStore.getState().root;
  const pane = listPanes(before)[0];
  expect(useLayoutStore.getState().spawnAgent('codex', '')).toBeUndefined();
  useLayoutStore.getState().split(pane.id, 'row');
  expect(useLayoutStore.getState().root).toBe(before);
  expect(allowPaneCreation()).toBe(false);
  expect(useToastStore.getState().toasts[0].action?.label).toBe('Minha conta');
});
it('refuses the third trial agent, offers account, allows after a live agent closes', () => {
  useAccessStore.setState({ canUseApp: true, maxAgents: 2 });
  expect(allowPaneCreation(2)).toBe(false);
  expect(useToastStore.getState().toasts[0].detail).toBe(TRIAL_AGENT_LIMIT_COPY);
  expect(allowPaneCreation(1)).toBe(true);
});
it('uses the same visible refusal for wrapped IPC license errors', () => {
  expect(reportLicenseDenial(new Error('Error invoking pty:spawn: license_agent_limit'))).toBe(true);
  expect(useToastStore.getState().toasts[0].detail).toBe(TRIAL_AGENT_LIMIT_COPY);
  expect(reportLicenseDenial('license_access_denied: trial-ended')).toBe(true);
  expect(reportLicenseDenial('unrelated failure')).toBe(false);
});
it('honors unlimited Pro and never derives access from plan', () => {
  useAccessStore.setState({ canUseApp: true, maxAgents: null });
  expect(allowPaneCreation(100)).toBe(true);
  useAccessStore.setState({ canUseApp: false });
  expect(allowPaneCreation(0)).toBe(false);
});
