import { describe, expect, it } from 'vitest';
import {
  darwinMediaDisabledFeatures,
  darwinMediaEnabledFeatures,
} from './darwin-media-services';

describe('darwinMediaDisabledFeatures (F-1434)', () => {
  it('no macOS desliga o Audio Service out-of-process (captura roda no browser)', () => {
    // Segurar Space (ditado) abria getUserMedia → o Chromium lançava o
    // Audio Service num NexusIDE Helper com sandbox seatbelt; no macOS
    // 27.2 esses helpers morriam no dyld e derrubavam renderer + main.
    expect(darwinMediaDisabledFeatures('darwin')).toEqual([
      'AudioServiceOutOfProcess',
    ]);
  });

  it.each(['win32', 'linux', 'freebsd', ''])(
    'fora do macOS (%s) nenhuma feature muda',
    (platform) => {
      expect(darwinMediaDisabledFeatures(platform)).toEqual([]);
    },
  );
});

describe('darwinMediaEnabledFeatures (F-1434)', () => {
  it('no macOS traz o Video Capture Service para o browser process', () => {
    // enumerateDevices (antes do getUserMedia do ditado) também conversa
    // com o serviço de captura de vídeo out-of-process.
    expect(darwinMediaEnabledFeatures('darwin')).toEqual([
      'VideoCaptureServiceInBrowserProcess',
    ]);
  });

  it.each(['win32', 'linux', 'freebsd', ''])(
    'fora do macOS (%s) nenhuma feature muda',
    (platform) => {
      expect(darwinMediaEnabledFeatures(platform)).toEqual([]);
    },
  );
});
