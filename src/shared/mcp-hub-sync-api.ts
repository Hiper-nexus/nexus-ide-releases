/**
 * MCP Hub sync IPC contracts — kept out of the types.ts monolith (Akita).
 * ProductApi.mcpHubSyncApply(input?: McpHubSyncApplyInput) is the NexusApi path.
 */

export const MCP_HUB_SYNC_EXPORT_TOOLS = [
  'cursor',
  'claude-code',
  'codex',
  'opencode',
  'cline',
] as const;

export type McpHubSyncExportToolId =
  (typeof MCP_HUB_SYNC_EXPORT_TOOLS)[number];

export interface McpHubSyncApplyInput {
  readonly dryRun?: boolean;
  readonly mode?: 'both' | 'import' | 'export';
  /** Opt-in: which tools receive fill-gaps export (omit = all). */
  readonly exportTools?: readonly McpHubSyncExportToolId[];
}

/** Zod-compatible non-empty tuple for ipcMain.parse. */
export const MCP_HUB_SYNC_EXPORT_TOOL_ENUM = MCP_HUB_SYNC_EXPORT_TOOLS as unknown as [
  McpHubSyncExportToolId,
  ...McpHubSyncExportToolId[],
];
