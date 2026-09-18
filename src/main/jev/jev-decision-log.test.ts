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
  recordJevNoAnswer,
  setJevDecisionFeedback,
  type JevDecisionEntry,
  type JevDecisionInput,
} from './jev-decision-log';
import { USD_PER_INPUT_TOKEN } from './jev-pricing';

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

  it('exclui no-answer da lista por padrão e inclui com a flag', () => {
    const d = setup();
    recordJevDecision(entry({ decision: 'ok' }), { dir: d });
    recordJevNoAnswer(
      { surface: 'handoffReview', reason: 'timeout', model: 'jev-1.13.0' },
      { dir: d },
    );
    const answered = listJevDecisions({ dir: d });
    expect(answered).toHaveLength(1);
    expect(answered[0].decision).toBe('ok');
    const all = listJevDecisions({ dir: d, includeNoAnswer: true });
    expect(all).toHaveLength(2);
    const noAnswer = all.find((e) => e.kind === 'no-answer');
    expect(noAnswer?.reason).toBe('timeout');
    expect(noAnswer?.decision).toBe('rule');
    expect(noAnswer?.questions).toEqual([]);
    expect(noAnswer?.usd).toBe(0);
    expect(noAnswer?.inputTokens).toBe(0);
  });

  function writeEntry(d: string, e: Partial<JevDecisionEntry>): void {
    const line: JevDecisionEntry = {
      id: `id-${Math.random().toString(36).slice(2)}`,
      at: Date.now(),
      surface: 'handoffReview',
      model: 'jev-1.13.0',
      questions: ['q'],
      probabilities: { q: 0.9 },
      decision: 'ok',
      inputTokens: 100,
      usd: 0.0000042,
      ...e,
    };
    fs.appendFileSync(
      path.join(d, 'decisions.jsonl'),
      JSON.stringify(line) + '\n',
    );
  }

  it('agrega janelas hoje/30d/desde sempre e o split jev/regra por superfície', () => {
    const d = setup();
    const now = Date.now();
    writeEntry(d, { at: now - 60_000, usd: 0.001, inputTokens: 1000 });
    writeEntry(d, { at: now - 10 * 86_400_000, usd: 0.002, inputTokens: 2000 });
    writeEntry(d, { at: now - 40 * 86_400_000, usd: 0.004, inputTokens: 4000 });
    writeEntry(d, {
      at: now - 30_000,
      kind: 'no-answer',
      reason: 'timeout',
      questions: [],
      probabilities: {},
      decision: 'rule',
      inputTokens: 0,
      usd: 0,
    });
    const stats = jevDecisionStats({ dir: d, now });
    expect(stats.windows.today.consultations).toBe(2);
    expect(stats.windows.today.answered).toBe(1);
    expect(stats.windows.today.noAnswer).toBe(1);
    expect(stats.windows.last30d.consultations).toBe(3);
    expect(stats.windows.last30d.answered).toBe(2);
    expect(stats.windows.last30d.noAnswer).toBe(1);
    expect(stats.windows.last30d.usd).toBeCloseTo(0.003, 6);
    expect(stats.windows.allTime.consultations).toBe(4);
    expect(stats.windows.allTime.answered).toBe(3);
    expect(stats.windows.allTime.noAnswer).toBe(1);
    expect(stats.windows.allTime.usd).toBeCloseTo(0.007, 6);
    expect(stats.windows.allTime.inputTokens).toBe(7000);
    expect(stats.totals.calls).toBe(3);
    expect(stats.totals.noAnswer).toBe(1);
    expect(stats.totals.usd).toBeCloseTo(0.007, 6);
    const bucket = stats.bySurface.handoffReview;
    expect(bucket.calls).toBe(3);
    expect(bucket.noAnswer).toBe(1);
    expect(bucket.last30d).toEqual({ jev: 2, rule: 1, usd: 0.003 });
    expect(stats.pricing).toEqual({
      usdPerInputToken: USD_PER_INPUT_TOKEN,
      source: 'typesafe-published',
    });
  });

  it('stats e lista contam o arquivo rotacionado (decisions.1.jsonl)', () => {
    const d = setup();
    fs.writeFileSync(
      path.join(d, 'decisions.1.jsonl'),
      JSON.stringify({
        id: 'rot-1',
        at: Date.now() - 60_000,
        surface: 'intake',
        model: 'jev-1.13.0',
        questions: ['q'],
        probabilities: {},
        decision: 'route:mission',
        inputTokens: 50,
        usd: 0.0000021,
      }) + '\n',
    );
    recordJevDecision(entry({ decision: 'ok' }), { dir: d });
    const list = listJevDecisions({ dir: d });
    expect(list).toHaveLength(2);
    expect(list[1].id).toBe('rot-1');
    const stats = jevDecisionStats({ dir: d });
    expect(stats.totals.calls).toBe(2);
    expect(stats.bySurface.intake.calls).toBe(1);
  });

  it('feedback não alcança id do arquivo rotacionado', () => {
    const d = setup();
    fs.writeFileSync(
      path.join(d, 'decisions.1.jsonl'),
      JSON.stringify({
        id: 'rot-fb',
        at: Date.now(),
        surface: 'intake',
        model: 'jev-1.13.0',
        questions: [],
        probabilities: {},
        decision: 'ok',
        inputTokens: 0,
        usd: 0,
      }) + '\n',
    );
    expect(setJevDecisionFeedback('rot-fb', 'right', { dir: d })).toBe(false);
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
