import type { AudioSettings } from '../../shared/settings-types';

type DeviceDescriptor = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>;
type PreferenceListener = (next: AudioSettings, previous: AudioSettings) => void;
type SinkSelectableContext = object;

const EXPLICIT_OUTPUT_UNAVAILABLE_MESSAGE =
  'Não foi possível aplicar a saída de áudio selecionada. Use "Padrão do sistema" ou reconecte o dispositivo.';

let current: AudioSettings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
};
const listeners = new Set<PreferenceListener>();

export function getAudioDevicePreferences(): AudioSettings {
  return { ...current };
}

export function setAudioDevicePreferences(next: AudioSettings): void {
  if (
    current.inputDeviceId === next.inputDeviceId &&
    current.outputDeviceId === next.outputDeviceId
  ) {
    return;
  }
  const previous = current;
  current = { ...next };
  for (const listener of listeners) listener({ ...current }, { ...previous });
}

export function subscribeAudioDevicePreferences(
  listener: PreferenceListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function normalizedDefaultLabel(label: string): string {
  return label
    .replace(/^(default|padr[aã]o)(\s+device)?\s*[-–—:]\s*/i, '')
    .trim()
    .toLocaleLowerCase();
}

function resolvedInputDeviceId(
  preferredId: string,
  devices: readonly DeviceDescriptor[],
): string | null {
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  if (preferredId !== 'default') {
    return inputs.some((device) => device.deviceId === preferredId)
      ? preferredId
      : null;
  }

  const systemDefault = inputs.find((device) => device.deviceId === 'default');
  const defaultLabel = normalizedDefaultLabel(systemDefault?.label ?? '');
  if (!defaultLabel) return null;
  return (
    inputs.find(
      (device) =>
        device.deviceId !== 'default' &&
        normalizedDefaultLabel(device.label) === defaultLabel,
    )?.deviceId ?? null
  );
}

export function inputConstraintsForDevices(
  base: MediaTrackConstraints,
  preferredId: string,
  devices: readonly DeviceDescriptor[],
): MediaTrackConstraints {
  const deviceId = resolvedInputDeviceId(preferredId, devices);
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base };
}

export async function preferredInputConstraints(
  base: MediaTrackConstraints,
): Promise<MediaTrackConstraints> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return inputConstraintsForDevices(
      base,
      current.inputDeviceId,
      devices,
    );
  } catch {
    return { ...base };
  }
}

export async function applyPreferredOutputDevice(
  context: SinkSelectableContext,
  preferredId = current.outputDeviceId,
): Promise<boolean> {
  const selectable = context as {
    setSinkId?: (sinkId: string) => Promise<void>;
  };
  if (typeof selectable.setSinkId !== 'function') return false;
  try {
    await selectable.setSinkId(preferredId === 'default' ? '' : preferredId);
    return true;
  } catch {
    return false;
  }
}

/**
 * The system default is always a valid fallback. A user-selected physical sink
 * is not: playing through a different device is worse than surfacing the
 * routing problem, especially for hands-free Jarvis use.
 */
export async function requirePreferredOutputDevice(
  context: SinkSelectableContext,
  preferredId = current.outputDeviceId,
): Promise<void> {
  const applied = await applyPreferredOutputDevice(context, preferredId);
  if (!applied && preferredId !== 'default') {
    throw new Error(EXPLICIT_OUTPUT_UNAVAILABLE_MESSAGE);
  }
}

/** Whether this Electron/Chromium runtime can pin WebAudio to a physical sink. */
export function supportsOutputDeviceSelection(): boolean {
  if (typeof AudioContext === 'undefined') return false;
  return typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === 'function';
}
