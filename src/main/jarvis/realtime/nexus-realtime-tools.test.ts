import { describe, expect, it } from 'vitest';
import {
  createNexusRealtimeTools,
  realtimeArgsToJarvisAction,
  summarizeNexusRealtimeAction,
} from './nexus-realtime-tools';

describe('nexus realtime tools', () => {
  it('exposes app-wide audited actions to the realtime model', () => {
    const [tool] = createNexusRealtimeTools();
    const params = tool.parameters as {
      properties: { action: { enum: string[] } };
    };

    expect(params.properties.action.enum).toEqual(
      expect.arrayContaining([
        'open_terminal',
        'send_to_pane',
        'run_command',
        'mcp_tool',
      ]),
    );
  });

  it('maps MCP tool calls into the shared Jarvis action executor contract', () => {
    expect(
      realtimeArgsToJarvisAction({
        action: 'mcp_tool',
        tool: 'nexus_file_read',
        args: { path: 'package.json' },
      }),
    ).toEqual({
      type: 'mcp_tool',
      tool: 'nexus_file_read',
      args: { path: 'package.json' },
    });
  });

  it('rejects non-Nexus realtime MCP tool names', () => {
    expect(
      realtimeArgsToJarvisAction({
        action: 'mcp_tool',
        tool: 'shell_exec',
        args: { command: 'rm -rf .' },
      }),
    ).toBeNull();
  });

  it('maps delegated prompts and shell commands without bypassing execution safety', () => {
    expect(
      realtimeArgsToJarvisAction({
        action: 'send_to_pane',
        text: 'Fix the login bug. Acceptance: tests pass.',
      }),
    ).toEqual({
      type: 'send_to_pane',
      text: 'Fix the login bug. Acceptance: tests pass.',
    });
    expect(
      realtimeArgsToJarvisAction({
        action: 'run_command',
        command: 'npm test -- --run',
      }),
    ).toEqual({
      type: 'run_command',
      command: 'npm test -- --run',
    });
  });

  it('summarizes full app actions for live diagnostics', () => {
    expect(
      summarizeNexusRealtimeAction({
        action: 'mcp_tool',
        tool: 'nexus_git_status',
        args: {},
      }),
    ).toBe('executar tool nexus_git_status');
    expect(
      summarizeNexusRealtimeAction({
        action: 'open_workspace',
        workspaceName: 'nexus',
      }),
    ).toBe('abrir workspace nexus');
  });
});
