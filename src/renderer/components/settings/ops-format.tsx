import type { ReactNode } from 'react';
import type {
  ReadinessStatus,
} from '../../../shared/ops-ipc';
import type { ScreenPermissionStatus } from '../../../shared/vision-ipc';

export type MicPermissionStatus =
  | PermissionState
  | 'unsupported'
  | 'unavailable'
  | 'error';

export interface AudioDeviceInfo {
  count: number;
  activeLabel: string | null;
  error: string | null;
}

export function statusTone(
  status: ReadinessStatus | 'ok' | 'warn' | 'error',
): string {
  if (status === 'pass' || status === 'ok') return 'ok';
  if (status === 'fail' || status === 'error') return 'danger';
  return 'warn';
}

export function formatDate(value: string | number | null | undefined): string {
  if (!value) return 'sem dado';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'sem dado';
  return date.toLocaleString();
}

export function formatAge(value: number | null | undefined): string {
  if (!value) return 'sem atividade';
  const ageMs = Math.max(0, Date.now() - value);
  if (ageMs < 1000) return 'agora';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s atrás`;
  return `${Math.round(ageMs / 60_000)}min atrás`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

export function permissionTone(
  status: MicPermissionStatus | ScreenPermissionStatus,
): string {
  if (status === 'granted') return 'ok';
  if (status === 'denied' || status === 'restricted' || status === 'error') {
    return 'danger';
  }
  return 'warn';
}

export function permissionLabel(
  status: MicPermissionStatus | ScreenPermissionStatus,
): string {
  const labels: Record<string, string> = {
    granted: 'concedida',
    denied: 'negada',
    prompt: 'pendente',
    'not-determined': 'não decidida',
    restricted: 'restrita',
    unsupported: 'sem API',
    unavailable: 'indisponível',
    error: 'erro',
  };
  return labels[status] ?? status;
}

export function argsPreview(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return '{ "args": "[unserializable]" }';
  }
}

export async function readMicPermission(): Promise<MicPermissionStatus> {
  if (!navigator.permissions?.query) return 'unsupported';
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state;
  } catch {
    return 'unavailable';
  }
}

export async function readAudioDevices(): Promise<AudioDeviceInfo> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { count: 0, activeLabel: null, error: 'MediaDevices indisponível.' };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput');
    return {
      count: inputs.length,
      activeLabel: inputs.find((device) => device.label)?.label ?? null,
      error: null,
    };
  } catch (err) {
    return {
      count: 0,
      activeLabel: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function StatusPill({
  tone,
  children,
}: {
  tone: string;
  children: ReactNode;
}) {
  return <span className={`settings-chip settings-chip--${tone}`}>{children}</span>;
}

export function MetricTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div className={`ops-metric ops-metric--${tone}`}>
      <span className="ops-metric__label">{label}</span>
      <strong className="ops-metric__value">{value}</strong>
      {detail && <span className="ops-metric__detail">{detail}</span>}
    </div>
  );
}
