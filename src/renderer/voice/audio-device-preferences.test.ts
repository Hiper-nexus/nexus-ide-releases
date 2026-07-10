import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreferredOutputDevice,
  inputConstraintsForDevices,
  requirePreferredOutputDevice,
  setAudioDevicePreferences,
  subscribeAudioDevicePreferences,
} from './audio-device-preferences';

const device = (
  kind: MediaDeviceKind,
  deviceId: string,
  label: string,
): Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'> => ({
  kind,
  deviceId,
  label,
});

beforeEach(() => {
  setAudioDevicePreferences({
    inputDeviceId: 'default',
    outputDeviceId: 'default',
  });
});

describe('inputConstraintsForDevices', () => {
  it('pins the physical device behind the operating-system default alias', () => {
    const devices = [
      device('audioinput', 'default', 'Default – FIFINE Microphone'),
      device('audioinput', 'usb-fifine', 'FIFINE Microphone'),
    ];

    expect(
      inputConstraintsForDevices({ channelCount: 1 }, 'default', devices),
    ).toEqual({ channelCount: 1, deviceId: { exact: 'usb-fifine' } });
  });

  it('uses an explicit available input and safely follows the system when it vanished', () => {
    const devices = [device('audioinput', 'mic-2', 'Desk mic')];
    expect(inputConstraintsForDevices({}, 'mic-2', devices)).toEqual({
      deviceId: { exact: 'mic-2' },
    });
    expect(inputConstraintsForDevices({}, 'unplugged', devices)).toEqual({});
  });
});

describe('audio device preference notifications', () => {
  it('notifies only when a preference actually changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAudioDevicePreferences(listener);

    setAudioDevicePreferences({
      inputDeviceId: 'default',
      outputDeviceId: 'default',
    });
    setAudioDevicePreferences({
      inputDeviceId: 'desk-mic',
      outputDeviceId: 'headphones',
    });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      { inputDeviceId: 'desk-mic', outputDeviceId: 'headphones' },
      { inputDeviceId: 'default', outputDeviceId: 'default' },
    );
  });
});

describe('applyPreferredOutputDevice', () => {
  it('maps the system default to an empty sink id', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    await expect(
      applyPreferredOutputDevice({ setSinkId }, 'default'),
    ).resolves.toBe(true);
    expect(setSinkId).toHaveBeenCalledWith('');
  });

  it('degrades cleanly when AudioContext sink selection is unavailable', async () => {
    await expect(applyPreferredOutputDevice({}, 'headphones')).resolves.toBe(false);
  });

  it('does not silently reroute an explicitly selected output to the system default', async () => {
    await expect(requirePreferredOutputDevice({}, 'headphones')).rejects.toThrow(
      'Não foi possível aplicar a saída de áudio selecionada',
    );
    await expect(requirePreferredOutputDevice({}, 'default')).resolves.toBeUndefined();
  });
});
