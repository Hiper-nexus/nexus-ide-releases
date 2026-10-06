import { describe, expect, it, vi } from 'vitest';
import {
  evaluateMomentumJudgment,
  judgeMissionMomentum,
  momentumNudgeFromJudgment,
  type MissionMomentumFacts,
} from './jev-mission-momentum';
import type { JevAnswer } from '../jev/jev-client';
const calls = vi.hoisted(() => ({ judge: vi.fn(), record: vi.fn() }));
vi.mock('../jev/jev-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jev/jev-client')>()), judge: calls.judge,
}));
vi.mock('../jev/jev-decision-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jev/jev-decision-log')>()), recordJevDecision: calls.record,
}));

vi.mock('../jev/jev-autopilot', () => ({
  isJevSurfaceEnabled: vi.fn(() => true),
}));
vi.mock('../decision-models/decision-availability', () => ({
  hasDecisionCredential: vi.fn(() => true),
}));

const facts: MissionMomentumFacts = {
  missionId: 'm1',
  missionStatus: 'running',
  workerPanes: 0,
  readyTaskIds: ['t1', 't2', 't3'],
  availableSlots: 3,
  soloForMs: 25 * 60_000,
  readyForMs: 10 * 60_000,
  heavyCommandsActive: 0,
  recentHandoffs: 0,
  orchestratorAlive: true,
};

describe('evaluateMomentumJudgment (política em código)', () => {
  it('preso + sem gate → open-workers', () => {
    const answers: Record<string, JevAnswer> = {
      is_stuck: { type: 'noul', noul: 0.9 },
      best_action: {
        type: 'choice',
        choice: 'open-workers',
        probabilities: { 'open-workers': 0.85, 'wait-gate': 0.05, 'escalate-operator': 0.05, 'nudge-maestro': 0.05 },
        confidence: 0.85,
      },
      urgency: { type: 'score', score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    };
    const v = evaluateMomentumJudgment(answers);
    expect(v.judgment).toBe('stuck');
    expect(v.action).toBe('open-workers');
    expect(v.confidence).toBe(0.85);
  });

  it('gate longo → waiting-gate, não abre worker para o mesmo validador', () => {
    const answers: Record<string, JevAnswer> = {
      is_stuck: { type: 'noul', noul: 0.2 },
      best_action: {
        type: 'choice',
        choice: 'wait-gate',
        probabilities: { 'open-workers': 0.1, 'wait-gate': 0.8, 'escalate-operator': 0.05, 'nudge-maestro': 0.05 },
        confidence: 0.8,
      },
      urgency: { type: 'score', score: 1, legend: {}, probabilities: {}, confidence: 0.7 },
    };
    const v = evaluateMomentumJudgment(answers);
    expect(v.judgment).toBe('waiting-gate');
    expect(v.action).toBe('wait-gate');
  });

  it('sem resposta clara → fallback para nudge-maestro com confiança 0', () => {
    const v = evaluateMomentumJudgment({});
    expect(v.judgment).toBe('progressing');
    expect(v.action).toBe('nudge-maestro');
    expect(v.confidence).toBe(0);
  });

  it('só noul (sem choice) com stuck alto → open-workers', () => {
    const answers: Record<string, JevAnswer> = {
      is_stuck: { type: 'noul', noul: 0.8 },
    };
    const v = evaluateMomentumJudgment(answers);
    expect(v.judgment).toBe('stuck');
    expect(v.action).toBe('open-workers');
    expect(v.confidence).toBe(0.8);
  });

  it('escalate com stuck alto → judgment stuck + ação escalate (preso e precisa do operador)', () => {
    const answers: Record<string, JevAnswer> = {
      is_stuck: { type: 'noul', noul: 0.6 },
      best_action: {
        type: 'choice',
        choice: 'escalate-operator',
        probabilities: { 'escalate-operator': 0.75, 'open-workers': 0.1, 'wait-gate': 0.1, 'nudge-maestro': 0.05 },
        confidence: 0.75,
      },
      urgency: { type: 'score', score: 4, legend: {}, probabilities: {}, confidence: 0.9 },
    };
    const v = evaluateMomentumJudgment(answers);
    expect(v.judgment).toBe('stuck');
    expect(v.action).toBe('escalate-operator');
  });

  it('escalate sem stuck (noul baixo) → recovering', () => {
    const answers: Record<string, JevAnswer> = {
      is_stuck: { type: 'noul', noul: 0.3 },
      best_action: {
        type: 'choice',
        choice: 'escalate-operator',
        probabilities: { 'escalate-operator': 0.75, 'open-workers': 0.1, 'wait-gate': 0.1, 'nudge-maestro': 0.05 },
        confidence: 0.75,
      },
      urgency: { type: 'score', score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    };
    const v = evaluateMomentumJudgment(answers);
    expect(v.judgment).toBe('recovering');
    expect(v.action).toBe('escalate-operator');
  });
});

describe('judgeMissionMomentum (fail-open)', () => {
  it.each([['jev', 0.000042], ['clef', 0.00024], ['clef-flash', 0.00009]] as const)('records canonical pricing for %s', async (model, usd) => {
    calls.judge.mockResolvedValueOnce({
      model, usage: { input_tokens: 1000 },
      answers: { best_action: { type: 'choice', choice: 'open-workers', confidence: 0.9, probabilities: {} } },
    });
    await judgeMissionMomentum(facts);
    expect(calls.record).toHaveBeenLastCalledWith(expect.objectContaining({ model, inputTokens: 1000, usd }));
  });

  it('sem credencial → skipped', async () => {
    const { hasDecisionCredential } = await import('../decision-models/decision-availability');
    vi.mocked(hasDecisionCredential).mockReturnValueOnce(false);
    const v = await judgeMissionMomentum(facts);
    expect(v.kind).toBe('skipped');
    expect(v.reason).toBe('no-credential');
  });

  it('superfície desligada → skipped', async () => {
    const { isJevSurfaceEnabled } = await import('../jev/jev-autopilot');
    vi.mocked(isJevSurfaceEnabled).mockReturnValueOnce(false);
    const v = await judgeMissionMomentum(facts);
    expect(v.kind).toBe('skipped');
    expect(v.reason).toBe('surface-disabled');
  });
});

describe('momentumNudgeFromJudgment', () => {
  it.each(['wait-gate', 'escalate-operator'] as const)('keeps the durable mission marker first for %s', (action) => {
    const text = momentumNudgeFromJudgment({ kind: 'judged', action, confidence: 0.9 }, '[momentum:m1] Existing instruction');
    expect(text.startsWith('[momentum:m1]')).toBe(true);
  });
  it('sem julgamento, o texto mecânico vale', () => {
    const text = momentumNudgeFromJudgment({ kind: 'skipped' }, 'texto mecânico');
    expect(text).toBe('texto mecânico');
  });

  it('wait-gate acrescenta a instrução de não abrir worker para o mesmo validador', () => {
    const text = momentumNudgeFromJudgment(
      {
        kind: 'judged',
        judgment: 'waiting-gate',
        action: 'wait-gate',
        confidence: 0.8,
        probabilities: { is_stuck: 0.2 },
      },
      'base',
    );
    expect(text).toContain('Jev sugere conferir se há um gate longo');
    expect(text).toContain('base');
  });

  it('escalate marca para o operador', () => {
    const text = momentumNudgeFromJudgment(
      {
        kind: 'judged',
        judgment: 'recovering',
        action: 'escalate-operator',
        confidence: 0.9,
      },
      'base',
    );
    expect(text).toContain('momentum:escalate');
    expect(text).toContain('base');
  });

  it('open-workers mantém o texto mecânico (a ação já está no texto)', () => {
    const text = momentumNudgeFromJudgment(
      {
        kind: 'judged',
        judgment: 'stuck',
        action: 'open-workers',
        confidence: 0.9,
      },
      'base',
    );
    expect(text).toBe('base');
  });
});
