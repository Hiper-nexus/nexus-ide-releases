import { describe, expect, it } from 'vitest';
import type { McpHubSyncApplyInput } from './mcp-hub-sync-api';
import type { ProductApi } from './product-api';
import type { NexusApi } from './types';

describe('mcp-hub-sync-api', () => {
  it('aceita exportTools opt-in no contrato IPC', () => {
    const input: McpHubSyncApplyInput = {
      dryRun: true,
      mode: 'export',
      exportTools: ['cursor', 'cline'],
    };
    expect(input.exportTools).toHaveLength(2);
  });

  it('NexusApi.product tipa exportTools via ProductApi (sem cast)', () => {
    type Apply = NexusApi['product']['mcpHubSyncApply'];
    type ViaProduct = ProductApi['mcpHubSyncApply'];
    const sample: Parameters<Apply>[0] = {
      dryRun: true,
      exportTools: ['opencode'],
    };
    const same: Parameters<ViaProduct>[0] = sample;
    expect(same?.exportTools).toEqual(['opencode']);
  });

  it('exporta a lista canônica de tools (single source)', async () => {
    const { MCP_HUB_SYNC_EXPORT_TOOLS } = await import('./mcp-hub-sync-api');
    expect([...MCP_HUB_SYNC_EXPORT_TOOLS]).toEqual([
      'cursor',
      'claude-code',
      'codex',
      'opencode',
      'cline',
    ]);
  });
});
