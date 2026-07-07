import { describe, expect, it } from 'vitest';
import { mapActionToTool } from './mcp-bridge';

describe('mcp-bridge action mapping', () => {
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
  });

  it('maps pane actions only when a pane target is available', () => {
    expect(mapActionToTool({ type: 'close_pane' })).toBeNull();
    expect(
      mapActionToTool({ type: 'close_pane' }, { focusedPaneId: 'pane-1' }),
    ).toEqual({
      tool: 'nexus_pane_close',
      args: { paneId: 'pane-1' },
    });
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
});
