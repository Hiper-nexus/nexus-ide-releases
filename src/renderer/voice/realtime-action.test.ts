import { describe, expect, it } from 'vitest';
import type { JarvisLiveToolEvent } from '../../shared/voice-ipc';
import { realtimeToolEventToJarvisAction } from './realtime-action';

function event(args: Record<string, unknown>): JarvisLiveToolEvent {
  return {
    sessionId: 'session-1',
    source: 'realtime',
    callId: 'call-1',
    name: 'nexus_action',
    tool: 'none',
    summary: 'test',
    args,
    at: 1000,
  };
}

describe('realtimeToolEventToJarvisAction', () => {
  it('maps full app MCP tool calls from realtime into Jarvis actions', () => {
    expect(
      realtimeToolEventToJarvisAction(
        event({
          action: 'mcp_tool',
          tool: 'nexus_git_status',
          args: {},
        }),
      ),
    ).toEqual({
      type: 'mcp_tool',
      tool: 'nexus_git_status',
      args: {},
    });
  });

  it('rejects unsupported realtime tools and invalid MCP names', () => {
    expect(
      realtimeToolEventToJarvisAction({
        ...event({ action: 'open_terminal' }),
        name: 'external_tool',
      }),
    ).toBeNull();
    expect(
      realtimeToolEventToJarvisAction(
        event({
          action: 'mcp_tool',
          tool: 'terminal_run',
          args: {},
        }),
      ),
    ).toBeNull();
  });

  it('maps action arguments required by the existing executor', () => {
    expect(
      realtimeToolEventToJarvisAction(
        event({ action: 'open_workspace', workspaceName: 'cashback' }),
      ),
    ).toEqual({ type: 'open_workspace', workspaceName: 'cashback' });
    expect(
      realtimeToolEventToJarvisAction(
        event({ action: 'send_to_pane', text: 'Build the pixel game movement.' }),
      ),
    ).toEqual({ type: 'send_to_pane', text: 'Build the pixel game movement.' });
    // NEW-B: a routed pending-question answer threads the ASKING paneId through.
    expect(
      realtimeToolEventToJarvisAction(
        event({ action: 'send_to_pane', text: 'usa o Postgres', paneId: 'pane-42' }),
      ),
    ).toEqual({ type: 'send_to_pane', text: 'usa o Postgres', paneId: 'pane-42' });
    expect(
      realtimeToolEventToJarvisAction(
        event({ action: 'run_command', command: 'npm run typecheck' }),
      ),
    ).toEqual({ type: 'run_command', command: 'npm run typecheck' });
    expect(
      realtimeToolEventToJarvisAction(
        event({ action: 'focus_pane', paneName: 'terminal' }),
      ),
    ).toEqual({ type: 'focus_pane', paneName: 'terminal' });
    expect(
      realtimeToolEventToJarvisAction(event({ action: 'focus_previous_pane' })),
    ).toEqual({ type: 'focus_previous_pane' });
  });
});
