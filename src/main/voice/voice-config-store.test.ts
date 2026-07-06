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
});
