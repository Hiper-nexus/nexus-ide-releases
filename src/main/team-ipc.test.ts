import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), api: vi.fn() }));
vi.mock('./api-client', () => ({ apiFetch: h.api }));
vi.mock('./security/trusted-ipc', () => ({ handleTrusted: (name: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(name, fn) }));
import { registerTeamIpc } from './team-ipc';
import { TEAM_CHANNELS } from '../shared/channels';
describe('team license denial', () => {
  it('returns a typed license error on 403 without retry or offline fallback', async () => {
    h.api.mockResolvedValue({ status: 403, json: { ok: false, error: 'not entitled' } });
    registerTeamIpc();
    expect(await h.handlers.get(TEAM_CHANNELS.get)?.()).toMatchObject({ ok: false, code: 'license_access_denied' });
    expect(h.api).toHaveBeenCalledOnce();
  });
});
