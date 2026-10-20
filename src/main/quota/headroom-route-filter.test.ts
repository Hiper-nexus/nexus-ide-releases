import { describe, expect, it } from 'vitest';
import type { HeadroomInput } from './account-headroom';
import { windowsServingModel } from './headroom-route-filter';

const W = (
  label: string,
  usedRatio: number,
): HeadroomInput['windows'][number] => ({
  label,
  kind: 'hours',
  usedRatio,
  source: 'provider-api',
});

const GEMINI = W('Gemini · 5 Horas', 0.1);
const THIRD = W('Claude/GPT · 5 Horas', 1);

describe('windowsServingModel', () => {
  it('mantém só os buckets que o modelo consome', () => {
    const out = windowsServingModel({ windows: [GEMINI, THIRD] }, 'gemini-3.8-flash-high');
    expect(out.windows).toEqual([GEMINI]);
  });

  it('casa o grupo de terceiros para um modelo claude', () => {
    const out = windowsServingModel({ windows: [GEMINI, THIRD] }, 'claude-opus-5-5');
    expect(out.windows).toEqual([THIRD]);
  });

  it('modelo desconhecido recua para todos os buckets (conservador)', () => {
    const out = windowsServingModel({ windows: [GEMINI, THIRD] }, 'modelo-que-ninguem-conhece');
    expect(out.windows).toEqual([GEMINI, THIRD]);
  });

  it('model null recua para todos os buckets', () => {
    const out = windowsServingModel({ windows: [GEMINI, THIRD] }, null);
    expect(out.windows).toEqual([GEMINI, THIRD]);
  });

  it('rótulo sem grupo conhecido é sempre mantido', () => {
    const plain = W('5 Horas', 0.5);
    const out = windowsServingModel({ windows: [plain, THIRD] }, 'gemini-3.8-flash-high');
    expect(out.windows).toEqual([plain]);
  });

  it('preserva onCooldown e updatedAt', () => {
    const input: HeadroomInput = {
      windows: [GEMINI, THIRD],
      onCooldown: true,
      updatedAt: 42,
    };
    const out = windowsServingModel(input, 'gemini-3.8-flash-high');
    expect(out.onCooldown).toBe(true);
    expect(out.updatedAt).toBe(42);
  });

  it('filtrar tudo recua para o input original, nunca devolve vazio', () => {
    const out = windowsServingModel({ windows: [THIRD] }, 'gemini-3.8-flash-high');
    expect(out.windows).toEqual([THIRD]);
  });

  it('casa por substring como o groupRank do agy-bridge, não por prefixo fixo', () => {
    const odd = W('Gemini 3 Pro (preview) — 5 Horas', 0.2);
    const out = windowsServingModel({ windows: [odd, THIRD] }, 'gemini-3.8-flash-high');
    expect(out.windows).toEqual([odd]);
  });

  it('input sem janelas devolve o input', () => {
    const empty: HeadroomInput = { windows: [] };
    expect(windowsServingModel(empty, 'gemini-3.8-flash-high')).toEqual(empty);
  });
});

describe('rótulos REAIS do AGY (medidos em 20/10 com `agy --print /quota` 1.4.3)', () => {
  // O servidor devolve os grupos "Gemini Models" e "Claude and GPT models";
  // `windowsFromGroup` prefixa o rótulo do bucket. Os fixtures inventados
  // ("Gemini · 5 Horas") casavam por sorte — estes são os de verdade.
  const G5 = W('Gemini Models · 5 Horas', 0.005);
  const GW = W('Gemini Models · Semanal', 0.109);
  const T5 = W('Claude and GPT models · 5 Horas', 0);
  const TW = W('Claude and GPT models · Semanal', 0);
  const all = { windows: [G5, GW, T5, TW] };

  it('modelo Gemini enxerga só os buckets Gemini', () => {
    expect(windowsServingModel(all, 'gemini-3.8-flash-high').windows).toEqual([G5, GW]);
  });

  it('modelo Claude enxerga só os buckets de terceiros', () => {
    expect(windowsServingModel(all, 'claude-opus-5-5').windows).toEqual([T5, TW]);
  });

  it('modelo GPT também cai no grupo de terceiros', () => {
    expect(windowsServingModel(all, 'gpt-6-astra').windows).toEqual([T5, TW]);
  });

  it('o grupo de terceiros cheio não alcança um pane Gemini', () => {
    const thirdFull = {
      windows: [G5, GW, { ...T5, usedRatio: 0.95 }, { ...TW, usedRatio: 0.95 }],
    };
    expect(windowsServingModel(thirdFull, 'gemini-3.8-flash-high').windows).toEqual([G5, GW]);
  });
});
