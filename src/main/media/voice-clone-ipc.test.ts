import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VOICE_CLONE_CHANNELS } from '../../shared/voice-clone-types';

const state = vi.hoisted(() => ({
  trusted: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  rawIpc: vi.fn(),
  userData: '',
}));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: state.rawIpc, on: state.rawIpc },
}));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => {
    state.trusted.set(channel, handler);
  },
}));
vi.mock('./media-keys', () => ({ resolveMediaKey: () => undefined }));

import { registerVoiceCloneIpc } from './voice-clone-ipc';
import { isNexusClonedVoice } from './voice-origin';

beforeAll(() => {
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-voice-ipc-'));
  registerVoiceCloneIpc();
});

afterAll(() => {
  fs.rmSync(state.userData, { recursive: true, force: true });
});

describe('IPC de Minha voz', () => {
  it('todo canal passa por handleTrusted; nenhum fica no ipcMain cru', () => {
    expect([...state.trusted.keys()].sort()).toEqual(Object.values(VOICE_CLONE_CHANNELS).sort());
    expect(state.rawIpc).not.toHaveBeenCalled();
  });

  it('lista vazia sem recibo e liga a origem nexus-clone ao recibo', async () => {
    expect(await state.trusted.get(VOICE_CLONE_CHANNELS.list)!({})).toEqual([]);
    expect(isNexusClonedVoice('qualquer')).toBe(false);
  });

  it('começar devolve código de 6 dígitos e o texto de leitura', async () => {
    const session = (await state.trusted.get(VOICE_CLONE_CHANNELS.begin)!({})) as {
      sessionId: string;
      code: string;
      readingText: string;
    };
    expect(session.sessionId).toMatch(/^[a-f0-9]{32}$/u);
    expect(session.code).toMatch(/^\d{6}$/u);
    expect(session.readingText.length).toBeGreaterThan(400);
  });

  it('payload que não é áudio ou passa do teto é recusado sem tocar no fluxo', async () => {
    const verify = state.trusted.get(VOICE_CLONE_CHANNELS.verifyDeclaration)!;
    expect(await verify({}, { sessionId: 'x', speakerName: 'Ana', wav: 'base64' })).toMatchObject({ ok: false });
    expect(
      await verify({}, { sessionId: 'a'.repeat(32), speakerName: 'Ana', wav: new Uint8Array(9 * 1024 * 1024) }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/grande demais/u) });
    const create = state.trusted.get(VOICE_CLONE_CHANNELS.create)!;
    expect(await create({}, { sessionId: 'a'.repeat(32), voiceName: 'v', samples: [] })).toMatchObject({ ok: false });
    const remove = state.trusted.get(VOICE_CLONE_CHANNELS.remove)!;
    expect(await remove({}, { id: '../../etc' })).toMatchObject({ ok: false, canRemoveLocally: false });
  });
});
