/**
 * Multi-workspace / multi-window isolation contracts.
 *
 * Electron multi-window is not exercised here (no Playwright harness).
 * These unit tests pin the isolation rules that multi-window must obey:
 * SearchMixer per root, pane recovery scope filtering.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { PaneSnapshot } from '../../shared/orch-types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getSearchMixer,
  resetSearchMixerForTests,
  runSearchMixerQuery,
} from '../search/search-mixer-bootstrap';
import { testProjectScope } from './__tests__/scope-fixture';
import { hasMirroredScope, snapshotsForScope } from './mission-driver-io';

const scopeA = testProjectScope({
  projectId: 'project-a',
  checkoutId: 'check-a',
  rootRealPath: '/ws-a',
});
const scopeB = testProjectScope({
  projectId: 'project-b',
  checkoutId: 'check-b',
  rootRealPath: '/ws-b',
});

afterEach(() => {
  resetSearchMixerForTests();
});

describe('multi-workspace isolation (multi-window confidence)', () => {
  it('isolates SearchMixer instances and cancel domains per workspace root', () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    const a = getSearchMixer('/ws-a');
    const b = getSearchMixer('/ws-b');
    expect(a).not.toBe(b);
    expect(getSearchMixer('/ws-a')).toBe(a);
    expect(getSearchMixer('/ws-b')).toBe(b);
  });

  it('does not share search generation across workspace roots', async () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    const ra = await runSearchMixerQuery({
      text: 'alpha',
      limit: 3,
      projectRoot: '/ws-a',
    });
    const rb = await runSearchMixerQuery({
      text: 'beta',
      limit: 3,
      projectRoot: '/ws-b',
    });
    expect(ra.generation).toBeGreaterThan(0);
    expect(rb.generation).toBeGreaterThan(0);
    const ra2 = await runSearchMixerQuery({
      text: 'alpha2',
      limit: 3,
      projectRoot: '/ws-a',
    });
    expect(ra2.generation).toBeGreaterThan(ra.generation);
  });

  it('filters foreign workspace panes from recovery decisions', () => {
    const snapshots: PaneSnapshot[] = [
      {
        paneId: 'pane-shared-id',
        sessionId: 'sess-a',
        title: 'Orch A',
        kind: 'cli-agent',
        state: 'busy',
        role: 'orchestrator',
        scope: scopeA,
      },
      {
        paneId: 'pane-shared-id',
        sessionId: 'sess-b',
        title: 'Orch B',
        kind: 'cli-agent',
        state: 'busy',
        role: 'orchestrator',
        scope: scopeB,
      },
      {
        paneId: 'pane-unknown',
        sessionId: 'sess-u',
        title: 'Worker',
        kind: 'cli-agent',
        state: 'busy',
        role: 'worker',
      },
    ];

    const forA = snapshotsForScope(scopeA, snapshots);
    expect(forA.map((s) => s.sessionId).sort()).toEqual(['sess-a', 'sess-u']);

    const forB = snapshotsForScope(scopeB, snapshots);
    expect(forB.map((s) => s.sessionId).sort()).toEqual(['sess-b', 'sess-u']);

    expect(hasMirroredScope(scopeA, snapshots)).toBe(true);
    expect(
      hasMirroredScope(scopeA, [
        {
          paneId: 'x',
          sessionId: 'y',
          title: 'foreign',
          kind: 'cli-agent',
          state: 'busy',
          role: 'orchestrator',
          scope: scopeB,
        },
      ]),
    ).toBe(false);
  });

  it('never treats a foreign scoped live pane as mirrored for recovery', () => {
    const foreignOnly: PaneSnapshot[] = [
      {
        paneId: 'mission-1',
        sessionId: 'sess-foreign',
        title: 'Foreign orch',
        kind: 'cli-agent',
        state: 'busy',
        role: 'orchestrator',
        executionScope: scopeB,
      },
    ];
    expect(hasMirroredScope(scopeA, foreignOnly)).toBe(false);
    expect(snapshotsForScope(scopeA, foreignOnly)).toEqual([]);
  });
});
