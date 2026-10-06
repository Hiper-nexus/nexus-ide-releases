import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectOrientationMap } from '../context/orientation/orientation-types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';
import { workspaceMemoryContextBlock } from './workspace-memory-context';

const cache = vi.hoisted(() => ({ map: null as ProjectOrientationMap | null }));
vi.mock('../context/orientation/orientation-service', () => ({
  tryGetProjectOrientationService: () => ({ peek: () => cache.map }),
}));
const scope = testProjectScope({ projectId: 'impact-project', checkoutId: 'impact-checkout' });
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-impact-'));
  configureWorkspaceMemory({ baseDir: root });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
  cache.map = {
    projectId: scope.projectId, checkoutId: scope.checkoutId,
    status: 'ready', builtAt: new Date().toISOString(), mapHash: 'map-fixture',
    inventory: { entrypoints: ['src/origin.ts'] },
    symbols: { hubs: [{ name: 'entrySwitch', samplePaths: ['src/origin.ts'] }] },
    graph: { mode: 'imports', edgeCount: 1, sampleEdges: [], adjacency: { 'src/origin.ts': ['src/billing.ts'] },
      reverse: { 'src/billing.ts': ['src/origin.ts'] } },
  } as unknown as ProjectOrientationMap;
});
afterEach(() => { disposeWorkspaceMemoryStores(); fs.rmSync(root, { recursive: true, force: true }); cache.map = null; });

it('production prompt assembly recalls an impacted file with zero lexical overlap and counts only output', () => {
  const store = getWorkspaceMemoryStore(scope);
  const fact = store.retain({ content: 'Cobrança exige identidade durável.', source: 'trusted:resolved-problem' }, { links: ['file:src/billing.ts'] });
  expect(store.recall({ query: 'Inspect entrySwitch' })).toHaveLength(0);
  const block = workspaceMemoryContextBlock(scope, 'Inspect entrySwitch');
  expect(block).toContain('Cobrança exige identidade durável');
  expect(store.recallLinked({ targets: ['file:src/billing.ts'] })[0]?.recallCount).toBe(1);
  expect(fact.id).toBeDefined();
});

it('linked knowledge survives eight unrelated lexical matches within the byte budget', () => {
  const store = getWorkspaceMemoryStore(scope);
  for (let i = 0; i < 12; i++) store.retain({ content: `entrySwitch general note ${i}`, source: 'trusted:resolved-problem' });
  store.retain({ content: 'Cobrança exige identidade durável.', source: 'trusted:resolved-problem' }, { links: ['file:src/billing.ts'] });
  const block = workspaceMemoryContextBlock(scope, 'Inspect entrySwitch');
  expect(block).toContain('Cobrança exige identidade durável');
  expect(Buffer.byteLength(block ?? '', 'utf8')).toBeLessThanOrEqual(3072);
});

it('linked knowledge that also matches FTS is reserved once even below eight higher lexical scores', () => {
  const store = getWorkspaceMemoryStore(scope);
  for (let i = 0; i < 12; i++) store.retain({ content: `entrySwitch general note ${i}`, importance: 5, source: 'trusted:resolved-problem' });
  const linked = store.retain({ content: 'entrySwitch low lexical billing invariant', importance: 1, source: 'trusted:resolved-problem' }, { links: ['file:src/billing.ts'] });
  const block = workspaceMemoryContextBlock(scope, 'Inspect entrySwitch');
  expect(block).toContain('low lexical billing invariant');
  expect(block?.match(/low lexical billing invariant/g)).toHaveLength(1);
  expect(store.recallLinked({ targets: ['file:src/billing.ts'] }).find(hit => hit.id === linked.id)?.recallCount).toBe(1);
});

it('relations use the same mission/quarantine filters and union deduplication as lexical recall', () => {
  const store = getWorkspaceMemoryStore(scope);
  const add = (text: string, mission: string, quarantine?: string) => store.retainAgentAuthored(
    { content: text }, { source: `agent-authored:mission:${(mission === 'own' ? 'a' : 'b').repeat(64)}` },
    { links: [`mission:${mission}`, 'file:src/billing.ts'], ...(quarantine ? { quarantine } : {}) });
  const own = add('Own useful insight', 'own');
  add('Other hidden insight', 'other'); add('Quarantined hidden insight', 'own', 'web');
  const lexical = store.retain({ content: 'entrySwitch exact insight', source: 'trusted:resolved-problem' }, { links: ['file:src/billing.ts'] });
  const block = workspaceMemoryContextBlock(scope, 'Inspect entrySwitch', 'execution', { missionId: 'own' });
  expect(block).toContain('Own useful insight'); expect(block).not.toContain('Other hidden'); expect(block).not.toContain('Quarantined hidden');
  expect(block?.match(/exact insight/g)).toHaveLength(1);
  const hits = store.recallLinked({ targets: ['file:src/billing.ts'] });
  expect(hits.find((h) => h.id === own.id)?.recallCount).toBe(1);
  expect(hits.find((h) => h.id === lexical.id)?.recallCount).toBe(1);
  expect(hits.filter((h) => h.content.includes('hidden')).every((h) => h.recallCount === 0)).toBe(true);
});

it.each(['missing', 'stale', 'foreign', 'old'])('%s map falls back to FTS without relationship claims', (state) => {
  if (state === 'missing') cache.map = null;
  else cache.map = { ...cache.map!, ...(state === 'stale' ? { status: 'stale' } : state === 'foreign' ? { checkoutId: 'foreign' } : { builtAt: new Date(0).toISOString() }) };
  const store = getWorkspaceMemoryStore(scope);
  store.retain({ content: 'Only relation knowledge', source: 'trusted:resolved-problem' }, { links: ['file:src/billing.ts'] });
  store.retain({ content: 'entrySwitch lexical fallback', source: 'trusted:resolved-problem' });
  const block = workspaceMemoryContextBlock(scope, 'Inspect entrySwitch');
  expect(block).toContain('lexical fallback'); expect(block).not.toContain('Only relation');
});
