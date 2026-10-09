// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { installRuntimeGatePreload } from './runtime-gates';
import { RUNTIME_CHANNELS } from '../shared/runtime-gates';
import { isToolAllowedForRole } from '../main/orch/gate';
it('the private frozen chief can register a question and declare its normal blocked status', async () => {
  const ipc = Object.assign(new EventEmitter(), { invoke: vi.fn(), send: (channel: string, value: unknown) => ipc.emit(channel, value) });
  let statusAllowed = false;
  const api = { mission: { prepare: async (review: { roster: { category: string; allowedTools: string[] }[] }) => {
    const chief = review.roster.find(agent => agent.category === 'orchestrator')!;
    statusAllowed = isToolAllowedForRole('orchestrator', chief.allowedTools, 'nexus_mission_set_status');
    expect(isToolAllowedForRole('orchestrator', chief.allowedTools, 'nexus_clarify')).toBe(true);
    expect(isToolAllowedForRole('orchestrator', chief.allowedTools, 'nexus_catalog_install')).toBe(false);
    throw new Error('private test preparation ended');
  } } };
  const ended = new Promise<void>(resolve => ipc.once(RUNTIME_CHANNELS.result, () => resolve()));
  installRuntimeGatePreload(ipc as never, api as never, { isMainFrame: true });
  ipc.emit(RUNTIME_CHANNELS.run, null, { nonce: '11111111-1111-4111-8111-111111111111', gatewayNonce: '22222222-2222-4222-8222-222222222222', phase: 'exercise', workspacePath: '/private/runtime-fixture' });
  await ended;
  expect(statusAllowed).toBe(true);
});
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
