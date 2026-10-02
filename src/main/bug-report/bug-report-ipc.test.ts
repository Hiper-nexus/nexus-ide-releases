import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (name: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(name, fn),
}));

import { BUG_REPORT_CHANNELS } from '../../shared/bug-report-channels';
import { createBugReportService, type BugReportServiceDeps } from './bug-report-service';
import { registerBugReportIpc, requestOpenBugReportDialog } from './bug-report-ipc';

const SESSION_TOKEN = `s${'e'}ssao${'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY'.repeat(2)}`;

const validRequest = {
  title: 'O terminal trava ao colar',
  description: 'Ao colar um texto longo o pane congela por alguns segundos.',
  category: 'terminal',
  impact: 'annoying',
  includeDiagnostics: false,
};

function makeService(api: BugReportServiceDeps['api']) {
  return createBugReportService(() => ({
    api,
    now: () => 1,
    redaction: { homeDir: '/Users/ana' },
    diagnostics: {
      appVersion: '0.76.161',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '27.2.0',
      listAgentSessions: () => [],
      readTraceTail: async () => null,
    },
  }));
}

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

describe('registerBugReportIpc', () => {
  beforeEach(() => {
    h.handlers.clear();
  });

  it('registers preview and submit behind the trusted-sender guard', () => {
    registerBugReportIpc(makeService(vi.fn()));
    expect([...h.handlers.keys()].sort()).toEqual(
      [BUG_REPORT_CHANNELS.preview, BUG_REPORT_CHANNELS.submit].sort(),
    );
  });

  it('refuses invalid payloads with a typed failure and never reaches the network', async () => {
    const api = vi.fn();
    registerBugReportIpc(makeService(api));
    for (const bad of [undefined, null, 42, 'oi', {}, { ...validRequest, extra: true }]) {
      expect(await call(BUG_REPORT_CHANNELS.submit, bad)).toMatchObject({ ok: false, code: 'invalid' });
      expect(await call(BUG_REPORT_CHANNELS.preview, bad)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(api).not.toHaveBeenCalled();
  });

  it('returns the exact body for the preview and the report code on success', async () => {
    const api = vi.fn(async () => ({ status: 201, json: { ok: true, data: { id: 'BR-7', status: 'new' } } }));
    registerBugReportIpc(makeService(api));
    const preview = (await call(BUG_REPORT_CHANNELS.preview, validRequest)) as { ok: true; payload: unknown };
    expect(preview.ok).toBe(true);
    expect(await call(BUG_REPORT_CHANNELS.submit, validRequest)).toEqual({ ok: true, id: 'BR-7' });
    const sent = (api.mock.calls[0] as unknown as [string, { body: unknown }])[1].body;
    expect(sent).toEqual(preview.payload);
  });

  it.each([
    [401, null, 'no-session'],
    [413, { ok: false, error: 'too big' }, 'too-large'],
    [429, { ok: false, error: 'Limite de 5 relatos por hora atingido.' }, 'rate-limited'],
    [400, { ok: false, error: 'campo inválido' }, 'rejected'],
  ])('maps HTTP %i to %s', async (status, json, code) => {
    registerBugReportIpc(makeService(vi.fn(async () => ({ status, json }))));
    expect(await call(BUG_REPORT_CHANNELS.submit, validRequest)).toMatchObject({ ok: false, code });
  });

  it('never returns the session token, even if the server or the transport echo it', async () => {
    const echoing = vi.fn(async () => ({
      status: 400,
      json: { ok: false, error: `rejeitado Bearer ${SESSION_TOKEN}` },
    }));
    registerBugReportIpc(makeService(echoing));
    const echoed = await call(BUG_REPORT_CHANNELS.submit, validRequest);
    expect(JSON.stringify(echoed)).not.toContain(SESSION_TOKEN);

    const throwing = vi.fn(async () => {
      throw new Error(`fetch failed (authorization: Bearer ${SESSION_TOKEN})`);
    });
    registerBugReportIpc(makeService(throwing));
    const thrown = await call(BUG_REPORT_CHANNELS.submit, validRequest);
    expect(JSON.stringify(thrown)).not.toContain(SESSION_TOKEN);
  });

  it('turns an unexpected service crash into a generic typed failure', async () => {
    registerBugReportIpc({
      preview: async () => {
        throw new Error(`boom ${SESSION_TOKEN}`);
      },
      submit: async () => {
        throw new Error(`boom ${SESSION_TOKEN}`);
      },
    });
    for (const channel of [BUG_REPORT_CHANNELS.preview, BUG_REPORT_CHANNELS.submit]) {
      const result = await call(channel, validRequest);
      expect(result).toMatchObject({ ok: false, code: 'server' });
      expect(JSON.stringify(result)).not.toContain(SESSION_TOKEN);
    }
  });
});

describe('requestOpenBugReportDialog', () => {
  function fakeWindow(overrides: Record<string, unknown> = {}) {
    return {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      ...overrides,
    };
  }

  it('focuses the window and asks the renderer to open the dialog', () => {
    const win = fakeWindow();
    expect(requestOpenBugReportDialog(win)).toBe(true);
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(BUG_REPORT_CHANNELS.open);
  });

  it('restores a minimized window first', () => {
    const win = fakeWindow({ isMinimized: vi.fn(() => true) });
    requestOpenBugReportDialog(win);
    expect(win.restore).toHaveBeenCalled();
  });

  it('does nothing without a live window', () => {
    expect(requestOpenBugReportDialog(null)).toBe(false);
    expect(requestOpenBugReportDialog(undefined)).toBe(false);
    const destroyed = fakeWindow({ isDestroyed: vi.fn(() => true) });
    expect(requestOpenBugReportDialog(destroyed)).toBe(false);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
    const deadContents = fakeWindow({
      webContents: { isDestroyed: vi.fn(() => true), send: vi.fn() },
    });
    expect(requestOpenBugReportDialog(deadContents)).toBe(false);
  });
});
