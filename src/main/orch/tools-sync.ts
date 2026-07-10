import { inspectSyncRuntime } from '../context/sync-runtime';
import type { McpToolDef } from './mcp-protocol';

const syncStatusTool: McpToolDef = {
  name: 'nexus_sync_status',
  description:
    'Read the authenticated multi-PC metadata sync status for this exact project. Returns only server reachability, revision, and entity counts; never payloads, paths, credentials, publish, or CAS authority.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => inspectSyncRuntime(ctx.scope),
};

export function buildSyncTools(): McpToolDef[] {
  return [syncStatusTool];
}
