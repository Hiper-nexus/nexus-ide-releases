import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import {
  PUBLISHED_BENCHMARKS,
  publishedBenchmarkFor,
  publishedBenchmarkKey,
  publishedCodingQuality,
} from './published-benchmarks';
import { DEFAULT_ROUTING_TABLE } from './task-router';

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
]);

describe('benchmarks oficiais publicados (F-675)', () => {
  it('toda chave aponta para um modelo do catálogo builtin', () => {
    const reachable = new Set(
      Object.entries(BUILTIN_MODEL_CATALOG.adapters ?? {}).flatMap(([adapterId, entry]) =>
        (entry.models ?? []).map(m => publishedBenchmarkKey(adapterId, m.id))),
    );
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
});
