import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECISION_EVAL_MODELS, decisionEvalModelId, evaluateDecisionCases, type DecisionEvalCase } from './decision-evaluation';
import { calibrateDecisionQuality } from './decision-calibration';
import {
  buildDecisionQualityTable, configureDecisionQualityClock, configureDecisionQualityTable, QUALITY_TABLE_TTL_MS, decisionQuality, readDecisionQualityTable, writeDecisionQualityTable,
} from './decision-quality';

let dir: string; let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-quality-')); file = path.join(dir, 'quality-table.json'); configureDecisionQualityTable(file); });
afterEach(() => { configureDecisionQualityTable(undefined); fs.rmSync(dir, { recursive: true, force: true }); });

const cases: DecisionEvalCase[] = Array.from({ length: 6 }, (_, index) => ({
  id: `c${index}`, surface: 'judgeTool', split: index % 2 ? 'heldout' : 'development', state: `private payload ${index}`,
  questions: { action: { type: 'choice', instructions: 'Pick.', criteria: { read: 'Read', none: 'None' } } }, expected: { action: 'read' },
}));

describe('tabela de qualidade (F-1165)', () => {
  it('a Luna entra na avaliação', () => {
    expect(DECISION_EVAL_MODELS).toContain('luna');
  });

  it('sem arquivo, corrompido, de outra versão ou malformado: priors', () => {
    expect(readDecisionQualityTable()).toBeNull();
    for (const raw of ['{not json', JSON.stringify({ version: 2, generatedAt: 1, source: 'evaluateDecisionCases', models: {}, surfaces: {} }),
      JSON.stringify({ version: 1, generatedAt: 1, source: 'evaluateDecisionCases', models: { jev: { accuracy: 7, cases: 10 } }, surfaces: {} })]) {
      fs.writeFileSync(file, raw);
      configureDecisionQualityTable(file);
      expect(readDecisionQualityTable()).toBeNull();
      expect(decisionQuality(readDecisionQualityTable(), 'judgeTool', 'jev', 'text')).toMatchObject({ source: 'prior', quality: 0.8 });
    }
  });

  it('grava a partir de evaluateDecisionCases e o roteador lê a medição local', async () => {
    const report = await evaluateDecisionCases(cases, async (model, input) => {
      // Flash indisponível (rede/limite); Omni responde lixo (falha de qualidade).
      if (model === 'clef-flash') { input.onNoAnswer?.(Number(String(input.state).slice(-1)) % 2 ? 'rate-limited' : 'network'); return null; }
      if (model === 'clef-omni') { input.onNoAnswer?.('malformed'); return null; }
      return { model, answers: { action: { type: 'choice', choice: model === 'jev' ? 'none' : 'read', probabilities: { read: 0.5, none: 0.5 }, confidence: 0.5 } },
        usage: { input_tokens: 10, output_tokens: 0 }, durationMs: 40 };
    });
    expect(writeDecisionQualityTable(report, { now: 123 })).toBe(true);
    const table = readDecisionQualityTable();
    expect(table).toMatchObject({ version: 1, generatedAt: 123, source: 'evaluateDecisionCases' });
    expect(table?.surfaces.judgeTool.luna).toMatchObject({ accuracy: 1, cases: 6, p50Ms: 40 });
    expect(table?.surfaces.judgeTool.jev).toMatchObject({ accuracy: 0, cases: 6 });
    // Indisponibilidade não vira acurácia 0: a célula some e o roteador usa o prior.
    expect(table?.surfaces.judgeTool['clef-flash']).toBeUndefined();
    expect(table?.models['clef-flash']).toBeUndefined();
    expect(decisionQuality(table, 'judgeTool', 'clef-flash', 'text')).toMatchObject({ source: 'prior' });
    // Resposta malformada é erro de qualidade: entra no denominador.
    expect(table?.surfaces.judgeTool['clef-omni']).toMatchObject({ accuracy: 0, cases: 6 });
    // Acurácia medida 0 é suspeita: cai no prior em vez de enterrar o modelo.
    expect(decisionQuality(table, 'judgeTool', 'jev', 'text')).toMatchObject({ source: 'prior', quality: 0.8 });
    expect(decisionQuality(table, 'judgeTool', 'luna', 'text')).toMatchObject({ source: 'local-evaluation', quality: 1 });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('private payload');
  });

  it('modelo sem suporte (Jev com imagem) fica fora da célula', () => {
    const table = buildDecisionQualityTable({ models: {} as never, observations: [
      { caseId: 'v', surface: 'browserTool', split: 'heldout', requestedModel: 'jev', status: 'unsupported', correct: null,
        consequential: false, durationMs: null, usd: null, inputTokens: null },
    ] });
    expect(table.surfaces.browserTool).toBeUndefined();
    expect(table.models.jev).toBeUndefined();
  });

  it('erro de fs na gravação não lança', () => {
    fs.writeFileSync(path.join(dir, 'blocker'), 'x');
    expect(writeDecisionQualityTable({ models: {} as never, observations: [] }, { file: path.join(dir, 'blocker', 'table.json') })).toBe(false);
  });
});

describe('cache da tabela por mtime e entrada de calibração (F-1165)', () => {
  it('relê a tabela quando o arquivo muda', () => {
    let now = 5_000_000;
    configureDecisionQualityClock(() => (now += QUALITY_TABLE_TTL_MS));
    const write = (accuracy: number, at: number) => {
      fs.writeFileSync(file, JSON.stringify({ version: 1, generatedAt: 1, source: 'evaluateDecisionCases', models: {},
        surfaces: { judgeTool: { clef: { accuracy, cases: 10 } } } }));
      fs.utimesSync(file, at, at);
    };
    write(0.5, 1_000);
    expect(readDecisionQualityTable()?.surfaces.judgeTool.clef?.accuracy).toBe(0.5);
    write(0.75, 2_000);
    expect(readDecisionQualityTable()?.surfaces.judgeTool.clef?.accuracy).toBe(0.75);
    fs.rmSync(file);
    expect(readDecisionQualityTable()).toBeNull();
    configureDecisionQualityClock(undefined);
  });

  it('calibração: cada chave vai com o id que o funil reconhece (Luna não vira Jev) e grava a tabela', async () => {
    const seen: Array<string | undefined> = [];
    const result = await calibrateDecisionQuality(cases, { file, now: 9, judge: async input => {
      seen.push(input.model);
      return { model: input.model ?? 'x', answers: { action: { type: 'choice', choice: 'read', probabilities: { read: 1, none: 0 }, confidence: 1 } },
        usage: { input_tokens: 1, output_tokens: 0 } };
    } });
    expect(result).toMatchObject({ ok: true, written: true });
    expect(new Set(seen)).toEqual(new Set(['jev-latest', 'clef', 'clef-flash', 'clef-omni', 'gpt-6-luna']));
    expect(decisionEvalModelId('luna')).toBe('gpt-6-luna');
    expect(readDecisionQualityTable()?.surfaces.judgeTool.luna).toMatchObject({ accuracy: 1, cases: 6 });
    expect(await calibrateDecisionQuality([{ id: '' }], { file })).toMatchObject({ ok: false, written: false });
  });
});

describe('P3: cache da tabela com TTL', () => {
  afterEach(() => configureDecisionQualityClock(undefined));
  it('não faz stat a cada decisão; relê depois do TTL', () => {
    let now = 1_000_000;
    configureDecisionQualityClock(() => now);
    const write = (accuracy: number, at: number) => {
      fs.writeFileSync(file, JSON.stringify({ version: 1, generatedAt: 1, source: 'evaluateDecisionCases', models: {},
        surfaces: { judgeTool: { clef: { accuracy, cases: 10 } } } }));
      fs.utimesSync(file, at, at);
    };
    write(0.5, 1_000);
    expect(readDecisionQualityTable()?.surfaces.judgeTool.clef?.accuracy).toBe(0.5);
    const stat = vi.spyOn(fs, 'statSync');
    write(0.75, 2_000);
    now += QUALITY_TABLE_TTL_MS - 1;
    expect(readDecisionQualityTable()?.surfaces.judgeTool.clef?.accuracy).toBe(0.5);
    expect(stat).not.toHaveBeenCalled();
    now += 2;
    expect(readDecisionQualityTable()?.surfaces.judgeTool.clef?.accuracy).toBe(0.75);
    stat.mockRestore();
  });
});
