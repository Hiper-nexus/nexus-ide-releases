import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({}) }));
vi.mock('../persistence/secrets-store', () => ({ getSecret: () => null, hasSecret: () => false, setSecret: () => ({ ok: true }), isSecureStorageAvailable: () => true }));

import type { DecisionSettings } from '../../shared/decision-models';
import { configureJevDecisionLog, jevMissionChargedSpend, recordJevDecision } from '../jev/jev-decision-log';
import { DecisionBudgetLedger, startDecisionBudgetLedger, getDecisionBudgetLedger, resetDecisionBudgetLedgerForTesting } from './decision-budget';
import { judgeDecision } from './decision-judge';
import { decisionResultUsage } from './decision-usage';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const settings: DecisionSettings = { mode: 'auto', clefModel: 'clef', cloudflareAccountId: ACCOUNT, visionEnabled: false };
const input = { state: 'restart payload', questions: { q: { type: 'noul' as const, instructions: 'Is it relevant?' } }, surface: 'toolPick' as const };
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restart-')); configureJevDecisionLog(dir); });
afterEach(() => { configureJevDecisionLog(undefined); resetDecisionBudgetLedgerForTesting(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('P2-3: reinício reconstrói o cobrado, não zero', () => {
  it('custo desconhecido (resposta e falha) volta do diário como o estimado cobrado', async () => {
    const before = new DecisionBudgetLedger(() => ({}));
    const deps = (fetchImpl: typeof fetch) => ({ getSettings: () => settings,
      nativeJudge: async () => ({ model: 'jev-1.13.0', answers: { q: { type: 'noul' as const, noul: 0.7 } },
        usage: { input_tokens: 0, output_tokens: 0 }, usageMissing: true as const }),
      getAvailability: () => ({ jev: true, clef: true, luna: false }), getConfigurationKey: () => 'stable', getQualityTable: () => null,
      getClefConnection: () => ({ accountId: ACCOUNT, token: 'synthetic', model: 'clef' as const }), budgetLedger: before, fetch: fetchImpl });
    // 1) Jev respondeu sem `usage`: a surface grava a decisão com decisionResultUsage(result).
    const answered = await judgeDecision({ ...input, surface: 'judgeTool', missionId: 'm-r' }, deps(fetch));
    expect(answered?.budgetChargedUsd).toBeGreaterThan(0);
    recordJevDecision({ surface: 'judgeTool', missionId: 'm-r', model: answered!.model, questions: ['q'], probabilities: {},
      decision: 'ok', ...decisionResultUsage(answered!) }, { dir });
    // 2) Falha depois de uma requisição (400): o judge grava a linha no-answer com o cobrado.
    await judgeDecision({ ...input, missionId: 'm-r' }, deps((async () => new Response('{}', { status: 400 })) as typeof fetch));
    const spentBefore = before.snapshot('m-r', 0.5).spentUsd;
    expect(spentBefore).toBeGreaterThan(0);
    const rows = fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.every(row => typeof row.budgetChargedUsd === 'number' && row.usd === null)).toBe(true);
    // "Reinício": livro novo, aquecido do diário (linhas anteriores ao nascimento dele).
    const after = new DecisionBudgetLedger(born => jevMissionChargedSpend({ before: born + 1, dir }));
    await after.warm();
    expect(after.snapshot('m-r', 0.5).spentUsd).toBeCloseTo(spentBefore, 12);
  });

  it('linhas antigas sem cobrado caem no usd; linhas do próprio processo não contam duas vezes', async () => {
    recordJevDecision({ surface: 'intake', missionId: 'm-old', model: 'jev', questions: [], probabilities: {}, decision: 'ok',
      inputTokens: 10, usd: 0.003 }, { dir });
    const spend = await jevMissionChargedSpend({ before: Date.now() + 1, dir });
    expect(spend['m-old']).toBeCloseTo(0.003, 12);
    expect(await jevMissionChargedSpend({ before: 0, dir })).toEqual({});
  });

  it('boot: aquece fora do caminho quente e esquece missão encerrada', async () => {
    vi.useFakeTimers();
    try {
      let listener: ((event: { kind: string; payload: Readonly<Record<string, unknown>> }) => void) | undefined;
      const dispose = startDecisionBudgetLedger({ delayMs: 50, subscribe: l => { listener = l; return () => { listener = undefined; }; } });
      const ledger = getDecisionBudgetLedger();
      expect(ledger.isWarm).toBe(false);
      ledger.settle(ledger.reserve('m-done', 0.01, 1, false)!, 0.01);
      ledger.settle(ledger.reserve('m-run', 0.01, 1, false)!, 0.01);
      listener?.({ kind: 'mission.completed', payload: { missionId: 'm-done' } });
      listener?.({ kind: 'mission.state', payload: { missionId: 'm-run', status: 'running' } });
      expect(ledger.size).toBe(1);
      // failed/blocked voltam a running pelo Retomar: o gasto não pode zerar.
      listener?.({ kind: 'mission.state', payload: { missionId: 'm-run', status: 'failed' } });
      listener?.({ kind: 'mission.state', payload: { missionId: 'm-run', status: 'blocked' } });
      expect(ledger.size).toBe(1);
      listener?.({ kind: 'mission.state', payload: { missionId: 'm-run', status: 'done' } });
      expect(ledger.size).toBe(0);
      await vi.advanceTimersByTimeAsync(60);
      dispose();
      expect(listener).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe('P3: leitura do diário resistente à rotação', () => {
  it('lê o par rotacionado + corrente e soma os dois', async () => {
    recordJevDecision({ surface: 'intake', missionId: 'm-pair', model: 'jev', questions: [], probabilities: {}, decision: 'ok',
      inputTokens: 1, usd: 0.002 }, { dir });
    fs.renameSync(path.join(dir, 'decisions.jsonl'), path.join(dir, 'decisions.1.jsonl'));
    recordJevDecision({ surface: 'intake', missionId: 'm-pair', model: 'jev', questions: [], probabilities: {}, decision: 'ok',
      inputTokens: 1, usd: 0.003 }, { dir });
    const spend = await jevMissionChargedSpend({ before: Date.now() + 1, dir });
    expect(spend['m-pair']).toBeCloseTo(0.005, 12);
  });

  it('rotação durante a leitura (inode do corrente muda) refaz a leitura', async () => {
    recordJevDecision({ surface: 'intake', missionId: 'm-rot', model: 'jev', questions: [], probabilities: {}, decision: 'ok',
      inputTokens: 1, usd: 0.004 }, { dir });
    const realRead = fs.promises.readFile;
    let rotated = false;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof realRead>) => {
      const result = await realRead(...args);
      if (!rotated && String(args[0]).endsWith('decisions.jsonl')) {
        rotated = true;
        // Rotação concorrente: o corrente vira .1 e nasce um corrente novo (inode novo).
        fs.renameSync(path.join(dir, 'decisions.jsonl'), path.join(dir, 'decisions.1.jsonl'));
        recordJevDecision({ surface: 'intake', missionId: 'm-rot', model: 'jev', questions: [], probabilities: {},
          decision: 'ok', inputTokens: 1, usd: 0.001 }, { dir });
      }
      return result;
    });
    try {
      const spend = await jevMissionChargedSpend({ before: Date.now() + 60_000, dir });
      // Sem refazer, a 1ª leitura via .1 vazio + corrente antigo (0,004) e perdia a linha nova (0,001).
      expect(spend['m-rot']).toBeCloseTo(0.005, 12);
    } finally { spy.mockRestore(); }
  });
});
