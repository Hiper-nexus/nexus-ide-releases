import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureJevDecisionLog, jevDecisionStats, jevMissionUsage, recordJevDecision, recordJevNoAnswer, resetJevMissionUsageCacheForTesting,
} from './jev-decision-log';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-usage-')); configureJevDecisionLog(dir); resetJevMissionUsageCacheForTesting(); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); configureJevDecisionLog(undefined); });

const decision = { questions: ['q'], probabilities: { q: 0.9 }, decision: 'ok' };

describe('F-1167 P2-3: agregado por missão assíncrono, com cache por mtime+tamanho', () => {
  it('soma igual ao jevDecisionStats.byMission, sem leitura síncrona do diário', async () => {
    recordJevDecision({ ...decision, surface: 'intake', missionId: 'm1', model: 'jev', provider: 'jev', inputTokens: 100, usd: 0.001 }, { dir });
    recordJevDecision({ ...decision, surface: 'paneState', missionId: 'm1', model: 'clef-flash', provider: 'clef', inputTokens: 50, usd: 0.002 }, { dir });
    recordJevNoAnswer({ surface: 'delegation', reason: 'budget', model: 'jev', missionId: 'm1', requestCount: 0 }, { dir });
    recordJevDecision({ ...decision, surface: 'intake', missionId: 'm2', model: 'jev', provider: 'jev', inputTokens: 10, usd: 0.0001 }, { dir });
    const expected = jevDecisionStats({ dir }).byMission.m1;
    const readSync = vi.spyOn(fs, 'readFileSync');
    const usage = await jevMissionUsage('m1', { dir });
    expect(readSync).not.toHaveBeenCalled();
    expect(usage).toEqual(expected);
    expect(await jevMissionUsage('missing', { dir })).toBeUndefined();
  });

  it('não relê o diário enquanto mtime e tamanho não mudam; relê quando muda', async () => {
    recordJevDecision({ ...decision, surface: 'intake', missionId: 'm1', model: 'jev', provider: 'jev', inputTokens: 1, usd: 0.001 }, { dir });
    const read = vi.spyOn(fs.promises, 'readFile');
    expect((await jevMissionUsage('m1', { dir }))?.calls).toBe(1);
    const reads = read.mock.calls.length;
    expect((await jevMissionUsage('m1', { dir }))?.calls).toBe(1);
    expect(read.mock.calls.length).toBe(reads);
    recordJevDecision({ ...decision, surface: 'intake', missionId: 'm1', model: 'jev', provider: 'jev', inputTokens: 1, usd: 0.001 }, { dir });
    expect((await jevMissionUsage('m1', { dir }))?.calls).toBe(2);
    expect(read.mock.calls.length).toBeGreaterThan(reads);
  });

  it('chamadas simultâneas compartilham uma leitura; diretório ilegível vira "sem dados"', async () => {
    recordJevDecision({ ...decision, surface: 'intake', missionId: 'm1', model: 'jev', provider: 'jev', inputTokens: 1, usd: 0.001 }, { dir });
    const read = vi.spyOn(fs.promises, 'readFile');
    const results = await Promise.all([jevMissionUsage('m1', { dir }), jevMissionUsage('m1', { dir }), jevMissionUsage('m1', { dir })]);
    expect(results.every(row => row?.calls === 1)).toBe(true);
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
    expect(await jevMissionUsage('m1', { dir: path.join(dir, 'nao-existe') })).toBeUndefined();
  });
});

describe('F-1167: linha de calibração só soma no gasto', () => {
  it('fora de chamadas, consultas, superfícies e sem-resposta; dentro de US$ e tokens', () => {
    recordJevDecision({ ...decision, surface: 'intake', model: 'jev', provider: 'jev', inputTokens: 100, usd: 0.001 }, { dir });
    const base = jevDecisionStats({ dir });
    recordJevDecision({ surface: 'calibration', provider: 'jev', model: 'jev-latest', questions: [], probabilities: {},
      decision: 'calibration:55/55', inputTokens: 11000, usd: 0.0005, requestCount: 55 }, { dir });
    recordJevDecision({ surface: 'calibration', provider: 'clef', model: 'clef-flash', questions: [], probabilities: {},
      decision: 'calibration:50/55', inputTokens: 11000, usd: 0.0004, requestCount: 55 }, { dir });
    const stats = jevDecisionStats({ dir });
    expect(stats.totals.calls).toBe(base.totals.calls);
    expect(stats.totals.noAnswer).toBe(base.totals.noAnswer);
    for (const key of ['today', 'last30d', 'allTime'] as const) {
      expect(stats.windows[key].consultations).toBe(base.windows[key].consultations);
      expect(stats.windows[key].answered).toBe(base.windows[key].answered);
      expect(stats.windows[key].usd).toBeCloseTo(base.windows[key].usd + 0.0009, 10);
    }
    expect(stats.bySurface.calibration).toBeUndefined();
    expect(stats.byProvider.jev!.calls).toBe(base.byProvider.jev!.calls);
    expect(stats.byProvider.jev!.usd).toBeCloseTo(base.byProvider.jev!.usd + 0.0005, 10);
    expect(stats.byProvider.clef).toMatchObject({ calls: 0, noAnswer: 0 });
    expect(stats.byProvider.clef!.usd).toBeCloseTo(0.0004, 10);
    expect(stats.byModel['clef-flash']).toMatchObject({ calls: 0 });
    expect(stats.totals.usd).toBeCloseTo(base.totals.usd + 0.0009, 10);
    expect(stats.calibration).toMatchObject({ lines: 2, inputTokens: 22000 });
    expect(stats.calibration.usd).toBeCloseTo(0.0009, 10);
    expect(stats.calibration.last30dUsd).toBeCloseTo(0.0009, 10);
  });
});
