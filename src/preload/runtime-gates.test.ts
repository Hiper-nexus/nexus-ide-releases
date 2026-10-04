import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { installRuntimeGatePreload } from './runtime-gates';
import { RUNTIME_CHANNELS } from '../shared/runtime-gates';
it('does not execute product APIs for incomplete/foreign private instructions', () => {
  const api = { mission: { prepare: vi.fn() } }, ipc = Object.assign(new EventEmitter(), { invoke: vi.fn(), send: vi.fn() });
  installRuntimeGatePreload(ipc as never, api as never, { isMainFrame: true });
  for (const raw of [null, {}, { nonce: 'old', phase: 'exercise', workspacePath: '/private' },
    { nonce: '11111111-1111-4111-8111-111111111111', phase: 'unknown', workspacePath: '/private' }]) ipc.emit(RUNTIME_CHANNELS.run, null, raw);
  expect(api.mission.prepare).not.toHaveBeenCalled(); expect(ipc.invoke).not.toHaveBeenCalled(); expect(ipc.send).not.toHaveBeenCalled();
});
it('does not install the private driver in a subframe', () => {
  const ipc = { on: vi.fn() }; installRuntimeGatePreload(ipc as never, {} as never, { isMainFrame: false }); expect(ipc.on).not.toHaveBeenCalled();
});
