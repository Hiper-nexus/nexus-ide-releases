import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installMimoStatusHook, mimoStatusHookSource } from './mimo-hook-source';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('forwards only session identity and status to the real loopback hook endpoint using env secrets', async () => {
  vi.stubEnv('NEXUS_AGENT_HOOK_PORT', '9123'); vi.stubEnv('NEXUS_AGENT_HOOK_TOKEN', 'a'.repeat(48)); vi.stubEnv('NEXUS_PANE_KEY', 'pty-a');
  vi.stubEnv('NEXUS_MIMO_HOOK_TOKEN', 'b'.repeat(64));
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<{ ok: boolean }>>(async () => ({ ok: true })); vi.stubGlobal('fetch', fetch);
  const source = mimoStatusHookSource();
  expect(source).not.toContain('a'.repeat(48)); expect(source).not.toContain('pty-a');
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  await module.default['chat.message']({ sessionID: 'ses-a', text: 'private prompt' });
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:9123/hook/mimo-code', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ paneKey: 'pty-a', agentType: 'mimo-code', state: 'working', providerSession: { key: 'session_id', id: 'ses-a' } }),
  }));
  await module.default.event({ event: { type: 'session.status', properties: { sessionID: 'ses-a', status: { type: 'idle' } } } });
  expect(JSON.parse(String(fetch.mock.calls[1]![1].body)).state).toBe('done');
  expect(JSON.stringify(fetch.mock.calls)).not.toContain('private prompt');
});

it('installs in a private extra directory and preserves custom direct-user hooks without writing them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-hooks-')); roots.push(root);
  const custom = path.join(root, 'native'); fs.mkdirSync(path.join(custom, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(custom, 'hooks', 'operator.js'), 'export default {}');
  fs.writeFileSync(path.join(custom, 'mimocode.json'), '{"theme":"custom"}');
  const config = installMimoStatusHook(path.join(root, 'artifact'), false, custom);
  expect(config).not.toBe(custom);
  expect(fs.readFileSync(path.join(config, 'mimocode.json'), 'utf8')).toContain('custom');
  expect(fs.readdirSync(path.join(custom, 'hooks'))).toEqual(['operator.js']);
  const governed = installMimoStatusHook(path.join(root, 'governed'), true, custom);
  expect(fs.existsSync(path.join(governed, 'mimocode.json'))).toBe(false);
  expect(fs.readdirSync(path.join(governed, 'hooks'))).toEqual(['__nexus_status.js']);
});
