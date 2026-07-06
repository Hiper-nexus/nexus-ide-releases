import { ipcMain } from 'electron';
import { TEAM_CHANNELS } from '../shared/channels';
import { apiFetch } from './api-client';

type Envelope = { ok?: boolean; data?: unknown; error?: string } | null;

async function call(path: string, method = 'GET', body?: unknown) {
  const result = await apiFetch(path, {
    method,
    ...(body !== undefined ? { body } : {}),
  });
  const env = result.json as Envelope;
  if (result.status === 401) return { ok: false, error: 'entre na sua conta primeiro' };
  if (result.status === 0) return { ok: false, error: 'sem conexão' };
  if (!env?.ok) return { ok: false, error: env?.error ?? 'erro do servidor' };
  return { ok: true, data: env.data };
}

export function registerTeamIpc(): void {
  ipcMain.handle(TEAM_CHANNELS.get, () => call('/v1/team'));
  ipcMain.handle(TEAM_CHANNELS.join, (_event, code: unknown) =>
    call('/v1/team/join', 'POST', { code: String(code ?? '') }));
  ipcMain.handle(TEAM_CHANNELS.invite, () => call('/v1/team/invites', 'POST'));
  ipcMain.handle(TEAM_CHANNELS.remove, (_event, accountId: unknown) =>
    call(`/v1/team/members/${encodeURIComponent(String(accountId ?? ''))}`, 'DELETE'));
  ipcMain.handle(TEAM_CHANNELS.leave, () => call('/v1/team/leave', 'POST'));
}
