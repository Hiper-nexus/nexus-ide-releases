import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import {
  PUBLISHED_BENCHMARKS,
  publishedBenchmarkFor,
  publishedBenchmarkKey,
  publishedCodingQuality,
  publishedEntryScore100,
  publishedScoreHint,
  resolvePublishedBenchmark,
} from './published-benchmarks';
import { DEFAULT_ROUTING_TABLE } from './task-router';

it('F-1649: GA inherits only an attributed predecessor floor, never Preview measurements as its own', () => {
  const ga = 'minimax/MiniMax-M3.1-Flash';
  const entry = PUBLISHED_BENCHMARKS[`minimax-code:${ga}`];
  expect(entry).toMatchObject({
    successorOf: 'minimax-code:minimax/MiniMax-M3.1-Flash-Preview',
    source: 'https://agent.minimax.io/tools/m3.1-flash',
  });
  expect(entry.deepSWE).toBeUndefined();
  expect(entry.terminalBench21).toBeUndefined();
  expect(entry.swebenchVerified).toBeUndefined();
  expect(resolvePublishedBenchmark('minimax-code', ga)).toMatchObject({
    key: 'minimax-code:minimax/MiniMax-M3', origin: 'predecessor',
  });
  expect(resolvePublishedBenchmark('minimax-code', 'minimax/MiniMax-M3.1-Flash-Preview'))
    .toMatchObject({ key: 'minimax-code:minimax/MiniMax-M3', origin: 'predecessor' });
});

/** Linhas da tabela sem número oficial publicado pelo fabricante (não se inventa nota). */
const UNPUBLISHED_ROUTE_MODELS = new Set([
  'mimo-code:xiaomi/mimo-v2.6-pro-ultraspeed',
  'opencode:opencode/deepseek-v4-flash',
  'opencode:openrouter/anthropic/claude-sonnet-5',
  'opencode:openrouter/anthropic/claude-opus-4.8',
  'openclaude:haiku',
  'openclaude:sonnet',
  'openclaude:opus',
  'aider:claude-haiku-4-5',
  'aider:claude-sonnet-5',
  'aider:claude-opus-4-8',
  // F-238: Qwen 3.x — sem nota oficial de coding publicada (model card da
  // Alibaba não traz DeepSWE/TB2.1/SWE-bench para estes ids); prior de custo.
  'qwen:qwen3.8-max',
]);

describe('benchmarks oficiais publicados (F-675)', () => {
  it('toda chave é alcançável por modelo builtin ou sua cadeia histórica de atribuição', () => {
    const reachable = new Set(
      Object.entries(BUILTIN_MODEL_CATALOG.adapters ?? {}).flatMap(([adapterId, entry]) =>
        (entry.models ?? []).map(m => publishedBenchmarkKey(adapterId, m.id))),
    );
    // Retiring an offered id must not erase the predecessor's historical
    // evidence. Only ancestors actually referenced by a live model qualify.
    for (const key of reachable) {
      const entry = PUBLISHED_BENCHMARKS[key];
      if (entry?.sameModelAs) reachable.add(entry.sameModelAs);
      if (entry?.successorOf) reachable.add(entry.successorOf);
    }
    const dangling = Object.keys(PUBLISHED_BENCHMARKS).filter(key => !reachable.has(key));
    expect(dangling).toEqual([]);
  });

  it('toda entrada tem fonte e sameModelAs resolve para uma entrada com número', () => {
    for (const [key, entry] of Object.entries(PUBLISHED_BENCHMARKS)) {
      expect(entry.source.length, key).toBeGreaterThan(0);
      if (entry.sameModelAs) {
        expect(PUBLISHED_BENCHMARKS[entry.sameModelAs], key).toBeDefined();
      }
    }
  });

  it('toda linha da tabela de rota tem nota oficial ou está listada como sem publicação', () => {
    const missing: string[] = [];
    for (const rows of Object.values(DEFAULT_ROUTING_TABLE)) {
      for (const row of rows) {
        if (!row.model) continue;
        const key = `${row.adapterId}:${row.model}`;
        if (publishedCodingQuality(row.adapterId, row.model) === null && !UNPUBLISHED_ROUTE_MODELS.has(key)) {
          missing.push(key);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('F-1391: wonder-full e wonder usam a DeepSWE oficial da Meta e passam o Opus 5.5', () => {
    const full = publishedCodingQuality('muse', 'muse-wonder-full-1.0');
    const wonder = publishedCodingQuality('muse', 'muse-wonder-1.0');
    const spark = publishedCodingQuality('muse', 'muse-spark-1.3');
    const opus = publishedCodingQuality('claude', 'claude-opus-5-5');
    expect(full).not.toBeNull();
    expect(wonder).not.toBeNull();
    // A faixa DeepSWE [45,76] satura acima de 76: os dois wonder chegam ao
    // teto 24, acima do Opus 5.5 (74,2); a rota escolhe o full no difícil.
    expect(full!).toBeGreaterThanOrEqual(wonder!);
    expect(wonder!).toBeGreaterThan(opus!);
    expect(wonder!).toBeGreaterThanOrEqual(spark!);
    for (const model of ['muse-wonder-1.0', 'muse-wonder-full-1.0']) {
      expect(PUBLISHED_BENCHMARKS[`muse:${model}`]?.source).toBe('https://dev.meta.ai/models/muse-wonder/');
    }
  });

  it('normaliza variantes de esforço, contexto e adapters irmãos', () => {
    expect(publishedBenchmarkKey('agy', 'gemini-3.8-flash-high')).toBe('agy:gemini-3.8-flash');
    expect(publishedBenchmarkKey('glm-flash', 'glm-5.3-flash[1m]')).toBe('glm:glm-5.3-flash');
    expect(publishedBenchmarkKey('devin', 'swe-2-max')).toBe('devin:swe-2');
    expect(publishedBenchmarkKey('muse-claude', 'muse-spark-1.3')).toBe('muse:muse-spark-1.3');
  });

  it('variante do mesmo modelo herda o número do base; ultraspeed não herda', () => {
    expect(publishedBenchmarkFor('grok', 'grok-4.7-build-fast')?.deepSWE).toBe(71.0);
    expect(publishedBenchmarkFor('minimax-code', 'minimax/MiniMax-M2.7-highspeed')?.swebenchVerified).toBe(79.9);
    expect(publishedCodingQuality('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed')).toBeNull();
    expect(publishedCodingQuality('deepseek', 'deepseek-chat')).toBeNull();
  });

  it('a nota fica na escala 6..24 do pipeline e ordena pelo número publicado', () => {
    const opus = publishedCodingQuality('claude', 'claude-opus-5-5')!;
    const mimo = publishedCodingQuality('mimo-code', 'xiaomi/mimo-v2.6-pro')!;
    const glm52 = publishedCodingQuality('glm', 'glm-5.2')!;
    for (const q of [opus, mimo, glm52]) {
      expect(q).toBeGreaterThanOrEqual(6);
      expect(q).toBeLessThanOrEqual(24);
    }
    expect(mimo).toBeGreaterThan(12);
    expect(glm52).toBeLessThan(mimo);
  });

  it('GPT-6.1 Sol supera o GPT-6 Sol na nota oficial (DeepSWE 75,2 × 68,8)', () => {
    const next = publishedCodingQuality('codex', 'gpt-6.1-sol');
    const sol = publishedCodingQuality('codex', 'gpt-6-sol');
    expect(sol).not.toBeNull();
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(sol!);
  });

  it('successorOf: o mais novo sem número herda a nota do antecessor como piso (regra do operador 29/09)', () => {
    for (const [key, entry] of Object.entries(PUBLISHED_BENCHMARKS)) {
      if (entry.successorOf) expect(PUBLISHED_BENCHMARKS[entry.successorOf], key).toBeDefined();
    }
    const flash = publishedCodingQuality('minimax-code', 'minimax/MiniMax-M3.1-Flash-Preview');
    const m3 = publishedCodingQuality('minimax-code', 'minimax/MiniMax-M3');
    expect(m3).not.toBeNull();
    expect(flash).toBe(m3);
  });

  it('modelo mais novo sem entrada própria herda o antecessor mais próximo da mesma linha (F-217)', () => {
    // A CLI anuncia gpt-6.2-sol antes de qualquer catálogo/benchmark: a nota
    // do 6.1 (mesmo stem, versão mais próxima abaixo) segura o piso.
    expect(publishedBenchmarkFor('codex', 'gpt-6.2-sol')?.deepSWE).toBe(75.2);
    expect(publishedCodingQuality('codex', 'gpt-6.2-sol')).toBe(
      publishedCodingQuality('codex', 'gpt-6.1-sol'),
    );
  });

  it('o antigo nunca herda do mais novo; entrada própria sempre vence', () => {
    // Entrada direta do gpt-6-sol mantém os 68,8 dele — nunca os 75,2 do 6.1.
    expect(publishedBenchmarkFor('codex', 'gpt-6-sol')?.deepSWE).toBe(68.8);
    // Linha distinta herda do antecessor DELA (Luna 6), não do Sol.
    expect(publishedBenchmarkFor('codex', 'gpt-9-luna')?.deepSWE).toBe(66.6);
    // Sem linha publicada continua sem nota — não se inventa piso.
    expect(publishedCodingQuality('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed')).toBeNull();
    expect(publishedCodingQuality('deepseek', 'deepseek-chat')).toBeNull();
  });

  it('F-1290: hint 0..100 usa a mesma média da nota do roteador, com fonte', () => {
    const astra = publishedScoreHint('codex', 'gpt-6-astra');
    expect(astra).not.toBeNull();
    // DeepSWE 74,1 em [45,76] → (74,1−45)/31 ≈ 0,939 → ≈93,9.
    expect(astra!.score100).toBeCloseTo(93.9, 1);
    expect(astra!.label).toMatch(/benchmark publicado/);
    expect(astra!.label).toContain('DeepSWE 74,1');
    const argon = publishedScoreHint('agy', 'gemini-4-argon');
    expect(argon!.score100).toBeGreaterThan(astra!.score100);
    // Mesma média da escala 6..24: hint/100×18+6 == quality.
    const quality = publishedCodingQuality('codex', 'gpt-6-astra')!;
    expect(astra!.score100 / 100).toBeCloseTo((quality - 6) / 18, 3);
  });

  it('F-1290: sem número publicado não há hint — nunca se inventa', () => {
    expect(publishedScoreHint('qwen', 'qwen3.8-max')).toBeNull();
    expect(publishedScoreHint('opencode', 'opencode/deepseek-v4-flash')).toBeNull();
    expect(publishedScoreHint('nope', 'nope-1')).toBeNull();
  });

  it('deepseek-flash no Claude e no Qwen herdam o benchmark oficial da DeepSeek', () => {
    const direct = publishedBenchmarkFor('deepseek', 'deepseek-flash');
    expect(direct).toMatchObject({ deepSWE: 74.2, terminalBench21: 90.6 });

    const claudeFlash = publishedBenchmarkFor('claude', 'deepseek-flash');
    expect(claudeFlash).toEqual(direct);

    const qwenFlash = publishedBenchmarkFor('qwen', 'deepseek-flash');
    expect(qwenFlash).toEqual(direct);

    expect(publishedCodingQuality('claude', 'deepseek-flash')).toBe(
      publishedCodingQuality('deepseek', 'deepseek-flash'),
    );
    expect(publishedCodingQuality('qwen', 'deepseek-flash')).toBe(
      publishedCodingQuality('deepseek', 'deepseek-flash'),
    );
  });

  it('F-1588: o resolvedor diz de quem são os números', () => {
    expect(resolvePublishedBenchmark('codex', 'gpt-6.1-sol')).toMatchObject({
      key: 'codex:gpt-6.1-sol',
      origin: 'own',
    });
    // Esforço e contexto não mudam o modelo: os números são do id base.
    expect(resolvePublishedBenchmark('agy', 'gemini-3.8-flash-high')).toMatchObject({
      key: 'agy:gemini-3.8-flash',
      origin: 'variant',
    });
    expect(resolvePublishedBenchmark('claude', 'claude-opus-5-5[1m]')?.origin).toBe('variant');
    expect(resolvePublishedBenchmark('claude', 'deepseek-flash')).toMatchObject({
      key: 'deepseek:deepseek-flash',
      origin: 'same-model',
    });
    // Versão nova sem publicação: piso do antecessor, nunca "número dela".
    expect(resolvePublishedBenchmark('codex', 'gpt-6.2-sol')).toMatchObject({
      key: 'codex:gpt-6.1-sol',
      origin: 'predecessor',
    });
    expect(
      resolvePublishedBenchmark('minimax-code', 'minimax/MiniMax-M3.1-Flash-Preview'),
    ).toMatchObject({ key: 'minimax-code:minimax/MiniMax-M3', origin: 'predecessor' });
    expect(resolvePublishedBenchmark('qwen', 'qwen3.8-max')).toBeNull();
  });

  it('F-1588: a nota 0..100 da entrada é a mesma do hint do roteador', () => {
    const entry = publishedBenchmarkFor('codex', 'gpt-6-astra')!;
    expect(publishedEntryScore100(entry)).toBe(
      publishedScoreHint('codex', 'gpt-6-astra')!.score100,
    );
    expect(publishedEntryScore100({ source: 'x' })).toBeNull();
  });
});

