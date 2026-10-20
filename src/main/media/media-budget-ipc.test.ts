import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MEDIA_BUDGET_CHANNELS } from '../../shared/media-budget-types';

/** F-1606 — o teto só é gravado pela janela principal (handleTrusted). */

const state = vi.hoisted(() => ({
  trusted: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  rawIpc: vi.fn(),
  userData: '',
}));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  ipcMain: { handle: state.rawIpc, on: state.rawIpc },
}));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => state.trusted.set(channel, handler),
}));

import { registerMediaBudgetIpc } from './media-budget-ipc';
import { configureMediaBudget, getMediaBudget } from './media-budget';

beforeAll(() => {
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-budget-ipc-'));
  registerMediaBudgetIpc();
});

afterAll(() => {
  configureMediaBudget(null);
  fs.rmSync(state.userData, { recursive: true, force: true });
});

describe('IPC do teto de gasto de mídia', () => {
  it('os dois canais passam por handleTrusted e o livro-razão do app fica configurado', () => {
    expect([...state.trusted.keys()].sort()).toEqual(Object.values(MEDIA_BUDGET_CHANNELS).sort());
    expect(state.rawIpc).not.toHaveBeenCalled();
    expect(getMediaBudget()).not.toBeNull();
  });

  it('grava, devolve o estado e recusa valor fora da faixa sem mudar nada', async () => {
    const set = state.trusted.get(MEDIA_BUDGET_CHANNELS.set)!;
    expect(await set({}, { perMissionUsd: 3, perDayUsd: null })).toEqual({
      ok: true,
      limits: { perMissionUsd: 3, perDayUsd: null },
      spentTodayUsd: 0,
    });
    expect(await set({}, { perMissionUsd: -1, perDayUsd: null })).toMatchObject({ ok: false });
    expect(await set({}, { perMissionUsd: 1, perDayUsd: 2, extra: true })).toMatchObject({ ok: false });
    expect(await state.trusted.get(MEDIA_BUDGET_CHANNELS.get)!({})).toEqual({
      limits: { perMissionUsd: 3, perDayUsd: null },
      spentTodayUsd: 0,
    });
    expect(fs.existsSync(path.join(state.userData, 'media', 'media-spend.json'))).toBe(true);
  });
});
