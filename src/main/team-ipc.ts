import { LicenseError, licenseFailure } from '../shared/license-errors';
import { TEAM_CHANNELS } from '../shared/channels';
import { apiFetch } from './api-client';
import { handleTrusted } from './security/trusted-ipc';

type Envelope = { ok?: boolean; data?: unknown; error?: string } | null;

async function call(path: string, method = 'GET', body?: unknown) {
  const result = await apiFetch(path, {
    method,
    ...(body !== undefined ? { body } : {}),
  });
  if (result.status === 403) return licenseFailure(new LicenseError('license_access_denied', 'server-denied'))!;
  const env = result.json as Envelope;
  if (result.status === 401) return { ok: false, error: 'Sua sessão Nexus expirou — saia e entre de novo na conta' };
  if (result.status === 0) return { ok: false, error: 'sem conexão' };
  if (!env?.ok) return { ok: false, error: env?.error ?? 'erro do servidor' };
  return { ok: true, data: env.data };
}

export function registerTeamIpc(): void {
  handleTrusted(TEAM_CHANNELS.get, () => call('/v1/team'));
  handleTrusted(TEAM_CHANNELS.join, (_event, code: unknown) =>
    call('/v1/team/join', 'POST', { code: String(code ?? '') }));
  handleTrusted(TEAM_CHANNELS.invite, () => call('/v1/team/invites', 'POST'));
  handleTrusted(TEAM_CHANNELS.remove, (_event, accountId: unknown) =>
    call(`/v1/team/members/${encodeURIComponent(String(accountId ?? ''))}`, 'DELETE'));
  handleTrusted(TEAM_CHANNELS.leave, () => call('/v1/team/leave', 'POST'));
}
