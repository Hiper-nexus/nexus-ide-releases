import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadStoreInTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-voice-config-'));
  vi.resetModules();
  vi.doMock('node:os', () => ({
    default: { homedir: () => home, tmpdir: os.tmpdir },
    homedir: () => home,
    tmpdir: os.tmpdir,
  }));
  const store = await import('./voice-config-store');
  return { home, store };
}

describe('voice-config-store', () => {
  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('persiste jarvisLiveEnabled quando setConfig aplica patch parcial', async () => {
    const { home, store } = await loadStoreInTempHome();
    store.loadVoiceConfig();

    store.applyConfigPatch({ jarvisLiveEnabled: true });

    const file = path.join(
      home,
      '.nexus',
      'plugins',
      'voice',
      'nexus-voice.json',
    );
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      jarvisLive: { enabled: boolean };
    };
    expect(saved.jarvisLive.enabled).toBe(true);

    store.applyConfigPatch({ jarvisLiveEnabled: false });

    const updated = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      jarvisLive: { enabled: boolean };
    };
    expect(updated.jarvisLive.enabled).toBe(false);
  });

  it('default é realtime (gemini-live) — hibernação revertida', async () => {
    const { store } = await loadStoreInTempHome();
    const config = store.loadVoiceConfig();
    expect(config.jarvisLive.transport).toBe('gemini-live');
  });

  it('preserva o transporte escolhido pelo usuário (validador, sem coerção)', async () => {
    const { store } = await loadStoreInTempHome();
    store.loadVoiceConfig();
    const openai = store.applyConfigPatch({ jarvisLiveTransport: 'openai-realtime' });
    expect(openai.jarvisLive.transport).toBe('openai-realtime');
    const classic = store.applyConfigPatch({ jarvisLiveTransport: 'classic' });
    expect(classic.jarvisLive.transport).toBe('classic');
    const gemini = store.applyConfigPatch({ jarvisLiveTransport: 'gemini-live' });
    expect(gemini.jarvisLive.transport).toBe('gemini-live');
  });

  it('migra TTS OpenAI nova para a voz realtime padrao', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG } = await import('../../shared/voice-config');
    const file = path.join(
      home,
      '.nexus',
      'plugins',
      'voice',
      'nexus-voice.json',
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          ...DEFAULT_VOICE_CONFIG,
          jarvisLive: {
            ...DEFAULT_VOICE_CONFIG.jarvisLive,
            enabled: true,
            transport: 'openai-realtime',
          },
          tts: {
            ...DEFAULT_VOICE_CONFIG.tts,
            voice: 'nova',
          },
        },
        null,
        2,
      ),
    );

    const loaded = store.loadVoiceConfig();
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      tts: { voice: string };
    };

    expect(loaded.tts.voice).toBe('marin');
    expect(saved.tts.voice).toBe('marin');
  });
});
