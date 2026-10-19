import { describe, expect, it, vi } from 'vitest';
import { openSystemSoundSettings, systemSoundSettingsUrl } from './system-sound-settings';

describe('Ajustes de microfone e som por sistema (F-1579)', () => {
  it('no Windows abre as telas do Windows pelo shell, não o "open" do macOS', async () => {
    const openExternal = vi.fn(async () => undefined);
    await expect(openSystemSoundSettings('microphone', { platform: 'win32', openExternal }))
      .resolves.toEqual({ ok: true, url: 'ms-settings:privacy-microphone' });
    await expect(openSystemSoundSettings('sound', { platform: 'win32', openExternal }))
      .resolves.toEqual({ ok: true, url: 'ms-settings:sound' });
    expect(openExternal.mock.calls).toEqual([
      ['ms-settings:privacy-microphone'],
      ['ms-settings:sound'],
    ]);
  });

  it('no macOS mantém os painéis de Privacidade e Som', () => {
    expect(systemSoundSettingsUrl('microphone', 'darwin')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
    expect(systemSoundSettingsUrl('sound', 'darwin')).toBe(
      'x-apple.systempreferences:com.apple.preference.sound',
    );
  });

  it('no Linux não abre nada (cada desktop tem os seus Ajustes)', async () => {
    const openExternal = vi.fn(async () => undefined);
    await expect(openSystemSoundSettings('sound', { platform: 'linux', openExternal }))
      .resolves.toEqual({ ok: false, reason: 'unsupported-platform' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('falha do shell vira motivo, nunca exceção no Main', async () => {
    const rejecting = vi.fn(async () => { throw new Error('sem handler'); });
    await expect(openSystemSoundSettings('microphone', { platform: 'win32', openExternal: rejecting }))
      .resolves.toEqual({ ok: false, reason: 'open-failed' });
    const throwing = vi.fn(() => { throw new Error('síncrono'); });
    await expect(openSystemSoundSettings('sound', { platform: 'darwin', openExternal: throwing }))
      .resolves.toEqual({ ok: false, reason: 'open-failed' });
  });
});
