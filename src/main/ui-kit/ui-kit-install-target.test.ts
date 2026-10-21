import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiKitCliRunRequest } from './ui-kit-cli';
import {
  installPickReceipt,
  interleaveByKit,
  rankForTask,
  resolveInstallTargetForTask,
} from './ui-kit-install-target';
import { resetBoardUiFreeListCacheForTests, type UiKitServiceDeps } from './ui-kit-service';

const judge = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../jev/jev-client', () => ({
  judge: judge.fn,
  capText: (value: string) => value,
}));
const surface = vi.hoisted(() => ({ on: true, key: true }));
vi.mock('../jev/jev-autopilot', () => ({ isJevSurfaceEnabled: () => surface.on }));
vi.mock('../decision-models/decision-availability', () => ({
  hasDecisionCredential: () => surface.key,
}));
// Partial: only the WRITE is stubbed. Guessing the module's other exports one
// at a time is how a mock drifts from the real thing.
vi.mock('../jev/jev-decision-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jev/jev-decision-log')>()),
  recordJevDecision: () => {},
}));

let dir = '';
let cwd = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-target-'));
  cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
  surface.on = true;
  surface.key = true;
  judge.fn.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetBoardUiFreeListCacheForTests();
});

/** The shadcn `--json` shape, plus BoardUI's text listing. */
function harness(
  over: { licence?: string } = {},
): { deps: UiKitServiceDeps; runs: UiKitCliRunRequest[] } {
  const runs: UiKitCliRunRequest[] = [];
  return {
    runs,
    deps: {
      runCli: async (request) => {
        runs.push(request);
        if (request.kit === 'boardui') {
          return { stdout: '  stat-cards  Metric tiles.\n', stderr: '', code: 0 };
        }
        return {
          stdout: JSON.stringify({
            items: [
              { name: 'button', type: 'registry:ui', registry: '@shadcn' },
              { name: 'login-01', type: 'registry:block', registry: '@shadcn' },
            ],
          }),
          stderr: '',
          code: 0,
        };
      },
      callMcp: async () => ({
        result: {},
        text: over.licence ?? 'license: inactive',
        isError: false,
      }),
      getSecret: () => 'BUI-KEY',
      setSecret: () => ({ ok: true }),
      cacheOptions: { rootDir: dir },
    },
  };
}

/** The pick asks three questions; a partial answer falls back by design. */
function jevPicked(candidateKey: string, kit = 'shadcn'): void {
  judge.fn.mockResolvedValue({
    model: 'jev-1.13.0',
    answers: {
      // The real `JevAnswer` union is discriminated by `type`.
      needsKit: { type: 'noul', noul: 0.95 },
      kit: { type: 'choice', choice: kit, confidence: 0.9, probabilities: { [kit]: 0.9 } },
      item: {
        type: 'choice',
        choice: candidateKey,
        confidence: 0.9,
        probabilities: { [candidateKey]: 0.9 },
      },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  });
}

describe('resolveInstallTargetForTask', () => {
  it('resolves a task against the LIVE catalogue', async () => {
    const h = harness();
    jevPicked('c2');

    const result = await resolveInstallTargetForTask(
      { task: 'a sign-in screen', kit: 'shadcn', cwd },
      h.deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.kit).toBe('shadcn');
    // c2 is the second live candidate: `login-01`, which is the sign-in block.
    expect(result.target.items).toEqual(['login-01']);
    expect(result.pick.source).toBe('jev');
    // It asked the vendor: that is the point of being on the effectful path.
    expect(h.runs.some((run) => run.args[0] === 'search')).toBe(true);
  });

  it('honours a kit the caller named and asks no other vendor', async () => {
    const h = harness();
    jevPicked('c1');

    await resolveInstallTargetForTask({ task: 'a button', kit: 'shadcn', cwd }, h.deps);

    expect(h.runs.every((run) => run.kit === 'shadcn')).toBe(true);
  });

  it('does not probe the BoardUI licence for a shadcn-only install', async () => {
    // Asking would spawn the vendor's MCP server for nothing.
    const calls: unknown[] = [];
    const h = harness();
    jevPicked('c1');

    await resolveInstallTargetForTask({ task: 'a button', kit: 'shadcn', cwd }, {
      ...h.deps,
      callMcp: async (request) => {
        calls.push(request);
        return { result: {}, text: 'license: inactive', isError: false };
      },
    });

    expect(calls).toEqual([]);
  });

  it('answers with the offline rule and no egress when there is no Jev key', async () => {
    // A client with no credential keeps a wholly classic Nexus.
    surface.key = false;
    const h = harness();

    const result = await resolveInstallTargetForTask(
      { task: 'a login form', kit: 'shadcn', cwd },
      h.deps,
    );

    expect(judge.fn).not.toHaveBeenCalled();
    expect(result.pick.source).toBe('heuristic');
  });

  it('relays "no component for this" instead of installing something', async () => {
    const h = harness();
    judge.fn.mockResolvedValue({
      model: 'jev-1.13.0',
      answers: { needsKit: { type: 'noul', noul: 0.02 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    const result = await resolveInstallTargetForTask(
      { task: 'rename a database column', kit: 'shadcn', cwd },
      h.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.pick.needsKit).toBe(false);
  });
});

describe('installPickReceipt', () => {
  it('carries ids and the reason, never the task text', () => {
    const receipt = installPickReceipt({
      needsKit: true,
      kit: 'boardui',
      item: {
        kit: 'boardui',
        slug: 'stat-cards',
        label: 'Stat Cards',
        category: 'block',
        tier: 'free',
      },
      source: 'jev',
      needsLicense: true,
      blockedItem: {
        kit: 'boardui',
        slug: 'template-home-dashboard',
        label: 'Home Dashboard',
        category: 'template',
        tier: 'pro',
      },
      reason: 'fell back to a free item',
    });

    expect(receipt).toEqual({
      decidedBy: 'jev',
      kit: 'boardui',
      item: 'stat-cards',
      needsKit: true,
      reason: 'fell back to a free item',
      needsLicense: true,
      blocked: 'template-home-dashboard',
    });
  });
});

describe('interleaveByKit', () => {
  const entry = (kit: 'shadcn' | 'boardui', n: number) => ({
    kit,
    slug: `${kit}-${n}`,
    label: `${kit} ${n}`,
    category: 'ui',
    tier: 'free' as const,
  });

  it('keeps BoardUI reachable when shadcn fills the whole limit', () => {
    // The bug: concatenating and truncating. A shadcn search returns up to its
    // 200-item limit, so every slot went to shadcn and a dashboard task could
    // never pick a BoardUI item although both vendors had been asked. And the
    // pick itself keeps only 12, so "the list was big" was never the answer.
    const shadcn = Array.from({ length: 200 }, (_, index) => entry('shadcn', index));
    const boardui = Array.from({ length: 60 }, (_, index) => entry('boardui', index));

    const head = interleaveByKit([shadcn, boardui], 120).slice(0, 12);

    expect(head.some((candidate) => candidate.kit === 'boardui')).toBe(true);
    expect(head.some((candidate) => candidate.kit === 'shadcn')).toBe(true);
  });

  it('respects the limit and loses nothing to a shorter list', () => {
    const shadcn = [entry('shadcn', 1), entry('shadcn', 2), entry('shadcn', 3)];
    const boardui = [entry('boardui', 1)];

    expect(interleaveByKit([shadcn, boardui], 10).map((c) => c.slug)).toEqual([
      'shadcn-1',
      'boardui-1',
      'shadcn-2',
      'shadcn-3',
    ]);
    expect(interleaveByKit([shadcn, boardui], 2)).toHaveLength(2);
  });

  it('is empty for no kits at all', () => {
    expect(interleaveByKit([], 10)).toEqual([]);
    expect(interleaveByKit([[]], 10)).toEqual([]);
  });
});

describe('rankForTask', () => {
  const item = (slug: string, category: string) => ({
    kit: 'boardui' as const,
    slug,
    label: slug,
    category,
    tier: 'free' as const,
  });

  /** BoardUI's own listing order: primitives first, dashboard parts late. */
  const CATALOGUE = [
    item('tree-view', 'base'),
    item('button', 'base'),
    item('icon-button', 'base'),
    item('link-button', 'base'),
    item('button-group', 'base'),
    item('close-button', 'base'),
    item('input', 'base'),
    item('textarea', 'base'),
    item('checkbox', 'base'),
    item('radio', 'base'),
    item('switch', 'base'),
    item('select', 'base'),
    item('stat-cards', 'block'),
    item('revenue-chart-card', 'block'),
    item('data-table', 'block'),
    item('template-home-dashboard', 'template'),
  ];

  it('puts what matches the task first', () => {
    const head = rankForTask('build a home dashboard', CATALOGUE).slice(0, 3);

    expect(head.map((entry) => entry.slug)).toContain('template-home-dashboard');
  });

  it('spreads categories when nothing matches lexically', () => {
    // "build an admin area" shares no word with any slug, and the pick keeps
    // only 12 — so the blocks and the template must not sit behind twelve
    // primitives.
    const head = rankForTask('build an admin area', CATALOGUE).slice(0, 12);
    const categories = new Set(head.map((entry) => entry.category));

    expect(categories).toContain('block');
    expect(categories).toContain('template');
    expect(head.map((entry) => entry.slug)).toContain('stat-cards');
    expect(head.map((entry) => entry.slug)).toContain('data-table');
  });

  it('loses nothing: every candidate still comes back', () => {
    expect(rankForTask('whatever', CATALOGUE)).toHaveLength(CATALOGUE.length);
  });

  it('ignores words too short to carry signal', () => {
    // `a`, `an`, `of` would otherwise match almost every slug.
    const ranked = rankForTask('a an of', CATALOGUE);

    expect(ranked).toHaveLength(CATALOGUE.length);
    expect(ranked[0]?.category).toBe('base');
  });
});
