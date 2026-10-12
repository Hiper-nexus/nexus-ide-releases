import { describe, expect, it } from 'vitest';
import {
  isNewerModelVersion,
  isSameLineAtLeast,
  modelLineOf,
  newestInModelLine,
} from './model-line';

describe('modelLineOf', () => {
  it.each([
    ['gpt-6-sol', 'gpt-#-sol', [6]],
    ['gpt-6.1-sol', 'gpt-#-sol', [6, 1]],
    ['claude-opus-5', 'claude-opus-#', [5]],
    ['claude-opus-5-5', 'claude-opus-#', [5, 5]],
    ['gemini-3.8-flash-low', 'gemini-#-flash-low', [3, 8]],
    ['gemini-3.9-flash-low-preview', 'gemini-#-flash-low', [3, 9]],
    ['gemini-3.9-flash-preview', 'gemini-#-flash', [3, 9]],
    ['gemini-3.8-flash-LATEST', 'gemini-#-flash', [3, 8]],
    ['glm-5.3-flash[1m]', 'glm-#-flash', [5, 3]],
    ['gpt-6.1-sol-2026-09-29', 'gpt-#-sol-#', [6, 1, 2026, 9, 29]],
    ['minimax/MiniMax-M3', 'minimax/minimax-m#', [3]],
    ['minimax/MiniMax-M3.1-Flash-Preview', 'minimax/minimax-m#-flash', [3, 1]],
    ['kimi-code/k3', 'kimi-code/k#', [3]],
    // `3-256` é UM grupo de dígitos (`\d+(?:[.-]\d+)*`) — a variante de
    // contexto conta como versão da linha k3, não como linha própria.
    ['kimi-code/k3-256k', 'kimi-code/k#k', [3, 256]],
    ['deepseek-flash', 'deepseek-flash', []],
  ])('%s → stem %s versão %j', (model, stem, version) => {
    expect(modelLineOf(model)).toEqual({ stem, version });
  });

  it('sufixo de canal no fim não muda a linha, mas não no meio', () => {
    // Só um sufixo trailing é canal; `-preview` no meio do id separa a linha.
    expect(modelLineOf('gemini-3.9-flash-preview-low').stem).toBe(
      'gemini-#-flash-preview-low',
    );
    expect(modelLineOf('gemini-3.9-flash-preview-low').stem).not.toBe(
      modelLineOf('gemini-3.8-flash-low').stem,
    );
  });
});

describe('isNewerModelVersion', () => {
  it.each([
    [[6, 1], [6], true],
    [[6], [6, 1], false],
    [[5, 5], [5], true],
    [[3, 9], [3, 8], true],
    [[3], [3], false],
    [[], [], false],
    [[2, 7], [3], false],
    [[6, 1, 2026, 9, 29], [6, 1], true],
  ])('%j vs %j → %s', (a, b, expected) => {
    expect(isNewerModelVersion(a, b)).toBe(expected);
  });
});

describe('newestInModelLine (F-217 — o mais novo da linha vence)', () => {
  it.each([
    ['gpt-6-sol', ['gpt-6.1-sol'], 'gpt-6.1-sol'],
    ['claude-opus-5', ['claude-opus-5-5'], 'claude-opus-5-5'],
    ['gemini-3.8-flash', ['gemini-3.9-flash-preview'], 'gemini-3.9-flash-preview'],
    [
      'gemini-3.8-flash-low',
      ['gemini-3.9-flash-low-preview'],
      'gemini-3.9-flash-low-preview',
    ],
    // Entre vários mais novos da linha, o MAIS novo.
    ['gpt-6-sol', ['gpt-6.1-sol', 'gpt-6.2-sol'], 'gpt-6.2-sol'],
    ['gpt-6-sol', ['gpt-6.2-sol', 'gpt-6.1-sol'], 'gpt-6.2-sol'],
    // Mesma versão não conta como mais nova (preview não promove).
    ['gemini-3.8-flash', ['gemini-3.8-flash-preview'], 'gemini-3.8-flash'],
    // Só mais velhos na lista → fica o modelo pedido.
    ['gpt-6.1-sol', ['gpt-6-sol', 'gpt-5.6-sol'], 'gpt-6.1-sol'],
  ])('%s + %j → %s', (model, candidates, expected) => {
    expect(newestInModelLine(model, candidates)).toBe(expected);
  });

  it.each([
    // Linhas DIFERENTES nunca se promovem entre si.
    ['gemini-3.8-flash-low', 'gemini-3.9-flash-preview-low'],
    ['gpt-6.1-sol', 'gpt-6.1-sol-ultrafast'],
    ['grok-4.7', 'grok-4.7-build-fast'],
    ['kimi-code/k3', 'kimi-code/k3-256k'],
    ['glm-5.3', 'glm-5.3-flash[1m]'],
    ['gpt-6.1-sol', 'gpt-6.1-sol-2026-09-29'],
    ['minimax/MiniMax-M3', 'minimax/MiniMax-M3.1-Flash-Preview'],
  ])('%s não herda %s (linha distinta)', (model, candidate) => {
    expect(newestInModelLine(model, [candidate])).toBe(model);
  });

  it('empate de versão fica com o 1º da ordem do candidato', () => {
    expect(newestInModelLine('gpt-6-sol', ['gpt-6.1-sol', 'GPT-6.1-SOL'])).toBe(
      'gpt-6.1-sol',
    );
  });

  it('sem candidatos ou sem linha mais nova devolve o próprio modelo', () => {
    expect(newestInModelLine('gpt-6-sol', [])).toBe('gpt-6-sol');
    expect(newestInModelLine('deepseek-flash', ['deepseek-chat'])).toBe(
      'deepseek-flash',
    );
  });
});

describe('isSameLineAtLeast (a vaga de topo é da linha, não do id)', () => {
  it.each([
    // Versão mais nova ou igual da mesma linha conta como o modelo de topo.
    ['claude-opus-5-6', 'claude-opus-5-5', true],
    ['claude-opus-5-5', 'claude-opus-5-5', true],
    ['gpt-6.1-astra', 'gpt-6-astra', true],
    ['claude-fable-5-2', 'claude-fable-5-1', true],
    // Mais velho da mesma linha NÃO ocupa a vaga do topo.
    ['claude-opus-5', 'claude-opus-5-5', false],
    ['gpt-5.6-astra', 'gpt-6-astra', false],
    // Revisão datada COLADA na versão (sem letra separando) vira extensão dela:
    // mesma linha, mais nova — é assim que ids como claude-opus-4-5-20251101
    // funcionam de verdade.
    ['claude-opus-5-5-2026-09-29', 'claude-opus-5-5', true],
    // Linha distinta nunca conta — incluindo data separada por letra
    // (`gpt-6.1-sol-2026-09-29` tem stem `gpt-#-sol-#`).
    ['claude-sonnet-5-5', 'claude-opus-5-5', false],
    ['gpt-6.1-sol', 'gpt-6-astra', false],
    ['gpt-6.1-sol-2026-09-29', 'gpt-6.1-sol', false],
  ])('%s é a mesma linha de %s e não mais velho → %s', (model, reference, expected) => {
    expect(isSameLineAtLeast(model, reference)).toBe(expected);
  });
});

describe('Muse wonder é linha própria (F-1391)', () => {
  it('spark não é promovido para wonder/wonder-full pela regra de linha, nem o inverso', () => {
    const catalog = ['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.2'];
    expect(modelLineOf('muse-spark-1.3').stem).not.toBe(modelLineOf('muse-wonder-1.0').stem);
    expect(modelLineOf('muse-wonder-1.0').stem).not.toBe(modelLineOf('muse-wonder-full-1.0').stem);
    expect(newestInModelLine('muse-spark-1.2', catalog)).toBe('muse-spark-1.3');
    expect(newestInModelLine('muse-spark-1.3', catalog)).toBe('muse-spark-1.3');
    expect(newestInModelLine('muse-wonder-1.0', catalog)).toBe('muse-wonder-1.0');
    expect(newestInModelLine('muse-wonder-full-1.0', catalog)).toBe('muse-wonder-full-1.0');
    // A variante -contributor (conteúdo vai para melhoria de produto) não é
    // a mesma linha: nunca substitui o wonder por upgrade.
    expect(newestInModelLine('muse-wonder-1.0', ['muse-wonder-1.1-contributor'])).toBe('muse-wonder-1.0');
  });
});
