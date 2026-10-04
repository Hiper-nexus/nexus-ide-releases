import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSoakActivity } from './soak-smoke';
const nonce = '11111111-1111-4111-8111-111111111111';
function fixture() {
  let data: (text: string) => void = () => {};
  const api = { workspace: { get: async () => ({ current: { path: '/private/workspace' } }) },
    files: { read: async () => ({ ok: true, content: 'nexus-functional-smoke\n' }) }, product: { searchQuery: async () => ({ results: [] }) },
    pty: { onData: (_id: string, cb: (text: string) => void) => { data = cb; return vi.fn(); },
      writeConfirmed: vi.fn(async (_id: string, text: string) => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-soak-shell-unit-'));
        try {
          const output = execFileSync('/bin/sh', ['-c', text.replace(/\r$/u, '')], { cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 1000, encoding: 'utf8' });
          expect(text).not.toContain(`SOAK_${nonce}_0_DONE`);
          expect(output.split('\n').length).toBeGreaterThan(96);
          data(text); data(output); return true;
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
      }), resize: vi.fn() } };
  const ui = { open: vi.fn(async () => ({ paneId: 'pane-fixture', sessionId: 'pty-fixture' })),
    view: vi.fn(async () => ({ frames: 2, renderedMarker: true, scroll: true, resize: true, rendererHosts: 1 })), close: vi.fn(async () => {}) };
  const controller = new AbortController(), sendCycle = vi.fn(async () => true), stopped = vi.fn(async () => {});
  const options = { ui, signal: controller.signal, sendCycle, stopped, heap: () => 32000, rendererPid: 1234, electronVersion: '43.7.4',
    finalFunctional: vi.fn(async () => ({ ok: true as const })), done: vi.fn(async () => {}) };
  return { api, ui, controller, options };
}
it('executes confirmed PTY output and UI activity, closes UI then checks final functionality', async () => {
  const f = fixture();
  await runSoakActivity(f.api as never, { nonce, workspacePath: '/private/workspace' }, f.options as never);
  expect(f.options.sendCycle).toHaveBeenCalledOnce();
  expect(f.options.sendCycle.mock.calls[0]).toBeDefined();
  expect(f.ui.close).toHaveBeenCalledExactlyOnceWith('pane-fixture');
  expect(f.ui.close.mock.invocationCallOrder[0]).toBeLessThan(f.options.finalFunctional.mock.invocationCallOrder[0]!);
  expect(f.options.done).toHaveBeenCalledOnce();
});
it('refused write cleans its pane and retains its session for Main physical stop', async () => {
  const f = fixture(); f.api.pty.writeConfirmed.mockResolvedValue(false);
  await expect(runSoakActivity(f.api as never, { nonce, workspacePath: '/private/workspace' }, f.options as never)).rejects.toThrow();
  expect(f.options.sendCycle).not.toHaveBeenCalled();
  expect(f.ui.close).toHaveBeenCalledOnce();
  expect(f.options.stopped).toHaveBeenCalledWith(['pty-fixture']);
});
it('cancel while UI spawn awaits drains that same flight without late writes or success', async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ui.open.mockImplementationOnce(async () => { await gate; return { paneId: 'pane-fixture', sessionId: 'pty-fixture' }; });
  const run = runSoakActivity(f.api as never, { nonce, workspacePath: '/private/workspace' }, f.options as never);
  const result = run.catch(error => error); let finished = false; void result.then(() => { finished = true; });
  await vi.waitFor(() => expect(f.ui.open).toHaveBeenCalled()); f.controller.abort();
  await Promise.resolve(); expect(finished).toBe(false); release(); expect(await result).toBeInstanceOf(Error);
  expect(f.api.pty.writeConfirmed).not.toHaveBeenCalled(); expect(f.ui.close).toHaveBeenCalledOnce();
  expect(f.options.stopped).toHaveBeenCalledWith(['pty-fixture']); expect(f.options.done).not.toHaveBeenCalled();
});
it('rejects unavailable renderer heap instead of manufacturing a zero sample', async () => {
  const f = fixture(); f.options.heap = () => 0;
  await expect(runSoakActivity(f.api as never, { nonce, workspacePath: '/private/workspace' }, f.options as never)).rejects.toThrow();
  expect(f.options.sendCycle).not.toHaveBeenCalled(); expect(f.options.done).not.toHaveBeenCalled();
});
