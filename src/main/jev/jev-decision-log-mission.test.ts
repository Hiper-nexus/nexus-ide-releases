import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureJevDecisionLog, jevDecisionStats, listJevDecisions, recordJevDecision, recordJevNoAnswer, recordJevOptimization,
} from './jev-decision-log';
import { parseDecisionRow } from './jev-decision-row';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mission-')); configureJevDecisionLog(dir); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); configureJevDecisionLog(undefined); });

const base = { id: 'row', at: 1, surface: 'intake', model: 'jev', questions: [], probabilities: {}, decision: 'rule', inputTokens: 0, usd: 0 };

describe('parser do diário: motivo (F-1164)', () => {
  it("aceita 'budget' e os motivos conhecidos", () => {
    expect(parseDecisionRow({ ...base, kind: 'no-answer', reason: 'budget' })?.reason).toBe('budget');
    expect(parseDecisionRow({ ...base, kind: 'no-answer', reason: 'divergent' })?.reason).toBe('divergent');
  });

  it('motivo desconhecido vira ausente sem derrubar a linha', () => {
    const row = parseDecisionRow({ ...base, kind: 'no-answer', reason: 'from-the-future' });
    expect(row).not.toBeNull();
    expect(row?.reason).toBeUndefined();
  });

  it("uma recusa por orçamento gravada volta do disco como 'budget'", () => {
    recordJevNoAnswer({ surface: 'delegation', reason: 'budget', model: 'jev', missionId: 'm1', requestCount: 0 }, { dir });
    const [row] = listJevDecisions({ includeNoAnswer: true, dir });
    expect(row).toMatchObject({ kind: 'no-answer', reason: 'budget', missionId: 'm1', usd: 0, requestCount: 0 });
  });
});

describe('jevDecisionStats.byMission (F-1164)', () => {
  it('soma gasto, consultas e recusas por missão; linhas sem missão ficam fora', () => {
    const decision = { questions: ['q'], probabilities: { q: 0.9 }, decision: 'ok' };
    recordJevDecision({ ...decision, surface: 'intake', missionId: 'm1', model: 'jev', provider: 'jev', inputTokens: 100, usd: 0.001 }, { dir });
    recordJevDecision({ ...decision, surface: 'paneState', missionId: 'm1', model: 'clef-flash', provider: 'clef', inputTokens: 50, usd: 0.002 }, { dir });
    recordJevNoAnswer({ surface: 'delegation', reason: 'budget', model: 'jev', missionId: 'm1', requestCount: 0 }, { dir });
    recordJevNoAnswer({ surface: 'delegation', reason: 'timeout', model: 'jev', missionId: 'm2', requestCount: 2 }, { dir });
    recordJevDecision({ ...decision, surface: 'toolPick', model: 'jev', inputTokens: 10, usd: 0.5 }, { dir });
    recordJevOptimization({ surface: 'paneState', missionId: 'm1', model: 'jev', optimization: { jevRequestsAvoided: 1 } }, { dir });
    const { byMission } = jevDecisionStats({ dir });
    expect(Object.keys(byMission).sort()).toEqual(['m1', 'm2']);
    expect(byMission.m1).toMatchObject({ calls: 2, noAnswer: 1, budgetRefusals: 1, inputTokens: 150, incompleteUsage: 0 });
    expect(byMission.m1.usd).toBeCloseTo(0.003, 12);
    expect(byMission.m1.byProvider.clef).toMatchObject({ calls: 1, noAnswer: 0 });
    expect(byMission.m1.byProvider.jev).toMatchObject({ calls: 1, noAnswer: 1 });
    expect(byMission.m2).toMatchObject({ calls: 0, noAnswer: 1, budgetRefusals: 0, usd: 0, incompleteUsage: 1 });
  });

  it('diário ausente devolve byMission vazio', () => {
    expect(jevDecisionStats({ dir: path.join(dir, 'missing') }).byMission).toEqual({});
  });
});

describe('byMission: marcador judge-unavailable (revisão F-1164)', () => {
  it('a linha judge-unavailable do handoffReview não conta como chamada', () => {
    recordJevNoAnswer({ surface: 'handoffReview', reason: 'timeout', model: 'jev', missionId: 'm9', requestCount: 1 }, { dir });
    recordJevDecision({ surface: 'handoffReview', missionId: 'm9', model: 'unavailable', questions: ['q'], probabilities: {},
      decision: 'judge-unavailable', inputTokens: 0, usd: 0 }, { dir });
    expect(jevDecisionStats({ dir }).byMission.m9).toMatchObject({ calls: 0, noAnswer: 1 });
  });

  it('chargedUsd soma o cobrado (fallback usd)', () => {
    recordJevDecision({ surface: 'intake', missionId: 'm8', model: 'jev', questions: [], probabilities: {}, decision: 'ok',
      inputTokens: null, usd: null, budgetChargedUsd: 0.004 }, { dir });
    recordJevDecision({ surface: 'intake', missionId: 'm8', model: 'jev', questions: [], probabilities: {}, decision: 'ok',
      inputTokens: 1, usd: 0.001 }, { dir });
    expect(jevDecisionStats({ dir }).byMission.m8.chargedUsd).toBeCloseTo(0.005, 12);
    expect(parseDecisionRow({ ...base, budgetChargedUsd: 'x' })?.budgetChargedUsd).toBeUndefined();
  });
});
