import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
} from '../memory/workspace-memory';
import {
  getSearchMixer,
  resetSearchMixerForTests,
  runSearchMixerQuery,
} from './search-mixer-bootstrap';

const roots: string[] = [];

afterEach(() => {
  resetSearchMixerForTests();
  disposeWorkspaceMemoryStores();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('search mixer bootstrap', () => {
  it('registers ripgrep files AND shallow workspaces without overwrite', () => {
    const mixer = getSearchMixer();
    expect(mixer).toBe(getSearchMixer());
    // Critical: one provider per source key — shallow must not clobber ripgrep.
    const sources = mixer.sources();
    expect(sources).toContain('files');
    expect(sources).toContain('workspaces');
    expect(sources).toContain('missions');
    expect(sources).toContain('skills');
    // uniqueness
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('isolates mixers per workspace root (no cross-cancel)', () => {
    const a = getSearchMixer('/ws-a');
    const b = getSearchMixer('/ws-b');
    expect(a).not.toBe(b);
    expect(getSearchMixer('/ws-a')).toBe(a);
  });

  it('returns empty when flag off; runs when flag on', async () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, false);
    const off = await runSearchMixerQuery({ text: 'x', limit: 5 });
    expect(off.hits).toEqual([]);
    expect(off.generation).toBe(0);

    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    const on = await runSearchMixerQuery({ text: 'x', limit: 5 });
    // generation advances on live mixer searchNow
    expect(on.generation).toBeGreaterThan(0);
  });

  it('searches mission notes from the external canonical projection', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-memory-db-'));
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-search-memory-project-'),
    );
    roots.push(baseDir, projectRoot);
    configureWorkspaceMemory({ baseDir });
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    getWorkspaceMemoryStore({
      version: 1,
      installationId: 'installation-search',
      projectId: 'project-search-memory',
      checkoutId: 'checkout-search',
      rootRealPath: projectRoot,
      identitySource: 'manifest',
    }).retain({
      content: '# Mission Checkout Clean\n\nProjection lives outside Git.',
      kind: 'fact',
      source: 'agent-authored:mission:mission-clean',
    });

    const result = await runSearchMixerQuery({
      text: 'Checkout Clean',
      sources: ['missions'],
      limit: 5,
      projectRoot,
      workspaceId: 'project-search-memory',
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        source: 'missions',
        title: 'Mission Checkout Clean',
      }),
    ]);
    expect(result.hits[0]).not.toHaveProperty('path');
    expect(fs.existsSync(path.join(projectRoot, '.nexus-memory'))).toBe(false);
  });
});
