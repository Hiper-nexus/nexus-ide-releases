import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invokeActionViaMcp,
  invokeMcpWithConfirm,
  mapActionToTool,
} from './mcp-bridge';

type McpMocks = {
  invoke: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  clearSession: ReturnType<typeof vi.fn>;
};

describe('mcp-bridge action mapping', () => {
  let mcp: McpMocks;

  beforeEach(() => {
    mcp = {
      invoke: vi.fn(),
      confirm: vi.fn(),
      clearSession: vi.fn(),
    };
    (globalThis as unknown as { window: { nexus: { mcp: McpMocks } } }).window = {
      nexus: {
        mcp,
      },
    };
  });

  it('keeps open_terminal on the renderer UI shell path', () => {
    expect(mapActionToTool({ type: 'open_terminal' })).toBeNull();
  });

  it('keeps local UI actions on the renderer UI path', () => {
    expect(mapActionToTool({ type: 'open_settings' })).toBeNull();
    expect(mapActionToTool({ type: 'open_voice_settings' })).toBeNull();
    expect(mapActionToTool({ type: 'open_canvas' })).toBeNull();
    expect(mapActionToTool({ type: 'open_grid' })).toBeNull();
    expect(mapActionToTool({ type: 'open_browser' })).toBeNull();
    expect(mapActionToTool({ type: 'browser_reload' })).toBeNull();
    expect(mapActionToTool({ type: 'focus_next_pane' })).toBeNull();
    expect(mapActionToTool({ type: 'focus_previous_pane' })).toBeNull();
    expect(mapActionToTool({ type: 'focus_pane', paneName: 'terminal' })).toBeNull();
    expect(mapActionToTool({ type: 'close_pane' })).toBeNull();
  });

  it('maps explicit MCP tool calls without changing the args', () => {
    expect(
      mapActionToTool({
        type: 'mcp_tool',
        tool: 'nexus_git_status',
        args: { cwd: '/tmp/project' },
      }),
    ).toEqual({
      tool: 'nexus_git_status',
      args: { cwd: '/tmp/project' },
    });
  });

  it('send_to_pane returns null so it reaches the C3 voice-confirm gate, not the MCP path', () => {
    // C3: send_to_pane must never dispatch via executeViaMcp. It must reach the
    // voice-confirmation gate in jarvis-action-executor, which enforces
    // agent-pane-only writes. Returning null keeps that gate reachable.
    expect(
      mapActionToTool(
        { type: 'send_to_pane', text: 'Fix the pixel movement bug.' },
        { focusedPaneId: 'pane-focused', orchestratorPaneId: 'pane-orch' },
      ),
    ).toBeNull();
  });

  it('send_to_pane returns null even with only focused pane context', () => {
    expect(
      mapActionToTool(
        { type: 'send_to_pane', text: 'Run the focused agent review.' },
        { focusedPaneId: 'pane-focused', orchestratorPaneId: null },
      ),
    ).toBeNull();
  });

  it('send_to_pane returns null when no pane context exists', () => {
    expect(
      mapActionToTool(
        { type: 'send_to_pane', text: 'Do not drop this into nowhere.' },
        { focusedPaneId: null, orchestratorPaneId: null },
      ),
    ).toBeNull();
  });

  it('routes shell commands through the audited terminal MCP tool', () => {
    expect(
      mapActionToTool({ type: 'run_command', command: 'npm test -- --run' }),
    ).toEqual({
      tool: 'nexus_terminal_run',
      args: { command: 'npm test -- --run' },
    });
  });

  it('confirms denied MCP calls and retries after native approval', async () => {
    mcp.invoke
      .mockResolvedValueOnce({
        ok: false,
        tool: 'nexus_terminal_run',
        denied: true,
        requiredConfirmation: true,
        error: 'confirmation_required',
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: 'nexus_terminal_run',
        output: { exitCode: 0 },
      });
    mcp.confirm.mockResolvedValueOnce({ ok: true });

    const result = await invokeMcpWithConfirm('nexus_terminal_run', {
      command: 'npm run typecheck',
    });

    expect(result.ok).toBe(true);
    expect(mcp.invoke).toHaveBeenCalledTimes(2);
    expect(mcp.confirm).toHaveBeenCalledWith('nexus_terminal_run', {
      command: 'npm run typecheck',
    });
  });

  it('returns user_denied without retrying when native confirmation is refused', async () => {
    mcp.invoke.mockResolvedValueOnce({
      ok: false,
      tool: 'nexus_terminal_run',
      denied: true,
      requiredConfirmation: true,
      error: 'confirmation_required',
    });
    mcp.confirm.mockResolvedValueOnce({ ok: false });

    const result = await invokeActionViaMcp({
      type: 'run_command',
      command: 'npm run typecheck',
    });

    expect(result).toEqual({
      ok: false,
      tool: 'nexus_terminal_run',
      error: 'user_denied',
    });
    expect(mcp.invoke).toHaveBeenCalledTimes(1);
  });
});
