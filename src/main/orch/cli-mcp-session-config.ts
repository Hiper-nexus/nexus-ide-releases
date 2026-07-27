/**
 * Stable public facade for per-session CLI/MCP configuration.
 *
 * Provider strategies own their native configuration details. Artifact
 * activation, auth sync-back, stale purge and cleanup remain centralized in
 * cli-mcp-session-artifacts.
 */
export {
  cleanupCliMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-artifacts';
export { prepareCodexGovernedSession } from './cli-mcp-session-codex';
export { prepareGrokMcpSession } from './cli-mcp-session-grok';
export { prepareKimiMcpSession } from './cli-mcp-session-kimi';
export { prepareOpenCodeMcpSession } from './cli-mcp-session-opencode';
export type {
  CliMcpPurgeOptions,
  CliMcpSessionOptions,
  CliMcpSessionResult,
  CodexGovernedProcessSandbox,
} from './cli-mcp-session-types';
