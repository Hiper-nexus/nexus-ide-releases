import { describe, expect, it, vi } from 'vitest';
import type {
  RealtimeToolCallEvent,
  TurnManagedRealtimeProvider,
} from '../jarvis/realtime/provider';
import {
  LiveToolCallCoordinator,
  LiveToolCallRegistry,
} from './live-tool-call-registry';
import { JarvisLiveSession } from './jarvis-live';

const call: RealtimeToolCallEvent = {
  callId: 'call-1',
  name: 'nexus_action',
  argumentsJson: '{"action":"open_terminal"}',
  arguments: { action: 'open_terminal' },
};

describe('LiveToolCallRegistry', () => {
  it('dedupes within a Live session but permits a reused id in a new session', () => {
    const registry = new LiveToolCallRegistry();

    expect(registry.claim('session-1', call).accepted).toBe(true);
    expect(registry.complete('session-1', call.callId, { ok: true })).toBe(true);
    expect(registry.claim('session-1', call)).toMatchObject({
      accepted: false,
      record: { status: 'completed' },
    });
    expect(registry.claim('session-2', call).accepted).toBe(true);
  });

  it('carries the original Gemini function name across a provider reconnect', () => {
    const session = new JarvisLiveSession(() => {}, () => 1_000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const sendNamedToolResult = vi.fn();
    const reconnectedProvider = {
      isReady: true,
      sendNamedToolResult,
      sendToolResult: vi.fn(),
    } as unknown as TurnManagedRealtimeProvider;
    const coordinator = new LiveToolCallCoordinator({
      fsm: session,
      getProvider: () => reconnectedProvider,
      onResultContext: vi.fn(),
    });
    const exactCall: RealtimeToolCallEvent = {
      callId: 'call-resumed',
      name: 'nexus_git_status',
      argumentsJson: '{"short":true}',
      arguments: { short: true },
    };

    expect(coordinator.claim(exactCall)).toBe(true);
    expect(
      coordinator.complete({
        sessionId: session.getState().sessionId!,
        at: 1_001,
        source: 'realtime',
        callId: exactCall.callId,
        name: 'nexus_action',
        tool: 'mcp_tool',
        ok: true,
        summary: 'working tree clean',
        output: { clean: true },
      }),
    ).toBe(true);
    expect(sendNamedToolResult).toHaveBeenCalledWith(
      'call-resumed',
      'nexus_git_status',
      expect.objectContaining({ ok: true, summary: 'working tree clean' }),
    );
  });

  it('arms the result lifecycle before a synchronous provider completion can fire', () => {
    const session = new JarvisLiveSession(() => {}, () => 1_000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const order: string[] = [];
    const provider = {
      isReady: true,
      sendNamedToolResult: vi.fn(() => order.push('sent')),
      sendToolResult: vi.fn(),
    } as unknown as TurnManagedRealtimeProvider;
    const coordinator = new LiveToolCallCoordinator({
      fsm: session,
      getProvider: () => provider,
      onResultContext: vi.fn(),
      onResultSending: () => order.push('armed'),
    });

    expect(coordinator.claim(call)).toBe(true);
    expect(
      coordinator.complete({
        sessionId: session.getState().sessionId!,
        at: 1_001,
        source: 'realtime',
        callId: call.callId,
        name: call.name,
        tool: 'open_terminal',
        ok: true,
        summary: 'terminal aberto',
      }),
    ).toBe(true);
    expect(order).toEqual(['armed', 'sent']);
  });
});
