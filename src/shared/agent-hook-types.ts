// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: ORCA_HOOK_PROTOCOL_VERSION renamed export alias kept; attribution

// Why: shared agent-hook IPC payload shapes and the managed-script protocol
// version constant. Consumed by both the main-process hook server (src/main/
// agent-hooks/server.ts) and each per-agent hook service. Lives in `shared/`
// to keep a single source of truth for the version string and status contract.

export const AGENT_HOOK_TARGETS = [
  'claude',
  'openclaude',
  'codex',
  'gemini',
  'antigravity',
  'amp',
  'cursor',
  'droid',
  'command-code',
  'grok',
  'copilot',
  'hermes',
  'devin',
  'kimi'
] as const
export type AgentHookTarget = (typeof AGENT_HOOK_TARGETS)[number]

export type AgentHookInstallState = 'installed' | 'not_installed' | 'partial' | 'error'

export type AgentHookInstallStatus = {
  agent: AgentHookTarget
  state: AgentHookInstallState
  configPath: string
  managedHooksPresent: boolean
  detail: string | null
}

// Why: bumped whenever the managed script's request shape changes. The
// receiver logs a warning when it sees a request from a different version so a
// stale script installed by an older app build is diagnosable instead of
// silently producing partial payloads. Still at v1 because the endpoint-file
// rollout is additive — pre-endpoint-file scripts still post the same JSON
// body shape, and no in-wild v1 script exists that a future v2 receiver would
// need to distinguish from: Claude/Codex/Gemini installs run for everyone on
// first launch but no v1 fleet ever shipped, and Cursor's managed script is
// rewritten on every install() call so there is no durable on-disk v1 script
// to inherit. Reserve the next bump for a real wire change.
export const ORCA_HOOK_PROTOCOL_VERSION = '1' as const
