import { describe, expect, it } from 'vitest';

import { isHookToolAllowed } from './gate';
import { HOOK_SCRIPT } from './hooks-gen';

describe('CLI hook gate policy', () => {
  it('applies Nexus allowlists to MCP calls without disabling native coding tools', () => {
    expect(isHookToolAllowed([], 'Read')).toBe(true);
    expect(isHookToolAllowed([], 'Edit')).toBe(true);
    expect(isHookToolAllowed([], 'Bash')).toBe(true);
    expect(isHookToolAllowed([], 'mcp__nexus__nexus_pane_read')).toBe(false);
    expect(
      isHookToolAllowed(
        ['nexus_pane_read'],
        'mcp__nexus__nexus_pane_read',
      ),
    ).toBe(true);
  });

  it('keeps Agent Plugins MCP tools behind an exact main-owned grant', () => {
    const pluginTool = 'mcp__agent-plugin-acme-files__delete_everything';

    expect(isHookToolAllowed([], pluginTool)).toBe(false);
    expect(isHookToolAllowed(['nexus_file_read'], pluginTool)).toBe(false);
    expect(isHookToolAllowed([pluginTool], pluginTool)).toBe(true);
    expect(isHookToolAllowed(null, pluginTool)).toBe(true);
    expect(isHookToolAllowed([], 'mcp__user-server__ordinary_tool')).toBe(true);
  });

  it('keeps an orchestrator in coordination-only authority', () => {
    expect(isHookToolAllowed(null, 'Read', 'orchestrator')).toBe(true);
    expect(isHookToolAllowed(null, 'Bash', 'orchestrator')).toBe(false);
    expect(isHookToolAllowed(null, 'Edit', 'orchestrator')).toBe(false);
    expect(isHookToolAllowed(null, 'Write', 'orchestrator')).toBe(false);
    expect(
      isHookToolAllowed(null, 'mcp__nexus__nexus_image_generate', 'orchestrator'),
    ).toBe(false);
    expect(
      isHookToolAllowed(null, 'mcp__nexus__nexus_pane_spawn', 'orchestrator'),
    ).toBe(true);
    expect(isHookToolAllowed(null, 'Bash', 'worker')).toBe(true);
  });

  it('fails closed when the gate or hook input is unavailable', () => {
    expect(HOOK_SCRIPT).toContain('gate credentials unavailable — blocking');
    expect(HOOK_SCRIPT).toContain('gate unreachable — blocking tool call');
    expect(HOOK_SCRIPT).not.toContain('fail open');
  });
});
