# Nexus IDE — Fase 4: MCP Map (Jarvis as Agent)

## 1. How `tools-panes.ts` works (MCP tool declaration pattern)

**Location:** `src/main/orch/tools-panes.ts`

**Pattern:** Each tool is a `McpToolDef` object with 4 fields:
```ts
{
  name: 'nexus_pane_spawn',        // canonical name with nexus_ prefix
  description: '...',              // English-only, detailed
  inputSchema: { type: 'object', properties: {...}, required: [...] },  // JSON Schema
  handler: async (args, ctx) => { ... }  // args = Record<string,unknown>, ctx = AgentGateContext
}
```

Tools are collected via `buildPaneTools()` and merged in `tools.ts` into `buildToolset()`:
```ts
export function buildToolset(): McpToolDef[] {
  return [...buildPaneTools(), ...buildDomainTools(), ...buildMediaTools()];
}
```

**10 existing pane tools:** `nexus_pane_spawn`, `nexus_pane_list`, `nexus_pane_list_providers`, `nexus_pane_read`, `nexus_pane_read_many`, `nexus_pane_write`, `nexus_pane_write_many`, `nexus_pane_close`, `nexus_pane_wait_idle`, `nexus_pane_wait_many`

**Helper utilities** (`tool-util.ts`): `str()`, `num()`, `requireStr()`, `strArray()`, `authorizePaneRef()`, `authorizedSessionIdOf()`, `injectPrompt()`, `spawnPaneAndMaybePrompt()`

**MCP Protocol** (`mcp-protocol.ts`): Pure JSON-RPC 2.0 handler — `initialize`, `ping`, `tools/list`, `tools/call`. Tool results are serialized as `{content: [{type: 'text', text: JSON.stringify(result)}]}`. Errors are `isError: true` results (not protocol errors).

**MCP Server** (`mcp-server.ts`): Embedded HTTP server on `127.0.0.1:random`, each agent gets a bearer token. Gate endpoints at `/gate/pretool`, `/gate/posttool`, `/gate/stop`. Legacy handoff parser for non-MCP agents.

## 2. Where the Jarvis renderer switch executes actions today

**Location:** `src/renderer/voice/voice-controller.ts`, function `executeAction()` (lines ~775-955)

The switch dispatches based on `reply.action.type` (type `JarvisAction` from `src/shared/voice-ipc.ts`):

| Action Type | What it does | Where |
|---|---|---|
| `none` | No action | line 776 |
| `open_squad` | Launch a squad mission | line 779 |
| `open_workspace` | Switch workspace | line 814 |
| `design_squad` | Analyze workspace for squad | line 835 |
| `new_mission` | Open mission wizard | line 862 |
| `open_terminal` | Add shell pane | line 866 |
| `close_pane` | Close focused pane | line 877 |
| `open_board` | Toggle mission board | line 890 |
| `send_to_pane` | Send text to focused/orchestrator pane | line 895 |
| `run_command` | Execute shell command (with native confirmation) | line 910 |

All actions are renderer-side only — they call Zustand store methods directly (`useLayoutStore`, `useWorkspaceStore`, `useOrchStore`, etc.) or use `writeToPane()` from `terminal-host.ts`.

## 3. What actions Jarvis already knows

10 action types defined in `JarvisAction` union type (`src/shared/voice-ipc.ts:209`):
- `none`, `open_squad`, `open_workspace`, `design_squad`, `new_mission`, `open_terminal`, `close_pane`, `open_board`, `send_to_pane`, `run_command`

These are decided by the Jarvis brain (LLM) in `src/main/voice/jarvis-live.ts` or the fast-path classifier.

## 4. IPC between renderer ↔ main for actions

**Current IPC for Jarvis:**
- `voice:jarvis` — renderer sends `JarvisRequest` to main, main returns `JarvisReply` (with action)
- `voice:speak` — TTS invocation
- `voice:confirmCommand` — native dialog for `run_command` approval
- `voice:liveToolResult` — report tool result back to live session

**Orch IPC** (`orch-ipc.ts`): `ipcMain.handle()` for `orch:missionsList`, `orch:squadDesign`, `orch:mcpInfo`, etc.

**Key insight:** The Jarvis does NOT use the MCP server at all. It calls renderer state directly. The MCP server is only used by CLI agents (Claude Code, Codex, AGY) running inside PTY panes.

## 5. New tools to add

Following the existing `McpToolDef` pattern, 4 new files:

1. **`tools-files.ts`** — `nexus_file_open`, `nexus_file_close`, `nexus_file_read`, `nexus_file_write`, `nexus_file_search`
2. **`tools-terminal.ts`** — `nexus_terminal_run`, `nexus_terminal_kill`
3. **`tools-git.ts`** — `nexus_git_status`, `nexus_git_add`, `nexus_git_commit`, `nexus_git_push`, `nexus_git_pull`, `nexus_git_diff`, `nexus_git_log`, `nexus_git_branch_list`, `nexus_git_branch_create`, `nexus_git_branch_switch`
4. **`tools-editor.ts`** — `nexus_editor_focus`, `nexus_editor_insert`, `nexus_editor_replace_selection`, `nexus_editor_goto_line`

## 6. New modules

- `src/main/jarvis/guardrails.ts` — `DESTRUCTIVE_PATTERNS`, `isDestructive()`, `requiresConfirmation()`
- `src/main/jarvis/permissions.ts` — in-memory permission cache per session
- `src/main/jarvis/audit-log.ts` — JSONL audit log to `~/Library/Logs/NexusIDE/jarvis-actions.log`
- `src/renderer/services/mcp-bridge.ts` — IPC bridge for renderer → MCP invocation

## 7. Test framework

Uses **vitest** (confirmed in `mcp-protocol.test.ts`). Tests live alongside source in `*.test.ts` files.