import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiKitCliRunRequest } from './ui-kit-cli';
import {
  installPickReceipt,
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
