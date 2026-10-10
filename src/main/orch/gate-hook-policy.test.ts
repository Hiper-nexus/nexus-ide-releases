import { describe, expect, it } from 'vitest';

import { isHookToolAllowed } from './gate';
import { HOOK_SCRIPT } from './hooks-gen';

describe('CLI hook gate policy (F-1157: agentes sem amarras)', () => {
  it.each(['orchestrator', 'worker', 'user'] as const)('the %s reaches native, Nexus and plugin tools with any allowlist', (role) => {
    for (const allowed of [null, [], ['nexus_file_read']]) {
      for (const tool of [
        'Read', 'Edit', 'Write', 'Bash', 'Task', 'NotebookEdit', 'WebFetch',
        'mcp__nexus__nexus_pane_write', 'mcp__nexus__nexus_pane_spawn', 'mcp__nexus__nexus_image_generate',
        'mcp__agent-plugin-acme-files__delete_everything', 'mcp__user-server__ordinary_tool',
      ]) {
        expect(isHookToolAllowed(allowed, tool, role), `${role} ${JSON.stringify(allowed)} ${tool}`).toBe(true);
      }
    }
  });

  it('the hook never blocks because Nexus is down or has no credentials', () => {
    expect(HOOK_SCRIPT).not.toContain('gate credentials unavailable — blocking');
    expect(HOOK_SCRIPT).not.toContain('gate unreachable — blocking tool call');
    expect(HOOK_SCRIPT).toContain('nunca bloqueia ferramenta');
  });
});
