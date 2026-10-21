import { describe, expect, it, vi } from 'vitest';
import type { JevResult } from '../jev/jev-client';
import {
  applyProGate,
  pickUiKit,
  pickUiKitByHeuristic,
  taskLooksLikeUiWork,
  type UiKitCandidate,
  type UiKitPickDeps,
  type UiKitPickRequest,
} from './ui-kit-pick';

const BUTTON: UiKitCandidate = {
  kit: 'shadcn', slug: 'button', label: 'Button', category: 'base', tier: 'free',
};
const DATA_TABLE: UiKitCandidate = {
  kit: 'boardui', slug: 'data-table', label: 'Data Table', category: 'block', tier: 'free',
};
const STAT_CARDS: UiKitCandidate = {
  kit: 'boardui', slug: 'stat-cards', label: 'Stat Cards', category: 'block', tier: 'free',
};
const FINANCE: UiKitCandidate = {
  kit: 'boardui', slug: 'finance-dashboard', label: 'Finance Dashboard', category: 'template', tier: 'pro',
};

function request(over: Partial<UiKitPickRequest> = {}): UiKitPickRequest {
  return {
    task: 'build a settings form',
    candidates: [BUTTON, DATA_TABLE, STAT_CARDS, FINANCE],
    ...over,
  };
}

function jevResult(answers: JevResult['answers']): JevResult {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 10 } };
}

const ON = { enabled: () => true, hasKey: () => true };

describe('taskLooksLikeUiWork', () => {
  it('separates UI work from everything else', () => {
    expect(taskLooksLikeUiWork('build the settings screen')).toBe(true);
    expect(taskLooksLikeUiWork('migrate the postgres cluster to pgbouncer')).toBe(false);
  });
});

describe('pickUiKitByHeuristic', () => {
  it('answers "no kit" for work that is not UI at all', () => {
    const result = pickUiKitByHeuristic(request({ task: 'fix the cron retry backoff' }));

    expect(result.needsKit).toBe(false);
    expect(result.kit).toBeNull();
    expect(result.source).toBe('heuristic');
  });

  it('leans BoardUI for dashboards, charts and agent surfaces', () => {
    expect(pickUiKitByHeuristic(request({ task: 'a revenue dashboard with charts and KPIs' })).kit)
      .toBe('boardui');
    expect(pickUiKitByHeuristic(request({ task: 'an AI chat composer for the agent' })).kit)
      .toBe('boardui');
  });

  it('leans shadcn for the broad primitive surface', () => {
    expect(pickUiKitByHeuristic(request({ task: 'a login form with a dialog' })).kit).toBe('shadcn');
    expect(pickUiKitByHeuristic(request({ task: 'a pricing landing page' })).kit).toBe('shadcn');
  });

  it('never names a kit the machine does not have', () => {
    const result = pickUiKitByHeuristic(
      request({ task: 'a revenue dashboard with charts', availableKits: ['shadcn'] }),
    );

    expect(result.kit).toBe('shadcn');
  });

  it('says so when no kit is reachable', () => {
    const result = pickUiKitByHeuristic(request({ task: 'a login form', availableKits: [] }));

    expect(result.needsKit).toBe(true);
    expect(result.kit).toBeNull();
    expect(result.reason).toMatch(/no UI kit is reachable/);
  });

  it('matches an item named in the task', () => {
    const result = pickUiKitByHeuristic(
      request({ task: 'add a data table to the dashboard', candidates: [DATA_TABLE, STAT_CARDS] }),
    );

    expect(result.item?.slug).toBe('data-table');
  });
});

describe('applyProGate — the free half works without a key', () => {
  it('falls back to a free item and says the Pro one needs the key', () => {
    const gated = applyProGate(
      { needsKit: true, kit: 'boardui', item: FINANCE, source: 'heuristic', needsLicense: false, reason: 'x' },
      request({ proLicensed: false }),
    );

    expect(gated.needsLicense).toBe(true);
    expect(gated.blockedItem?.slug).toBe('finance-dashboard');
    expect(gated.item?.tier).toBe('free');
    expect(gated.reason).toMatch(/needs a BoardUI Pro licence/);
  });

  it('keeps the Pro item when a licence is active', () => {
    const gated = applyProGate(
      { needsKit: true, kit: 'boardui', item: FINANCE, source: 'jev', needsLicense: false, reason: 'x' },
      request({ proLicensed: true }),
    );

    expect(gated.needsLicense).toBe(false);
    expect(gated.item?.slug).toBe('finance-dashboard');
  });

  it('reports the block when no free item of that kit fits', () => {
    const gated = applyProGate(
      { needsKit: true, kit: 'boardui', item: FINANCE, source: 'jev', needsLicense: false, reason: 'x' },
      request({ candidates: [BUTTON, FINANCE], proLicensed: false }),
    );

    expect(gated.needsLicense).toBe(true);
    expect(gated.item).toBeNull();
    expect(gated.reason).toMatch(/no free item in this kit fits/);
  });

  it('leaves a free item untouched', () => {
    const original = {
      needsKit: true as const, kit: 'shadcn' as const, item: BUTTON,
      source: 'jev' as const, needsLicense: false, reason: 'x',
    };

    expect(applyProGate(original, request())).toEqual(original);
  });
});

describe('pickUiKit — Jev on top, fail-open underneath', () => {
  it('falls back to the heuristic when the surface is off', async () => {
    const runJudge = vi.fn();

    const result = await pickUiKit(request({ task: 'a login form' }), {
      enabled: () => false, hasKey: () => true, runJudge,
    });

    expect(result.source).toBe('heuristic');
    expect(runJudge).not.toHaveBeenCalled();
  });

  it('falls back to the heuristic with no Jev credential', async () => {
    const runJudge = vi.fn();

    const result = await pickUiKit(request(), { enabled: () => true, hasKey: () => false, runJudge });

    expect(result.source).toBe('heuristic');
    expect(runJudge).not.toHaveBeenCalled();
  });

  it('falls back when the judge throws or answers nothing', async () => {
    const thrown = await pickUiKit(request({ task: 'a login form' }), {
      ...ON, runJudge: () => Promise.reject(new Error('timeout')), record: () => 'id',
    });
    const empty = await pickUiKit(request({ task: 'a login form' }), {
      ...ON, runJudge: () => Promise.resolve(null), record: () => 'id',
    });

    expect(thrown.source).toBe('heuristic');
    expect(thrown.kit).toBe('shadcn');
    expect(empty.source).toBe('heuristic');
  });

  it('takes a confident kit and item from the judge', async () => {
    const result = await pickUiKit(
      request({ task: 'something vague', candidates: [BUTTON, DATA_TABLE] }),
      {
        ...ON,
        record: () => 'id',
        runJudge: () =>
          Promise.resolve(
            jevResult({
              needsKit: { type: 'noul', noul: 0.95 },
              kit: { type: 'choice', choice: 'boardui', probabilities: { boardui: 0.9 }, confidence: 0.9 },
              item: { type: 'choice', choice: 'c2', probabilities: { c2: 0.85 }, confidence: 0.85 },
            }),
          ),
      },
    );

    expect(result.source).toBe('jev');
    expect(result.kit).toBe('boardui');
    expect(result.item?.slug).toBe('data-table');
  });

  it('ignores a low-confidence choice and keeps the heuristic kit', async () => {
    const result = await pickUiKit(request({ task: 'a login form with a dialog' }), {
      ...ON,
      record: () => 'id',
      runJudge: () =>
        Promise.resolve(
          jevResult({
            needsKit: { type: 'noul', noul: 0.9 },
            kit: { type: 'choice', choice: 'boardui', probabilities: { boardui: 0.4 }, confidence: 0.4 },
          }),
        ),
    });

    expect(result.kit).toBe('shadcn');
  });

  it('respects a judged "this needs no kit"', async () => {
    const result = await pickUiKit(request({ task: 'a login form' }), {
      ...ON,
      record: () => 'id',
      runJudge: () => Promise.resolve(jevResult({ needsKit: { type: 'noul', noul: 0.2 } })),
    });

    expect(result.needsKit).toBe(false);
    expect(result.item).toBeNull();
    expect(result.source).toBe('jev');
  });

  it('discards an item that belongs to the other kit', async () => {
    const result = await pickUiKit(
      request({ task: 'a revenue dashboard', candidates: [BUTTON, STAT_CARDS] }),
      {
        ...ON,
        record: () => 'id',
        runJudge: () =>
          Promise.resolve(
            jevResult({
              needsKit: { type: 'noul', noul: 0.9 },
              kit: { type: 'choice', choice: 'boardui', probabilities: { boardui: 0.9 }, confidence: 0.9 },
              // c1 is the shadcn Button: not an answer to "which kit".
              item: { type: 'choice', choice: 'c1', probabilities: { c1: 0.9 }, confidence: 0.9 },
            }),
          ),
      },
    );

    expect(result.kit).toBe('boardui');
    expect(result.item?.kit ?? 'boardui').toBe('boardui');
  });

  it('applies the Pro gate to a judged Pro item', async () => {
    const result = await pickUiKit(
      request({ task: 'a finance dashboard', candidates: [FINANCE, STAT_CARDS], proLicensed: false }),
      {
        ...ON,
        record: () => 'id',
        runJudge: () =>
          Promise.resolve(
            jevResult({
              needsKit: { type: 'noul', noul: 0.95 },
              kit: { type: 'choice', choice: 'boardui', probabilities: { boardui: 0.95 }, confidence: 0.95 },
              item: { type: 'choice', choice: 'c1', probabilities: { c1: 0.9 }, confidence: 0.9 },
            }),
          ),
      },
    );

    expect(result.needsLicense).toBe(true);
    expect(result.blockedItem?.slug).toBe('finance-dashboard');
    expect(result.item?.slug).toBe('stat-cards');
  });

  it('asks with the first-option order check armed and records one diary line', async () => {
    const recorded: Array<{ surface: string; kind?: string }> = [];
    const record = ((entry: { surface: string; kind?: string }) => {
      recorded.push(entry);
      return 'id';
    }) as UiKitPickDeps['record'];
    let seenOrderCheck: unknown = null;

    await pickUiKit(request({ task: 'a login form' }), {
      ...ON,
      record,
      runJudge: (input) => {
        seenOrderCheck = input.orderCheck;
        return Promise.resolve(
          jevResult({
            needsKit: { type: 'noul', noul: 0.9 },
            kit: { type: 'choice', choice: 'shadcn', probabilities: { shadcn: 0.9 }, confidence: 0.9 },
          }),
        );
      },
    });

    expect(seenOrderCheck).toEqual({ minConfidence: 0.7 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ surface: 'uiKitPick', kind: 'decision' });
  });

  it('never lets a broken diary break the answer', async () => {
    const result = await pickUiKit(request({ task: 'a login form' }), {
      ...ON,
      record: () => {
        throw new Error('disk full');
      },
      runJudge: () =>
        Promise.resolve(
          jevResult({
            needsKit: { type: 'noul', noul: 0.9 },
            kit: { type: 'choice', choice: 'shadcn', probabilities: { shadcn: 0.9 }, confidence: 0.9 },
          }),
        ),
    });

    expect(result.kit).toBe('shadcn');
  });
});
