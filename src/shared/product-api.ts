/**
 * Product-wave surface (flags, memory, skills, MCP hub, autonomy, editor).
 * Wired as NexusApi.product in types.ts (mcpHubSyncApply uses McpHubSyncApplyInput).
 */
import type { McpHubSyncApplyInput } from './mcp-hub-sync-api';

export interface ProductApi {
  flagsList(): Promise<
    Array<{
      id: string;
      enabled: boolean;
      reason: string;
      definition: unknown;
    }>
  >;
  memoryList(): Promise<unknown[]>;
  memoryRemember(input: {
    title: string;
    body: string;
    kind?: 'decision' | 'mission' | 'agent' | 'note';
    missionId?: string;
  }): Promise<unknown>;
  memorySearch(query: string): Promise<unknown[]>;
  memoryBacklinks(title: string): Promise<unknown[]>;
  memoryComplete(prefix: string): Promise<string[]>;
  skillsList(): Promise<unknown[]>;
  skillsLockRead(): Promise<unknown>;
  skillsLockWrite(lock: unknown): Promise<{ ok: boolean; path?: string }>;
  mcpHubLoad(): Promise<unknown>;
  mcpHubSave(input: { config: unknown; dryRun?: boolean }): Promise<unknown>;
  mcpHubDrift(observed: unknown): Promise<unknown>;
  mcpHubHealth(): Promise<unknown[]>;
  mcpHubRollback(input: { backupPath: string }): Promise<unknown>;
  /** Read-only Across Tools matrix from disk probes (+ hub ids). */
  mcpHubObserve(): Promise<unknown>;
  mcpHubSyncPlan(): Promise<unknown>;
  mcpHubSyncApply(input?: McpHubSyncApplyInput): Promise<unknown>;
  autonomyDecide(input: unknown): Promise<unknown>;
  searchQuery(input: { text: string; limit?: number }): Promise<unknown>;
  editorOpen(relativePath: string): Promise<unknown>;
  editorApply(input: {
    path: string;
    content: string;
    write?: boolean;
    expectedContentHash?: string;
  }): Promise<unknown>;
}
