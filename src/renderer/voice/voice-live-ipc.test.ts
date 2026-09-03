/**
 * Regressão: falha IPC ao encerrar áudio/turno Live era silenciada com
 * `.catch(() => {})` — UI presa em estado inconsistente, defeito
 * indiagnosticável. Agora registra (logVoice) e expõe na store (status error).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveEndTurn, liveEndUserAudio } from './voice-live-ipc';

vi.mock('./voice-realtime-gates', () => ({
  isJarvisLiveEnabled: () => true,
}));

const voice = vi.hoisted(() => ({
  liveEndUserAudio: vi.fn(),
  liveEndTurn: vi.fn(),
  liveStatus: vi.fn(async () => ({})),
  logVoice: vi.fn(),
}));

function stubVoice(): void {
  vi.stubGlobal('window', { nexus: { voice: voice } });
}

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

describe('voice-live-ipc — erro ao encerrar Live não some', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubVoice();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('liveEndTurn com IPC falhando registra e marca erro (e limpa o MCP)', async () => {
    voice.liveEndTurn.mockRejectedValueOnce(new Error('ipc quebrou'));

    liveEndTurn();
    await flush();

    expect(voice.logVoice).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', event: 'live.endTurnFailed' }),
    );
    expect(voice.liveStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'ipc quebrou' }),
    );
  });

  it('liveEndUserAudio com IPC falhando registra e marca erro', async () => {
    voice.liveEndUserAudio.mockRejectedValueOnce(new Error('canal morto'));

    liveEndUserAudio();
    await flush();

    expect(voice.logVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        event: 'live.endUserAudioFailed',
      }),
    );
    expect(voice.liveStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'canal morto' }),
    );
  });
});
