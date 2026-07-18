import { describe, expect, it } from 'vitest';
import {
  OMP_HOST_TOOL_NAMES,
  buildOmpHostToolDefinitions,
} from './omp-rpc-ipc';
import type { McpRegistry } from '../orch/mcp-protocol';

describe('OMP host tools', () => {
  it('exports a curated worker surface larger than the original three tools', () => {
    expect(OMP_HOST_TOOL_NAMES.length).toBeGreaterThanOrEqual(10);
    expect(OMP_HOST_TOOL_NAMES).toContain('nexus_mission_get');
    expect(OMP_HOST_TOOL_NAMES).toContain('nexus_handoff_submit');
    expect(OMP_HOST_TOOL_NAMES).toContain('nexus_file_read');
    expect(OMP_HOST_TOOL_NAMES).toContain('nexus_git_status');
  });

  it('builds definitions only for tools present in the registry', () => {
    const registry: McpRegistry = {
      serverName: 'test',
      serverVersion: '0',
      tools: [
        {
          name: 'nexus_mission_get',
          description: 'get mission',
          inputSchema: { type: 'object' },
          handler: async () => ({}),
        },
        {
          name: 'nexus_file_read',
          description: 'read file',
          inputSchema: { type: 'object' },
          handler: async () => ({}),
        },
        {
          name: 'nexus_unrelated',
          description: 'skip',
          inputSchema: { type: 'object' },
          handler: async () => ({}),
        },
      ],
    };
    const defs = buildOmpHostToolDefinitions(registry);
    expect(defs.map((d) => d.name).sort()).toEqual([
      'nexus_file_read',
      'nexus_mission_get',
    ]);
  });
});
