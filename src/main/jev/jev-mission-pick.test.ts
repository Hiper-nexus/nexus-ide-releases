import { describe, expect, it, vi } from 'vitest';
import type { JevAnswer, JevResult } from './jev-client';
import type { JevDecisionInput } from './jev-decision-log';
import type { MissionPickRequest } from '../../shared/mission-pick';
import {
  MISSION_PICK_MIN_CONFIDENCE,
  MISSION_PICK_MIN_MARGIN,
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
});
