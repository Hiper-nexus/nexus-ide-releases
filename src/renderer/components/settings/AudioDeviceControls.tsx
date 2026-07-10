import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../state/settings-store';
import { supportsOutputDeviceSelection } from '../../voice/audio-device-preferences';

function cleanDefaultLabel(label: string): string {
  return label
    .replace(/^(default|padr[aã]o)(\s+device)?\s*[-–—:]\s*/i, '')
    .trim();
}

function deviceLabel(
  kind: MediaDeviceKind,
  device: MediaDeviceInfo,
  index: number,
): string {
  if (device.label.trim()) return device.label.trim();
  return kind === 'audioinput' ? `Microfone ${index + 1}` : `Saída ${index + 1}`;
}

function DeviceSelect({
  kind,
  value,
  devices,
  onChange,
}: {
  kind: 'audioinput' | 'audiooutput';
  value: string;
  devices: MediaDeviceInfo[];
  onChange: (deviceId: string) => void;
}) {
  const matching = devices.filter(
    (device) => device.kind === kind && device.deviceId !== 'default',
  );
  const systemDefault = devices.find(
    (device) => device.kind === kind && device.deviceId === 'default',
  );
  const defaultName = cleanDefaultLabel(systemDefault?.label ?? '');
  const selectedIsMissing =
    value !== 'default' && !matching.some((device) => device.deviceId === value);

  return (
    <select
      className="settings-input"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="default">
        Padrão do sistema{defaultName ? ` — ${defaultName}` : ''}
      </option>
      {selectedIsMissing && (
        <option value={value}>Dispositivo indisponível — usando o padrão</option>
      )}
      {matching.map((device, index) => (
        <option key={device.deviceId} value={device.deviceId}>
          {deviceLabel(kind, device, index)}
        </option>
      ))}
    </select>
  );
}

export function AudioDeviceControls() {
  const audio = useSettingsStore((state) => state.audio);
  const updateAudio = useSettingsStore((state) => state.updateAudio);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível listar os dispositivos de áudio.',
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () =>
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  const counts = useMemo(
    () => ({
      inputs: devices.filter(
        (device) => device.kind === 'audioinput' && device.deviceId !== 'default',
      ).length,
      outputs: devices.filter(
        (device) => device.kind === 'audiooutput' && device.deviceId !== 'default',
      ).length,
    }),
    [devices],
  );
  const canSelectOutput = supportsOutputDeviceSelection();

  return (
    <div
      className="settings-audio"
      aria-label="Roteamento de áudio"
      aria-busy={refreshing}
    >
      <div className="settings-audio__head">
        <div>
          <h4 className="settings-audio__title">Dispositivos de áudio</h4>
          <p className="settings-audio__summary">
            {counts.inputs} entrada(s) · {counts.outputs} saída(s) detectada(s)
          </p>
        </div>
        <button
          type="button"
          className="settings-btn"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {error && <p className="settings-error" role="alert">{error}</p>}

      <div className="settings-audio__grid">
        <label className="settings-field">
          Microfone
          <DeviceSelect
            kind="audioinput"
            value={audio.inputDeviceId}
            devices={devices}
            onChange={(inputDeviceId) => void updateAudio({ inputDeviceId })}
          />
          <span className="settings-field__note">
            Fonte única do wake word, push-to-talk e Jarvis Live.
          </span>
        </label>

        <label className="settings-field">
          Saída de áudio
          <DeviceSelect
            kind="audiooutput"
            value={audio.outputDeviceId}
            devices={devices}
            onChange={(outputDeviceId) => void updateAudio({ outputDeviceId })}
          />
          <span className="settings-field__note">
            Respostas Classic, Realtime e prévias de voz saem por aqui.
          </span>
          {audio.outputDeviceId !== 'default' && !canSelectOutput && (
            <span className="settings-field__note settings-field__note--warning">
              Este runtime não consegue fixar uma saída específica; use Padrão do sistema.
            </span>
          )}
        </label>
      </div>
    </div>
  );
}
