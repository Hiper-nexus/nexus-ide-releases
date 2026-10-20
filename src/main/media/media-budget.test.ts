import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  costPhrase,
  estimateMediaToolUsd,
  MediaBudget,
  reserveMediaSpend,
  withMediaSpend,
} from './media-budget';

/** F-1606 — teto de gasto de mídia por missão e por dia. */

let dir: string;
let now: number;
const clock = () => now;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-budget-'));
  now = new Date(2026, 9, 19, 10, 0, 0).getTime();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('teto de gasto de mídia', () => {
  it('sem teto tudo passa e fica registrado; o arquivo é 0600 e sobrevive ao reinício', () => {
    const budget = new MediaBudget(dir, clock);
    const reservation = budget.reserve({ usd: 1.25, tool: 'video_generate', provider: 'replicate-video', missionId: 'm1' });
    expect(reservation.ok).toBe(true);
    if (reservation.ok) reservation.settle(1.2);
    expect(budget.spentToday()).toBe(1.2);
    expect(budget.spentForMission('m1')).toBe(1.2);
    const file = path.join(dir, 'media-spend.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new MediaBudget(dir, clock).spentToday()).toBe(1.2);
  });

  it('o teto diário recusa antes de cobrar e diz quanto já foi', () => {
    const budget = new MediaBudget(dir, clock);
    budget.setLimits({ perDayUsd: 2, perMissionUsd: null });
    const first = budget.reserve({ usd: 1.5, tool: 'image_generate', provider: 'openai-image' });
    if (!first.ok) throw new Error(first.error);
    first.settle();
    const refused = budget.reserve({ usd: 0.6, tool: 'image_generate', provider: 'openai-image' });
    expect(refused).toMatchObject({
      ok: false,
      budget: { limit: 'day', limitUsd: 2, spentUsd: 1.5, requestUsd: 0.6 },
      error: expect.stringMatching(/hoje já foram US\$ 1,50 de US\$ 2,00.*Nada foi cobrado/u),
    });
    expect(budget.reserve({ usd: 0.5, tool: 'image_generate', provider: 'openai-image' }).ok).toBe(true);
  });

  it('o dia vira à meia-noite local e entradas velhas saem do arquivo', () => {
    const budget = new MediaBudget(dir, clock);
    budget.setLimits({ perDayUsd: 1, perMissionUsd: null });
    const today = budget.reserve({ usd: 1, tool: 't', provider: 'p' });
    if (today.ok) today.settle();
    expect(budget.reserve({ usd: 0.1, tool: 't', provider: 'p' }).ok).toBe(false);
    now += 24 * 60 * 60 * 1000;
    expect(budget.spentToday()).toBe(0);
    expect(budget.reserve({ usd: 0.1, tool: 't', provider: 'p' }).ok).toBe(true);
    now += 60 * 24 * 60 * 60 * 1000;
    budget.setLimits({ perDayUsd: null, perMissionUsd: null });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'media-spend.json'), 'utf8')) as { entries: unknown[] };
    expect(stored.entries).toEqual([]);
  });

  it('o teto por missão só conta a missão; sem missão não se aplica', () => {
    const budget = new MediaBudget(dir, clock);
    budget.setLimits({ perMissionUsd: 1, perDayUsd: null });
    const a = budget.reserve({ usd: 0.9, tool: 't', provider: 'p', missionId: 'm1' });
    if (a.ok) a.settle();
    expect(budget.reserve({ usd: 0.2, tool: 't', provider: 'p', missionId: 'm1' })).toMatchObject({
      ok: false,
      budget: { limit: 'mission' },
    });
    expect(budget.reserve({ usd: 0.2, tool: 't', provider: 'p', missionId: 'm2' }).ok).toBe(true);
    expect(budget.reserve({ usd: 5, tool: 't', provider: 'p' }).ok).toBe(true);
  });

  it('duas chamadas em paralelo não passam juntas: a reserva conta antes do resultado', () => {
    const budget = new MediaBudget(dir, clock);
    budget.setLimits({ perDayUsd: 1, perMissionUsd: null });
    const first = budget.reserve({ usd: 0.6, tool: 'v', provider: 'p' });
    const second = budget.reserve({ usd: 0.6, tool: 'v', provider: 'p' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (first.ok) first.release();
    expect(budget.reserve({ usd: 0.6, tool: 'v', provider: 'p' }).ok).toBe(true);
  });

  it('com teto ligado, custo desconhecido é recusado; sem teto, passa', () => {
    const budget = new MediaBudget(dir, clock);
    expect(budget.reserve({ usd: null, tool: 'video_generate', provider: 'x' }).ok).toBe(true);
    budget.setLimits({ perDayUsd: 10, perMissionUsd: null });
    expect(budget.reserve({ usd: null, tool: 'video_generate', provider: 'x' })).toMatchObject({
      ok: false,
      budget: { limit: 'unknown-cost' },
      error: expect.stringMatching(/custo deste pedido é desconhecido/u),
    });
  });

  it('limites fora da faixa são recusados; arquivo corrompido recomeça em vez de travar', () => {
    const budget = new MediaBudget(dir, clock);
    expect(() => budget.setLimits({ perDayUsd: -1, perMissionUsd: null })).toThrow();
    expect(() => budget.setLimits({ perDayUsd: 20_000, perMissionUsd: null })).toThrow();
    fs.writeFileSync(path.join(dir, 'media-spend.json'), '{quebrado');
    expect(new MediaBudget(dir, clock).view()).toEqual({ limits: { perMissionUsd: null, perDayUsd: null }, spentTodayUsd: 0 });
  });

  it('withMediaSpend: falha libera a reserva, resultado ok:false também, sucesso assenta o custo real', async () => {
    const budget = new MediaBudget(dir, clock);
    await expect(
      withMediaSpend({ usd: 1, tool: 't', provider: 'p' }, async () => {
        throw new Error('HTTP 500');
      }, undefined, budget),
    ).rejects.toThrow('HTTP 500');
    expect(budget.spentToday()).toBe(0);
    await withMediaSpend({ usd: 1, tool: 't', provider: 'p' }, async () => ({ ok: false }), undefined, budget);
    expect(budget.spentToday()).toBe(0);
    await withMediaSpend({ usd: 1, tool: 't', provider: 'p' }, async () => ({ ok: true, cost: 0.4 }), (result) => result.cost, budget);
    expect(budget.spentToday()).toBe(0.4);
    budget.setLimits({ perDayUsd: 0.5, perMissionUsd: null });
    expect(await withMediaSpend({ usd: 0.2, tool: 't', provider: 'p' }, async () => ({ ok: true }), undefined, budget)).toMatchObject({
      ok: false,
      budget: { limit: 'day' },
    });
    expect(reserveMediaSpend({ provider: 'p', usd: 99 }, null, 't', null)).toMatchObject({ ok: true });
  });
});

describe('custo estimado por pedido (modal e teto)', () => {
  it('estima imagem, vídeo, fala, música e narração pelo preço de lista', () => {
    expect(estimateMediaToolUsd('nexus_audio_generate', { text: 'a'.repeat(1_000) })).toEqual({ provider: 'elevenlabs', usd: 0.08 });
    expect(estimateMediaToolUsd('nexus_music_generate', { lengthMs: 60_000 })).toEqual({ provider: 'elevenlabs', usd: 0.15 });
    expect(estimateMediaToolUsd('nexus_music_generate', { lengthMs: 60_000, dryRun: true })).toEqual({ provider: 'elevenlabs', usd: 0 });
    expect(estimateMediaToolUsd('nexus_voiceover_generate', { script: 'a'.repeat(900) })).toEqual({ provider: 'elevenlabs', usd: 0.072 });
    expect(estimateMediaToolUsd('nexus_voiceover_generate', { scriptPath: 'roteiro.txt' })).toEqual({ provider: 'elevenlabs', usd: null });
    // F-1601: Gemini voice — 1.400 caracteres ≈ 100 s de fala a 25 tokens/s e US$ 9 por milhão.
    expect(estimateMediaToolUsd('nexus_voiceover_generate', { script: 'a'.repeat(1_400), provider: 'gemini' })?.provider).toBe('google-image');
    expect(estimateMediaToolUsd('nexus_voiceover_generate', { script: 'a'.repeat(1_400), provider: 'gemini' })?.usd).toBeGreaterThan(0);
    expect(estimateMediaToolUsd('nexus_video_generate', { recoverJobId: 'abc' })).toMatchObject({ usd: 0 });
    const image = estimateMediaToolUsd('nexus_image_generate', { provider: 'replicate-image', model: 'bytedance/seedream-5-pro' });
    expect(image).toEqual({ provider: 'replicate-image', usd: 0.04 });
    expect(estimateMediaToolUsd('nexus_image_generate', { provider: 'nao-existe' })).toEqual({ provider: 'nao-existe', usd: null });
    expect(estimateMediaToolUsd('nexus_browser_open', {})).toBeNull();
  });

  it('o modal diz o custo, ou que é desconhecido', () => {
    expect(costPhrase({ usd: 0.072 })).toBe("; estimated cost: US$ 0,07 (list price, charged to the operator's key)");
    expect(costPhrase({ usd: null })).toMatch(/unknown/u);
    expect(costPhrase(null)).toBe('');
  });
});
