import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureJevDecisionLog,
  jevAnswerProbabilities,
  jevDecisionStats,
  listJevDecisions,
  recordJevDecision,
  setJevDecisionFeedback,
  type JevDecisionInput,
} from './jev-decision-log';

let dir: string;

function entry(overrides: Partial<JevDecisionInput> = {}): JevDecisionInput {
  return {
    surface: 'handoffReview',
    sessionId: 's1',
    model: 'jev-1.13.0',
    questions: ['is_specific', 'has_verification'],
    probabilities: { is_specific: 0.9, has_verification: 0.84 },
    decision: 'ok',
    inputTokens: 600,
    usd: 0.0000252,
    ...overrides,
  };
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  configureJevDecisionLog(undefined);
});

describe('jev decision log', () => {
  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-log-'));
    configureJevDecisionLog(dir);
    return dir;
  }

  it('appends and lists newest first', () => {
    const d = setup();
    recordJevDecision(entry({ decision: 'retry' }), { dir: d });
    recordJevDecision(entry({ decision: 'ok' }), { dir: d });
    const list = listJevDecisions({ dir: d });
    expect(list).toHaveLength(2);
    expect(list[0].decision).toBe('ok');
    expect(list[1].decision).toBe('retry');
    expect(list[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('filters by surface and honors limit', () => {
    const d = setup();
    recordJevDecision(entry({ surface: 'intake', decision: 'route:mission-work' }), { dir: d });
    recordJevDecision(entry({ surface: 'handoffReview' }), { dir: d });
    expect(listJevDecisions({ dir: d, surface: 'intake' })).toHaveLength(1);
    expect(listJevDecisions({ dir: d, limit: 1 })).toHaveLength(1);
  });

  it('never stores state text — only ids, numbers, decisions', () => {
    const d = setup();
    recordJevDecision(entry());
    const raw = fs.readFileSync(path.join(d, 'decisions.jsonl'), 'utf8');
    expect(raw).not.toContain('summary');
    expect(JSON.parse(raw)).not.toHaveProperty('state');
  });

  it('sets feedback in place', () => {
    const d = setup();
    const id = recordJevDecision(entry());
    expect(setJevDecisionFeedback(id, 'wrong', { dir: d })).toBe(true);
    const list = listJevDecisions({ dir: d });
    expect(list[0].feedback).toBe('wrong');
    expect(list[0].feedbackAt).toBeGreaterThan(0);
    expect(setJevDecisionFeedback('nonexistent', 'right', { dir: d })).toBe(false);
  });

  it('rotates when over 5 MB keeping one generation', () => {
    const d = setup();
    const file = path.join(d, 'decisions.jsonl');
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 10));
    recordJevDecision(entry(), { dir: d });
    expect(fs.existsSync(path.join(d, 'decisions.1.jsonl'))).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(1000);
    expect(listJevDecisions({ dir: d })).toHaveLength(1);
  });

  it('aggregates stats per surface with feedback and suggestion', () => {
    const d = setup();
    for (let i = 0; i < 10; i++) {
      const id = recordJevDecision(
        entry({ surface: 'terminalTriage', decision: 'triage:flaky' }),
        { dir: d },
      );
      if (i < 4) setJevDecisionFeedback(id, 'wrong', { dir: d });
      else setJevDecisionFeedback(id, 'right', { dir: d });
    }
    const stats = jevDecisionStats({ dir: d });
    expect(stats.totals.calls).toBe(10);
    expect(stats.totals.inputTokens).toBe(6000);
    expect(stats.bySurface.terminalTriage.calls).toBe(10);
    expect(stats.bySurface.terminalTriage.decisions['triage:flaky']).toBe(10);
    expect(stats.bySurface.terminalTriage.feedback).toEqual({
      right: 6,
      wrong: 4,
    });
    expect(stats.bySurface.terminalTriage.suggestion).toContain('Muitos erros');
  });

  it('suggests relaxing thresholds when stable', () => {
    const d = setup();
    for (let i = 0; i < 10; i++) {
      const id = recordJevDecision(entry({ surface: 'rank' }), { dir: d });
      setJevDecisionFeedback(id, 'right', { dir: d });
    }
    expect(jevDecisionStats({ dir: d }).bySurface.rank.suggestion).toContain(
      'Estável',
    );
  });

  it('jevAnswerProbabilities normalizes noul/choice/score', () => {
    expect(
      jevAnswerProbabilities({
        n: { type: 'noul', noul: 0.7 },
        c: {
          type: 'choice',
          choice: 'b',
          probabilities: { a: 0.2, b: 0.8 },
          confidence: 0.9,
        },
        s: {
          type: 'score',
          score: 2,
          legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd' },
          probabilities: {},
          confidence: 0.5,
        },
      }),
    ).toEqual({ n: 0.7, c: 0.8, s: 2 / 3 });
  });
});
