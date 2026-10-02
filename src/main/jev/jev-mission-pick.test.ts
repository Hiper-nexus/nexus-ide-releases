import { describe, expect, it, vi } from 'vitest';
import type { JevAnswer, JevResult } from './jev-client';
import type { JevDecisionInput } from './jev-decision-log';
import type { MissionPickRequest } from '../../shared/mission-pick';
import {
  MISSION_PICK_MIN_CONFIDENCE,
  MISSION_PICK_MIN_MARGIN,
  MISSION_PICK_NO_MATCH_MIN_CONFIDENCE,
  MISSION_PICK_NO_MATCH_MIN_MARGIN,
  MISSION_PICK_STATE_MAX_BYTES,
  buildMissionPickQuestion,
  buildMissionPickState,
  evaluateMissionPickAnswer,
  pickMissionWithJev,
} from './jev-mission-pick';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function request(...titles: string[]): MissionPickRequest {
  return {
    spoken: 'site loja',
    candidates: titles.map((title, index) => ({
      title,
      state: index === 0 ? 'running' : 'completed',
      updatedAt: NOW - (index + 1) * 5 * MINUTE,
    })),
  };
}

function choice(
  chosen: string,
  probabilities: Record<string, number>,
  confidence: number,
): JevAnswer {
  return { type: 'choice', choice: chosen, probabilities, confidence };
}

function jevResult(answer: JevAnswer): JevResult {
  return {
    model: 'jev-1.13.0',
    answers: { pick: answer },
    usage: { input_tokens: 180, output_tokens: 6 },
  };
}

describe('evaluateMissionPickAnswer (accept rule)', () => {
  const probs = { m1: 0.8, m2: 0.15, none: 0.05 };

  it('refuses a confidence of 0.69', () => {
    expect(evaluateMissionPickAnswer(choice('m1', probs, 0.69), 2)).toEqual({
      decision: 'undecided',
      reason: 'low-confidence',
    });
  });

  it('refuses 0.70 when the margin over the runner-up is short', () => {
    const closeRace = { m1: 0.45, m2: 0.4, none: 0.15 };
    expect(evaluateMissionPickAnswer(choice('m1', closeRace, 0.7), 2)).toEqual({
      decision: 'undecided',
      reason: 'narrow-margin',
    });
  });

  it('accepts 0.70 with a wide enough margin', () => {
    expect(evaluateMissionPickAnswer(choice('m2', { m1: 0.2, m2: 0.7, none: 0.1 }, 0.7), 2)).toEqual({
      decision: 'picked',
      index: 1,
      confidence: 0.7,
    });
  });

  it('accepts a margin of exactly 0.15 (floating point does not tip it over)', () => {
    expect(MISSION_PICK_MIN_MARGIN).toBe(0.15);
    expect(MISSION_PICK_MIN_CONFIDENCE).toBe(0.7);
    const exact = { m1: 0.7, m2: 0.55, none: 0 };
    expect(evaluateMissionPickAnswer(choice('m1', exact, 0.7), 2)).toMatchObject({ decision: 'picked', index: 0 });
  });

  it('counts "none" as a runner-up: a strong none next to the winner is doubt', () => {
    const doubtful = { m1: 0.5, m2: 0.1, none: 0.4 };
    expect(evaluateMissionPickAnswer(choice('m1', doubtful, 0.8), 2)).toMatchObject({
      reason: 'narrow-margin',
    });
  });

  it('turns a "none" answer into no decision, however confident', () => {
    expect(evaluateMissionPickAnswer(choice('none', { m1: 0.01, m2: 0.01, none: 0.98 }, 0.98), 2)).toEqual({
      decision: 'undecided',
      reason: 'none',
    });
  });

  it.each([
    ['an id past the candidates', choice('m3', { m1: 0.1, m2: 0.1, m3: 0.05, none: 0.75 }, 0.95)],
    ['an id that is not mN', choice('mission-1', { m1: 0.1, m2: 0.1, none: 0.8 }, 0.95)],
    ['m0', choice('m0', { m1: 0.1, m2: 0.1, none: 0.8 }, 0.95)],
    ['a choice that is not the most probable option', choice('m1', { m1: 0.2, m2: 0.7, none: 0.1 }, 0.95)],
    ['a choice missing from its own distribution', choice('m1', { m2: 0.9, none: 0.1 }, 0.95)],
    ['a non-choice answer', { type: 'noul', noul: 0.9 } as JevAnswer],
    ['no answer at all', undefined],
  ])('refuses %s', (_label, answer) => {
    expect(evaluateMissionPickAnswer(answer, 2)).toEqual({
      decision: 'undecided',
      reason: 'invalid-answer',
    });
  });
});

describe('evaluateMissionPickAnswer, no-match path (noisy speech: stricter floor)', () => {
  // Confiança e margem são medidas independentes: aqui a confiança vem do campo do
  // Jev e a margem da distribuição (m2 0,6 contra a 2ª opção).
  const withMargin = (margin: number, chosen = 'm2') => ({
    [chosen]: 0.6,
    m1: Number((0.6 - margin).toFixed(2)),
    none: 0.05,
  });

  it('exposes the floor: confidence 0.85 and margin 0.30', () => {
    expect(MISSION_PICK_NO_MATCH_MIN_CONFIDENCE).toBe(0.85);
    expect(MISSION_PICK_NO_MATCH_MIN_MARGIN).toBe(0.3);
  });

  it('accepts confidence 0.9 with margin 0.4', () => {
    expect(evaluateMissionPickAnswer(choice('m2', withMargin(0.4), 0.9), 2, 'noMatch')).toEqual({
      decision: 'picked',
      index: 1,
      confidence: 0.9,
    });
  });

  it('refuses confidence 0.84 even with a wide margin', () => {
    expect(evaluateMissionPickAnswer(choice('m2', withMargin(0.4), 0.84), 2, 'noMatch')).toEqual({
      decision: 'undecided',
      reason: 'low-confidence',
    });
  });

  it('accepts confidence of exactly 0.85 and margin of exactly 0.30', () => {
    expect(evaluateMissionPickAnswer(choice('m2', withMargin(0.3), 0.85), 2, 'noMatch')).toMatchObject({
      decision: 'picked',
      index: 1,
    });
  });

  it('refuses a margin of 0.29 even with high confidence', () => {
    expect(evaluateMissionPickAnswer(choice('m2', withMargin(0.29), 0.95), 2, 'noMatch')).toEqual({
      decision: 'undecided',
      reason: 'narrow-margin',
    });
  });

  it('counts "none" as the runner-up here too', () => {
    const noneClose = { m1: 0.01, m2: 0.6, none: 0.39 };
    expect(evaluateMissionPickAnswer(choice('m2', noneClose, 0.9), 2, 'noMatch')).toMatchObject({
      reason: 'narrow-margin',
    });
  });

  it('refuses a "none" answer however confident', () => {
    expect(evaluateMissionPickAnswer(choice('none', { m1: 0.01, m2: 0.01, none: 0.98 }, 0.98), 2, 'noMatch')).toEqual({
      decision: 'undecided',
      reason: 'none',
    });
  });

  it('is stricter than the tie-break floor: the same answer passes there and not here', () => {
    const answer = choice('m2', { m1: 0.1, m2: 0.75, none: 0.15 }, 0.8);
    expect(evaluateMissionPickAnswer(answer, 2)).toMatchObject({ decision: 'picked' });
    expect(evaluateMissionPickAnswer(answer, 2, 'ambiguous')).toMatchObject({ decision: 'picked' });
    expect(evaluateMissionPickAnswer(answer, 2, 'noMatch')).toMatchObject({ reason: 'low-confidence' });
  });

  it('applies the same validity checks (index range, argmax)', () => {
    expect(evaluateMissionPickAnswer(choice('m9', { m1: 0.05, m2: 0.05, none: 0.9 }, 0.95), 2, 'noMatch')).toMatchObject({ reason: 'invalid-answer' });
    expect(evaluateMissionPickAnswer(choice('m1', { m1: 0.2, m2: 0.7, none: 0.1 }, 0.95), 2, 'noMatch')).toMatchObject({ reason: 'invalid-answer' });
  });
});

describe('buildMissionPickState', () => {
  it('gives each candidate an opaque position id and a relative last-activity', () => {
    const state = buildMissionPickState(request('Site da loja', 'Site da loja v2'), NOW);
    expect(state).toEqual({
      said: 'site loja',
      candidates: [
        { id: 'm1', title: 'Site da loja', status: 'running', lastActivity: '5 min ago' },
        { id: 'm2', title: 'Site da loja v2', status: 'completed', lastActivity: '10 min ago' },
      ],
    });
  });

  it('describes older activity in hours and days, and omits it when unknown', () => {
    const state = buildMissionPickState(
      {
        spoken: 'x',
        candidates: [
          { title: 'A', state: 'running', updatedAt: NOW - 3 * 60 * MINUTE },
          { title: 'B', state: 'running', updatedAt: NOW - 49 * 60 * MINUTE },
          { title: 'C', state: 'running', updatedAt: NOW + 5 * MINUTE },
          { title: 'D', state: 'running' },
        ],
      },
      NOW,
    );
    expect(state?.candidates.map((c) => c.lastActivity)).toEqual(['3 h ago', '2 d ago', 'just now', undefined]);
    expect(state?.candidates[3]).not.toHaveProperty('lastActivity');
  });

  it('redacts secrets found in titles and in what was said, before anything is cut', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const state = buildMissionPickState(
      { spoken: `deploy ${secret}`, candidates: [
        { title: `Deploy ${secret}`, state: 'running' },
        { title: 'Deploy API_KEY=hunter2hunter2', state: 'running' },
      ] },
      NOW,
    );
    const json = JSON.stringify(state);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('hunter2hunter2');
    expect(json).toContain('[REDACTED]');
  });

  it('redacts before cutting: a secret straddling the length limit leaves no fragment behind', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    // Cortar em 100 antes de redigir deixaria "sk-abcdefghijk" (curto demais para o padrão).
    const title = `${'x'.repeat(85)} ${secret}`;
    const state = buildMissionPickState(request(title, 'B'), NOW);
    const json = JSON.stringify(state);
    expect(json).not.toContain('sk-');
    expect(json).toContain('[REDACTED]');
  });

  it('collapses line breaks so a title cannot forge extra structure', () => {
    const state = buildMissionPickState(request('Linha 1\n\n  Linha 2', 'B'), NOW);
    expect(state?.candidates[0]?.title).toBe('Linha 1 Linha 2');
  });

  it('never exceeds 2 KB, even with five maximum-size titles made of 4-byte characters', () => {
    const emoji = '😀'.repeat(100);
    const huge: MissionPickRequest = {
      spoken: '🙂'.repeat(120),
      candidates: Array.from({ length: 5 }, () => ({ title: emoji, state: 'blocked_technical', updatedAt: NOW })),
    };
    const state = buildMissionPickState(huge, NOW);
    expect(state).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeLessThanOrEqual(MISSION_PICK_STATE_MAX_BYTES);
    expect(MISSION_PICK_STATE_MAX_BYTES).toBe(2_048);
    expect(state?.candidates).toHaveLength(5);
  });

  it('fits eight maximum-size 4-byte titles (the no-match path) in 2 KB', () => {
    const huge: MissionPickRequest = {
      kind: 'noMatch',
      spoken: '🙂'.repeat(120),
      candidates: Array.from({ length: 8 }, () => ({ title: '😀'.repeat(100), state: 'blocked_technical', updatedAt: NOW })),
    };
    const state = buildMissionPickState(huge, NOW);
    expect(state).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeLessThanOrEqual(MISSION_PICK_STATE_MAX_BYTES);
    expect(state?.candidates).toHaveLength(8);
    expect(state?.candidates.map((c) => c.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
  });

  it('keeps ordinary titles whole when they already fit', () => {
    const state = buildMissionPickState(request('Site da loja', 'Site da loja v2'), NOW);
    expect(state?.candidates[1]?.title).toBe('Site da loja v2');
  });

  it('gives up (null) instead of sending an oversized state', () => {
    expect(buildMissionPickState(request('Site da loja', 'Site da loja v2'), NOW, 40)).toBeNull();
  });
});

describe('buildMissionPickQuestion', () => {
  it('offers one option per candidate plus none, and never pastes titles into the question', () => {
    const question = buildMissionPickQuestion(3);
    expect(question.type).toBe('choice');
    if (question.type !== 'choice') return;
    expect(Object.keys(question.criteria)).toEqual(['m1', 'm2', 'm3', 'none']);
    expect(question.criteria.m2).toContain('candidates[1].title');
  });
});

describe('buildMissionPickQuestion, no-match path', () => {
  it('has the same options, but tells the model the name may be garbled and to prefer none over a guess', () => {
    const question = buildMissionPickQuestion(3, 'noMatch');
    expect(question.type).toBe('choice');
    if (question.type !== 'choice') return;
    expect(Object.keys(question.criteria)).toEqual(['m1', 'm2', 'm3', 'none']);
    expect(String(question.instructions)).toMatch(/garbled/i);
    expect(String(question.instructions)).toMatch(/choose none/i);
    // O texto falado nunca entra na pergunta, só no state.
    expect(JSON.stringify(question)).not.toContain('sait');
  });

  it('is not the tie-break question', () => {
    expect(JSON.stringify(buildMissionPickQuestion(3, 'noMatch'))).not.toEqual(JSON.stringify(buildMissionPickQuestion(3)));
  });
});

describe('pickMissionWithJev', () => {
  const twoMissions = request('Site da loja', 'Site da loja v2');

  function setup(over: {
    judge?: (...args: never[]) => Promise<JevResult | null>;
    enabled?: boolean;
    hasKey?: boolean;
    rate?: boolean;
  } = {}) {
    const judge = vi.fn(over.judge ?? (async () => jevResult(choice('m2', { m1: 0.1, m2: 0.85, none: 0.05 }, 0.85))));
    const record = vi.fn((_entry: JevDecisionInput) => 'id');
    const deps = {
      judge: judge as never,
      surfaceEnabled: () => over.enabled ?? true,
      hasKey: () => over.hasKey ?? true,
      consumeRate: () => over.rate ?? true,
      record,
      now: () => NOW,
    };
    return { judge, record, deps };
  }

  it('returns the picked index with its confidence', async () => {
    const { deps } = setup();
    expect(await pickMissionWithJev(twoMissions, deps)).toEqual({
      decision: 'picked',
      index: 1,
      confidence: 0.85,
    });
  });

  it('asks the Jev exactly one choice question, on its own surface, with a bounded wait and no retry on timeout', async () => {
    const { judge, deps } = setup();
    await pickMissionWithJev(twoMissions, deps);
    expect(judge).toHaveBeenCalledOnce();
    const input = (judge.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input.surface).toBe('missionPick');
    expect(Object.keys(input.questions as object)).toEqual(['pick']);
    expect(input.retryOnTimeout).toBe(false);
    expect(input.timeoutMs).toBeLessThanOrEqual(4_000);
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(Buffer.byteLength(JSON.stringify(input.state), 'utf8')).toBeLessThanOrEqual(2_048);
  });

  it('does not call the Jev when the surface toggle is off', async () => {
    const { judge, deps } = setup({ enabled: false });
    expect(await pickMissionWithJev(twoMissions, deps)).toEqual({ decision: 'undecided', reason: 'disabled' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('fails open without a decision credential (no call, no throw)', async () => {
    const { judge, deps } = setup({ hasKey: false });
    expect(await pickMissionWithJev(twoMissions, deps)).toEqual({ decision: 'undecided', reason: 'unavailable' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('stops at a rate limit without calling the Jev', async () => {
    const { judge, deps } = setup({ rate: false });
    expect(await pickMissionWithJev(twoMissions, deps)).toEqual({ decision: 'undecided', reason: 'rate-limited' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('fails open when the Jev gives no answer (timeout, service error)', async () => {
    const { deps } = setup({ judge: async () => null });
    expect(await pickMissionWithJev(twoMissions, deps)).toEqual({ decision: 'undecided', reason: 'unavailable' });
  });

  it('never throws, even if the judge does', async () => {
    const { deps } = setup({ judge: async () => { throw new Error('boom sk-abcdefghijklmnopqrstuvwxyz012345'); } });
    const result = await pickMissionWithJev(twoMissions, deps);
    expect(result).toEqual({ decision: 'undecided', reason: 'error' });
    expect(JSON.stringify(result)).not.toContain('sk-');
  });

  it('does not decide on a low-confidence answer, and still journals it', async () => {
    const { deps, record } = setup({ judge: async () => jevResult(choice('m1', { m1: 0.6, m2: 0.3, none: 0.1 }, 0.6)) });
    expect(await pickMissionWithJev(twoMissions, deps)).toEqual({ decision: 'undecided', reason: 'low-confidence' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ surface: 'missionPick', decision: 'ask:low-confidence' }));
  });

  it('journals the accepted pick without any title, id or spoken text', async () => {
    const { deps, record } = setup();
    await pickMissionWithJev(twoMissions, deps);
    expect(record).toHaveBeenCalledOnce();
    const entry = record.mock.calls[0]?.[0] as JevDecisionInput;
    expect(entry).toMatchObject({
      surface: 'missionPick',
      model: 'jev-1.13.0',
      questions: ['pick'],
      decision: 'pick:m2',
    });
    expect(entry.probabilities.pick).toBe(0.85);
    const dump = JSON.stringify(entry);
    expect(dump).not.toContain('Site da loja');
    expect(dump).not.toContain('site loja');
  });

  it('journals a "none" answer as a question to the user', async () => {
    const { deps, record } = setup({ judge: async () => jevResult(choice('none', { m1: 0.05, m2: 0.05, none: 0.9 }, 0.9)) });
    expect(await pickMissionWithJev(twoMissions, deps)).toEqual({ decision: 'undecided', reason: 'none' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'ask:none' }));
  });

  it('survives a journal that throws', async () => {
    const { deps } = setup();
    const result = await pickMissionWithJev(twoMissions, {
      ...deps,
      record: () => { throw new Error('disk full'); },
    });
    expect(result).toMatchObject({ decision: 'picked', index: 1 });
  });

  describe('no-match path', () => {
    const noMatchRequest = (n = 3): MissionPickRequest => ({
      kind: 'noMatch',
      spoken: 'sait da lója',
      candidates: Array.from({ length: n }, (_, i) => ({ title: `Missão ${i + 1}`, state: 'running', updatedAt: NOW - i * MINUTE })),
    });

    it('accepts 0.9 / margin 0.4 and journals it as noMatch:pick', async () => {
      const { deps, record } = setup({
        judge: async () => jevResult(choice('m2', { m1: 0.2, m2: 0.6, m3: 0.1, none: 0.1 }, 0.9)),
      });
      expect(await pickMissionWithJev(noMatchRequest(), deps)).toEqual({ decision: 'picked', index: 1, confidence: 0.9 });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ surface: 'missionPick', decision: 'noMatch:pick:m2' }));
    });

    it('refuses 0.84 and journals it as noMatch:ask, never as the tie-break path', async () => {
      const { deps, record } = setup({
        judge: async () => jevResult(choice('m2', { m1: 0.2, m2: 0.6, m3: 0.1, none: 0.1 }, 0.84)),
      });
      expect(await pickMissionWithJev(noMatchRequest(), deps)).toEqual({ decision: 'undecided', reason: 'low-confidence' });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'noMatch:ask:low-confidence' }));
    });

    it('refuses a 0.29 margin', async () => {
      const { deps } = setup({
        judge: async () => jevResult(choice('m2', { m1: 0.31, m2: 0.6, m3: 0.04, none: 0.05 }, 0.95)),
      });
      expect(await pickMissionWithJev(noMatchRequest(), deps)).toEqual({ decision: 'undecided', reason: 'narrow-margin' });
    });

    it('treats a Jev "none" as no decision', async () => {
      const { deps, record } = setup({
        judge: async () => jevResult(choice('none', { m1: 0.02, m2: 0.02, m3: 0.01, none: 0.95 }, 0.95)),
      });
      expect(await pickMissionWithJev(noMatchRequest(), deps)).toEqual({ decision: 'undecided', reason: 'none' });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'noMatch:ask:none' }));
    });

    it('asks the no-match question, with the spoken text only in the state, and journals no text', async () => {
      const { judge, deps, record } = setup({
        judge: async () => jevResult(choice('m1', { m1: 0.9, m2: 0.05, m3: 0.03, none: 0.02 }, 0.9)),
      });
      await pickMissionWithJev(noMatchRequest(), deps);
      const input = (judge.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(JSON.stringify(input.questions)).toMatch(/garbled/i);
      expect(JSON.stringify(input.state)).toContain('sait da lója');
      expect(input.surface).toBe('missionPick');
      expect(input.retryOnTimeout).toBe(false);
      const dump = JSON.stringify(record.mock.calls[0]?.[0]);
      expect(dump).not.toContain('sait');
      expect(dump).not.toContain('Missão 1');
    });

    it('works with a single mission and with eight', async () => {
      const one = setup({ judge: async () => jevResult(choice('m1', { m1: 0.95, none: 0.05 }, 0.95)) });
      expect(await pickMissionWithJev(noMatchRequest(1), one.deps)).toMatchObject({ decision: 'picked', index: 0 });
      const eight = setup({ judge: async () => jevResult(choice('m8', { m1: 0.01, m2: 0.01, m3: 0.01, m4: 0.01, m5: 0.01, m6: 0.01, m7: 0.01, m8: 0.9, none: 0.03 }, 0.9)) });
      expect(await pickMissionWithJev(noMatchRequest(8), eight.deps)).toMatchObject({ decision: 'picked', index: 7 });
    });

    it('keeps the same fail-open: no key, toggle off, no answer, throw', async () => {
      expect(await pickMissionWithJev(noMatchRequest(), setup({ hasKey: false }).deps)).toEqual({ decision: 'undecided', reason: 'unavailable' });
      expect(await pickMissionWithJev(noMatchRequest(), setup({ enabled: false }).deps)).toEqual({ decision: 'undecided', reason: 'disabled' });
      expect(await pickMissionWithJev(noMatchRequest(), setup({ judge: async () => null }).deps)).toEqual({ decision: 'undecided', reason: 'unavailable' });
      expect(await pickMissionWithJev(noMatchRequest(), setup({ judge: async () => { throw new Error('x'); } }).deps)).toEqual({ decision: 'undecided', reason: 'error' });
    });

    it('does not change the tie-break path: a request without kind still journals pick:mN and uses the 0.7 floor', async () => {
      const { deps, record } = setup({ judge: async () => jevResult(choice('m2', { m1: 0.1, m2: 0.75, none: 0.15 }, 0.8)) });
      expect(await pickMissionWithJev(twoMissions, deps)).toMatchObject({ decision: 'picked', index: 1 });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'pick:m2' }));
    });
  });
});
