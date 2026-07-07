# Senior Code Review - Fase 4 Jarvis MCP Tools

Reviewed branch: `nexus-jarvis-fase4-agent`
Reviewed range: `main..HEAD`
Reviewed HEAD before this review doc: `292097610d04482024e390e5716ba42efeac3ea7`
Review date: 2026-07-07
Reviewer stance: release-blocking security review for v1.0.0

## Executive Summary

Verdict: **BLOCKED for v1.0.0**.

The branch adds high-impact MCP tools for filesystem writes, shell execution,
Git mutation, and editor mutation. The core security model is incomplete:
the new guardrails, permission cache, and audit log are only enforced on the
renderer IPC bridge, while the embedded HTTP MCP server used by CLI agents
calls the same tools directly without confirmation or audit. In addition, the
renderer can grant its own MCP permissions without a native main-process dialog,
workspace path checks are bypassable through symlinks, and `nexus_git_push`
can be coerced into force/delete refspecs through unvalidated args.

Finding count: **4 BLOCKER, 5 HIGH, 3 MEDIUM, 2 LOW**.

Top 3 vulnerabilities:

1. **BLOCKER:** CLI-agent MCP calls bypass Fase 4 guardrails and audit entirely.
2. **BLOCKER:** Renderer IPC exposes self-service confirmation, so compromised
   renderer JS can grant and execute dangerous tools without a user dialog.
3. **BLOCKER:** Workspace boundary is lexical only; symlinks let file/editor/cwd
   tools read, write, or execute outside the active workspace.

## Scope Reviewed

Commits reviewed:

- `c63bc7a WIP: recover code from mixed workspace`
- `e5a8c55 feat(jarvis): wire MCP tool bridge`
- `95c689a fix(orch): harden Jarvis MCP tools`
- `2920976 docs: add fase 4 MCP changelog`

Files read completely:

- `docs/analysis/fase4-mcp-map.md`
- `docs/changelog/fase4.md`
- `src/main/jarvis/audit-log.ts`
- `src/main/jarvis/guardrails.ts`
- `src/main/jarvis/mcp-ipc.ts`
- `src/main/jarvis/permissions.ts`
- `src/main/orch/workspace-path.ts`
- `src/main/orch/tools-files.ts`
- `src/main/orch/tools-editor.ts`
- `src/main/orch/tools-git.ts`
- `src/main/orch/tools-terminal.ts`
- `src/main/orch/tools.ts`
- `src/main/orch/__tests__/audit-log.test.ts`
- `src/main/orch/__tests__/guardrails.test.ts`
- `src/main/orch/__tests__/mcp-ipc.test.ts`
- `src/main/orch/__tests__/permissions.test.ts`
- `src/main/orch/__tests__/tools-editor.test.ts`
- `src/main/orch/__tests__/tools-files.test.ts`
- `src/main/orch/__tests__/tools-git.test.ts`
- `src/main/orch/__tests__/tools-terminal.test.ts`
- `src/renderer/services/mcp-bridge.ts`

Related files inspected for boundary behavior:

- `src/main/orch/mcp-protocol.ts`
- `src/main/orch/mcp-server.ts`
- `src/main/orch/gate.ts`
- `src/main/persistence/files-ipc.ts`
- `src/main/persistence/workspace-store.ts`
- `src/main/voice/voice-ipc.ts`
- `src/renderer/voice/voice-controller.ts`
- `src/preload/preload.ts`
- `src/shared/channels.ts`
- `src/shared/mcp-types.ts`
- `src/shared/types.ts`

## P0 Invariant Status

| Invariant | Status | Notes |
|---|---:|---|
| Hot zone untouched | Unknown | The F3 hot-zone list is not present in this worktree. Review used `git diff --name-status main...HEAD`. |
| Destructive guardrails require confirmation | FAIL | HTTP MCP path has no guardrail/audit layer; renderer confirmation is self-service. |
| Audit log JSONL with redaction/result/duration/auth | FAIL | IPC path logs, HTTP MCP path does not. Log writes fail open and redaction is incomplete. |
| Stable permission hashing incl. nested args | PARTIAL | Nested key order is normalized, but cache is not scoped to workspace/window/session and has no TTL/single-use token. |
| Workspace cwd/path bounded to active workspace | FAIL | Lexical checks are bypassable by symlinks and existing symlink parents. |
| Git uses `execFile` | PARTIAL | `execFile` is used, but args are not validated or separated with `--`, allowing Git option/refspec injection. |
| LLM prompts in EN | PASS for new tool descriptions | New MCP tool descriptions are English. Existing Jarvis voice prompt remains Portuguese outside this diff. |

## Findings

### BLOCKER-01 - CLI MCP agents bypass the new confirmation and audit layer

**Files:** `src/main/orch/tools.ts:20`, `src/main/orch/mcp-protocol.ts:145`,
`src/main/orch/mcp-server.ts:185`, `src/main/orch/gate.ts:47`,
`src/main/jarvis/mcp-ipc.ts:90`

**Problem:** Fase 4 adds file, terminal, git, and editor tools to the global
MCP toolset in `buildToolset()`, but the actual embedded MCP HTTP server used by
CLI agents dispatches `tools/call` directly to `tool.handler(args, ctx)`.
The only checks there are allowlist checks. `requiresConfirmation()`,
`hasPermission()`, and `auditSuccess/auditError/auditDenied()` are only used by
the renderer IPC path in `mcp-ipc.ts`.

**Evidence:**

- `tools.ts:20-29` appends `buildFileTools()`, `buildTerminalTools()`,
  `buildGitTools()`, and `buildEditorTools()` to every MCP registry.
- `mcp-protocol.ts:154-168` checks `isToolAllowed()` and then runs the handler.
  No guardrails, permission cache, confirmation, or audit call exists there.
- `mcp-server.ts:185-210` pretool gate only checks allowlists.
- `gate.ts:47-53` does not classify `terminal_run`, `file_write`, `git_push`,
  `git_commit`, or editor writes as explicit-grant-only high-impact tools.
- `gate.ts:81` treats `allowedTools === null` as unrestricted.

**Impact:** Any CLI agent with unrestricted MCP access can call
`nexus_terminal_run`, `nexus_file_write`, `nexus_git_push`, or
`nexus_editor_replace_selection` without native user confirmation and without
audit logging. This is the highest-risk surface in the feature because it is
the actual MCP path used by agents in panes.

**Fix:** Move confirmation/audit enforcement into a shared server-side wrapper
that is used by both `mcp-ipc.ts` and `mcp-protocol.ts`. Treat mutating and
external-execution tools as explicit-grant-only in `gate.ts` by default. For
HTTP MCP, require a main-process mediated confirmation grant or deny these
tools unless they were explicitly allowed for that agent and mission.

### BLOCKER-02 - Renderer IPC can self-authorize dangerous MCP tools

**Files:** `src/preload/preload.ts:563`, `src/main/jarvis/mcp-ipc.ts:139`,
`src/main/voice/voice-ipc.ts:276`

**Problem:** `window.nexus.mcp.confirm(tool, args)` is exposed to renderer JS
and maps directly to `confirmMcpTool()`, which calls `grantPermission()` with no
native dialog or user gesture proof. This is not an unspoofable confirmation.
The existing voice command path correctly uses a native `dialog.showMessageBox`
in main; the new MCP confirmation path does not.

**Evidence:**

- `preload.ts:563-568` exposes `mcp.invoke`, `mcp.confirm`, and
  `mcp.clearSession`.
- `mcp-ipc.ts:139-150` resolves the tool and grants permission immediately.
- `voice-ipc.ts:276-300` shows the prior secure pattern: main validates the
  command and displays a native dialog that renderer JS cannot fake.

**Impact:** Any XSS, compromised renderer dependency, or malicious renderer
code can execute:

```ts
await window.nexus.mcp.confirm('nexus_terminal_run', { command: '...', cwd: '.' });
await window.nexus.mcp.invoke('nexus_terminal_run', { command: '...', cwd: '.' });
```

That bypasses the intended user confirmation flow completely.

**Fix:** Remove direct permission-grant IPC from the renderer. Replace it with a
main-process confirmation function that displays the exact tool, canonicalized
args, cwd/workspace, environment deltas, and risk class in a native dialog. The
grant should be single-use, short-lived, and bound to the exact canonical args
plus workspace root and requesting WebContents.

### BLOCKER-03 - Workspace boundary is bypassable through symlinks

**Files:** `src/main/orch/workspace-path.ts:11`,
`src/main/orch/tools-files.ts:39`, `src/main/orch/tools-editor.ts:45`,
`src/main/orch/tools-terminal.ts:45`, `src/main/orch/tools-git.ts:28`

**Problem:** `resolveWorkspacePath()` and `resolveWorkspaceCwd()` only compare
`path.resolve()`/`path.relative()` strings. They do not resolve symlinks. File
and editor tools then call `fs.statSync`, `fs.readFileSync`, and
`fs.writeFileSync`, all of which follow symlinks. Terminal and git tools accept
symlinked cwd directories inside the workspace that resolve outside it.

**Evidence:** A one-off local check reproduced the bypass:

```json
{
  "input": "link/secret.txt",
  "relative": "link/secret.txt",
  "inside": true,
  "real": "/private/.../outside/secret.txt",
  "content": "outside-secret"
}
```

The lexical check says the target is inside the workspace while `realpath`
shows it is outside.

**Impact:** A workspace can contain `link -> /Users/<user>` or another external
directory. Then:

- `nexus_file_read({ path: "link/.ssh/config" })` can read outside workspace.
- `nexus_file_write({ path: "link/.zshrc", content: "..." })` can write outside workspace.
- `nexus_editor_replace_selection({ path: "link/file", ... })` can edit outside workspace.
- `nexus_terminal_run({ cwd: "link", command: "..." })` runs outside workspace.
- `nexus_git_*({ cwd: "link" })` operates outside workspace.

This violates the workspace boundary invariant.

**Fix:** Canonicalize the active workspace root with `fs.realpathSync()`. For
existing paths, compare target `realpath` to root `realpath`. For writes to new
paths, resolve the nearest existing parent with `realpath`, reject symlink
parents outside root, and consider `lstat`/`O_NOFOLLOW` protections for final
path overwrites. Reuse the stronger pattern already present in
`src/main/persistence/files-ipc.ts:34-64`.

### BLOCKER-04 - `nexus_git_push` can bypass force/delete guardrails through args

**Files:** `src/main/orch/tools-git.ts:131`, `src/main/jarvis/guardrails.ts:12`,
`src/main/jarvis/guardrails.ts:162`

**Problem:** Git uses `execFile`, which prevents shell interpolation, but the
Git args themselves are unvalidated. `nexus_git_push` builds
`['push', remote, branch]`; `remote` and `branch` can begin with `-`, include
force refspecs such as `+main`, or delete refspecs such as `:main`. The
guardrail regexes only inspect terminal command strings and never inspect Git
tool args.

**Evidence:**

- `tools-git.ts:131-137` passes `remote` and `branch` directly to Git.
- `guardrails.ts:15-16` detects `git push --force` only in a shell command
  string, not in structured Git tool args.
- `confirmationReason()` for `nexus_git_push` returns only `push to remote`, so
  even the IPC path does not show dangerous remote/branch values.

**Impact:** An agent can request a normal-looking `nexus_git_push` while
supplying args that Git parses as force push or remote branch deletion. On the
HTTP MCP path this requires no Fase 4 confirmation at all due BLOCKER-01. On
the renderer IPC path the confirmation reason hides the actual dangerous args.

**Fix:** Validate all Git user args before `execFile`. Reject any remote,
branch, path, or branch name beginning with `-`, containing NUL/control chars,
or matching force/delete refspec syntax unless a separately named and
specifically confirmed option allows it. For pathspec commands, insert `--`
before paths. Include remote/branch/refspecs in the native confirmation text.

### HIGH-01 - Permission grants are global to the renderer and not scoped to workspace

**Files:** `src/main/jarvis/mcp-ipc.ts:30`, `src/main/jarvis/permissions.ts:37`,
`src/main/jarvis/mcp-ipc.ts:153`

**Problem:** All renderer MCP grants use the constant session id
`jarvis-renderer`. The permission hash includes only tool name and args, not
the active workspace root, WebContents id, Jarvis turn/session id, or mission.
The cache is only cleared if the renderer calls `mcp.clearSession()`.

**Impact:** A grant for `{ tool: "nexus_file_write", args: { path:
"package.json", content: "..." } }` in workspace A can remain valid after
switching to workspace B if the args are identical. That is not the same
authorized action from the user's perspective.

**Fix:** Include canonical workspace root, WebContents id, and a server-owned
Jarvis session nonce in the permission key. Clear automatically on workspace
change/window close/Jarvis session end. Make grants single-use or short TTL.

### HIGH-02 - Audit logging is fail-open and redaction misses high-risk fields

**Files:** `src/main/jarvis/audit-log.ts:20`, `src/main/jarvis/audit-log.ts:42`,
`src/main/jarvis/audit-log.ts:70`

**Problem:** `writeAuditEntry()` catches write failures and lets the tool
continue. Redaction only covers secret-looking keys plus `content`, `oldText`,
and `newText`. It does not redact or bound `text` (used by editor/pane writes)
or sensitive command strings. It also does not protect against huge nested
objects beyond truncating individual long strings.

**Impact:** The system can execute mutating actions with no durable audit trail
if the log path is unavailable, disk is full, permissions fail, or serialization
throws before the write. Audit logs can also persist secrets embedded in
terminal commands, editor inserted `text`, pane prompts, or non-standard env
keys.

**Fix:** For mutating/external-execution tools, fail closed or return an
explicit error if audit persistence fails. Redact `text`, command secret
patterns, large arrays/objects, and values matching common token formats.
Enforce serialized audit-entry size limits. Add tests for env, command, editor
text, large args, and audit write failure.

### HIGH-03 - `nexus_terminal_run` environment and output handling enable bypass/DoS

**Files:** `src/main/orch/tools-terminal.ts:43`,
`src/main/orch/tools-terminal.ts:50`, `src/main/orch/tools-terminal.ts:58`,
`src/main/jarvis/guardrails.ts:155`

**Problem:** `nexus_terminal_run` accepts arbitrary `env` and merges it over
`process.env`. The confirmation reason shows only the command string, not env
changes. The tool also uses `exec(command)` and accumulates stdout/stderr
unbounded in memory until process close, then slices only the final returned
string.

**Impact:** A request that appears to run `npm test` can change behavior with
`PATH`, `NODE_OPTIONS`, `GIT_ASKPASS`, `BASH_ENV`, or similar environment
variables. A command producing large output can exhaust memory before the final
100 KB slice. With timeout up to 300 seconds and no concurrency/rate limit, this
is a practical main-process DoS vector.

**Fix:** Default-deny env overrides or allowlist safe names. Display env deltas
in the main-process confirmation. Stream output with hard byte caps that kill
the child when exceeded. Add global concurrency and rate limits per session.

### HIGH-04 - Jarvis voice actions are not actually routed through the MCP bridge

**Files:** `src/renderer/services/mcp-bridge.ts:100`,
`src/renderer/voice/voice-controller.ts:779`, `src/renderer/voice/voice-controller.ts:910`

**Problem:** `mcp-bridge.ts` is added, but `rg` found no imports or call sites
outside itself and tests. `voice-controller.ts` still executes the old
renderer-side switch for Jarvis actions. The `run_command` path still writes
directly into a terminal pane after the old native dialog, and non-command
actions never hit the MCP audit/permission path.

**Impact:** The changelog and bridge comments imply Jarvis actions flow through
MCP guardrails, permissions, and audit logging. They do not. Security-sensitive
voice actions remain split across two enforcement models, and the new audit log
does not provide a complete Jarvis action trail.

**Fix:** Either integrate `invokeActionViaMcp()` into the voice execution path
with a secure native confirmation flow, or keep the old path and do not expose
the new MCP bridge until the flow is complete. In both cases, audit Jarvis
actions consistently.

### HIGH-05 - IPC/MCP args lack runtime schema, depth, and size validation

**Files:** `src/shared/mcp-types.ts:1`, `src/main/jarvis/mcp-ipc.ts:43`,
`src/main/orch/mcp-protocol.ts:163`, `src/main/jarvis/permissions.ts:24`,
`src/main/jarvis/audit-log.ts:42`

**Problem:** MCP invoke/confirm requests are TypeScript interfaces only. Main
process code casts arbitrary `args` to `Record<string, unknown>`. Permission
hashing and audit redaction recursively walk objects with no cycle detection,
depth cap, key count cap, or total byte cap.

**Impact:** Large or cyclic structured-clone payloads can crash or stall the
main process before audit logging. Even non-cyclic oversized args can consume
CPU/memory in `normalizeForHash()`, `JSON.stringify()`, and `redactArgs()`.

**Fix:** Use zod or equivalent runtime schemas at both IPC and MCP boundaries.
Apply global limits for serialized request size, max object depth, max keys,
max string length, and max array length. Use a safe stable stringify that
detects cycles and fails closed.

### MEDIUM-01 - Git commands execute repository hooks/config without a risk model

**Files:** `src/main/orch/tools-git.ts:101`, `src/main/orch/tools-git.ts:168`,
`src/main/orch/tools-git.ts:199`, `src/main/orch/tools-git.ts:308`

**Problem:** Several Git operations are external process executions that can run
repo-controlled hooks or configured external helpers. Examples: `git commit`
runs commit hooks, `git checkout` can run checkout hooks, `git pull` can run
merge/post-merge hooks, and `git diff` can trigger external diff/textconv
drivers from repository config.

**Impact:** Tools that look like source-control operations can execute code from
the workspace. This is acceptable only if the UI and permissions model treats
them as code execution, not as simple metadata operations.

**Fix:** Classify relevant Git commands as external code execution in
confirmation/audit UI. Consider disabling hooks where safe (`--no-verify` for
commit when desired) or explicitly disclosing hook execution. Use sanitized env
for Git subprocesses.

### MEDIUM-02 - File/editor tools lack file size, binary, and atomic-write guards

**Files:** `src/main/orch/tools-files.ts:47`, `src/main/orch/tools-files.ts:113`,
`src/main/orch/tools-files.ts:167`, `src/main/orch/tools-editor.ts:49`,
`src/main/orch/tools-editor.ts:164`

**Problem:** `nexus_file_open`, `nexus_file_read`, `nexus_editor_focus`, and
editor mutation tools read entire files synchronously. Writes are synchronous
and non-atomic. Unlike `persistence/files-ipc.ts`, these tools have no
`MAX_READ_BYTES`, binary detection, or too-large response path.

**Impact:** A large file can stall the main process, a binary file can produce
huge unreadable payloads, and interrupted writes can corrupt source files.

**Fix:** Reuse the file explorer constraints: max read size, binary detection,
line-windowed reads, and atomic write-to-temp plus rename for writes. Add
explicit limits for editor replace/replaceAll operations.

### MEDIUM-03 - Security test coverage does not cover the actual critical paths

**Files:** `src/main/orch/__tests__/mcp-ipc.test.ts:46`,
`src/main/orch/__tests__/tools-files.test.ts:77`,
`src/main/orch/__tests__/tools-git.test.ts:67`,
`src/main/orch/__tests__/tools-terminal.test.ts:52`

**Problem:** The tests cover some positive cases and lexical `..` rejection,
but they do not cover the highest-risk regressions found in this review.

Missing negative cases:

- HTTP MCP `tools/call` must be denied/audited for terminal/file/git/editor mutation.
- Renderer `mcp.confirm` must require native main confirmation.
- Symlink escape for file read/write, editor read/write, terminal cwd, and git cwd.
- `nexus_git_push` force/delete injection through `remote`, `branch`, `+ref`, and `:ref`.
- `git_add` pathspec option injection and missing `--`.
- Cross-workspace permission reuse.
- Cyclic/oversized args.
- Audit write failure and redaction for `text`, `command`, env, and nested secrets.
- Terminal output overflow and concurrent invocations.

**Fix:** Add tests at the shared enforcement layer, not only per-tool handlers.
Use temporary workspaces and local bare Git remotes for force/delete tests.

### LOW-01 - `nexus_terminal_kill` is marked read-only/no-confirm

**Files:** `src/main/jarvis/guardrails.ts:66`,
`src/main/orch/tools-terminal.ts:125`

**Problem:** `nexus_terminal_kill` is in `NEVER_CONFIRM_TOOLS`, but it can
terminate an active process started by another approved terminal invocation.

**Impact:** This can disrupt user-approved work. It is not equivalent to a
read-only operation.

**Fix:** Require confirmation when killing a process not owned by the same
single-use grant or expose explicit process ownership metadata.

### LOW-02 - Test helper can delete the real user audit log

**Files:** `src/main/jarvis/audit-log.ts:211`,
`src/main/orch/__tests__/audit-log.test.ts:11`

**Problem:** `clearAuditLog()` is production code pointing at
`~/Library/Logs/NexusIDE/jarvis-actions.log`, and tests call it directly.

**Impact:** Running tests on a developer machine can erase the real local
Jarvis audit log. This undermines audit integrity outside CI.

**Fix:** Make the audit log path injectable for tests or guard `clearAuditLog()`
behind a test-only dependency. Never let test runs mutate production audit
locations.

## Dedicated Attack Surface: External Execution Tools

### `nexus_terminal_run`

- Executes arbitrary shell command through `exec(command)`.
- Inputs: `command`, `cwd`, `timeoutMs`, `env`.
- Current boundaries: lexical cwd check only; confirmation only on renderer IPC;
  no HTTP MCP confirmation/audit; env accepted without allowlist; output
  accumulated in memory.
- Required controls: shared confirmation/audit wrapper, realpath cwd boundary,
  env allowlist/disclosure, hard output/concurrency limits, rate limit, tests for
  shell metacharacters and destructive variants.

### `nexus_terminal_kill`

- Sends `SIGTERM` to tracked child process.
- Inputs: optional `processId`.
- Current boundaries: no confirmation; process ownership is global module state.
- Required controls: ownership binding, confirmation or same-grant restriction,
  deterministic process ids returned by run/streaming tool.

### `nexus_git_status`

- Executes `git status --short --branch` through `execFile`.
- Inputs: `cwd`.
- Current boundaries: lexical cwd check only; no HTTP MCP audit.
- Risk: lower-risk read operation, but still an external process in a repo that
  may have expensive status behavior.
- Required controls: realpath cwd boundary, audit for MCP calls, timeout retained.

### `nexus_git_add`

- Executes `git add <paths...>`.
- Inputs: `paths`, `cwd`.
- Current boundaries: no `--` separator; path args can be parsed as Git options;
  lexical cwd only; no HTTP MCP confirmation/audit.
- Required controls: reject pathspecs beginning with `-` or insert `--`; show
  exact paths in confirmation; realpath cwd boundary.

### `nexus_git_commit`

- Executes `git commit -m <message>`.
- Inputs: `message`, `cwd`.
- Current boundaries: `execFile` prevents shell interpolation, but commit hooks
  can execute repo code; no HTTP MCP confirmation/audit.
- Required controls: treat as code execution, show hook risk, consider
  `--no-verify` policy, realpath cwd boundary.

### `nexus_git_push`

- Executes `git push <remote> [branch]`.
- Inputs: `remote`, `branch`, `cwd`.
- Current boundaries: no validation against `--force`, `+ref`, `:ref`, or
  leading-dash options; confirmation reason omits args; no HTTP MCP
  confirmation/audit.
- Required controls: explicit safe ref validation, separate force/delete API
  requiring stronger confirmation, remote/branch disclosure, realpath cwd.

### `nexus_git_pull`

- Executes `git pull [--rebase] <remote> [branch]`.
- Inputs: `remote`, `branch`, `rebase`, `cwd`.
- Current boundaries: unvalidated remote/branch can be parsed as options; pull
  can mutate workspace and run hooks; no HTTP MCP confirmation/audit.
- Required controls: validate args, classify as mutating code execution,
  disclose branch/remote/rebase, realpath cwd.

### `nexus_git_diff`

- Executes `git diff [--cached]`.
- Inputs: `staged`, `cwd`.
- Current boundaries: read-only but Git diff can trigger external diff/textconv
  helpers from repo config; output capped by execFile maxBuffer but still no MCP
  audit on HTTP path.
- Required controls: treat as external execution in audit; consider disabling
  external diff/textconv or documenting/confirming the risk.

### `nexus_git_log`

- Executes `git log --oneline -n <count>`.
- Inputs: `count`, `cwd`.
- Current boundaries: count max is capped at 100, but no lower-bound/NaN
  validation; lexical cwd only; no HTTP MCP audit.
- Required controls: integer range validation and realpath cwd boundary.

### `nexus_git_branch_list`

- Executes `git branch`.
- Inputs: `cwd`.
- Current boundaries: lower-risk external process; lexical cwd only; no HTTP MCP
  audit.
- Required controls: realpath cwd boundary and audit.

### `nexus_git_branch_create`

- Executes `git branch <name>`.
- Inputs: `name`, `cwd`.
- Current boundaries: branch name can begin with `-` and be parsed as an option;
  mutates refs; no HTTP MCP confirmation/audit.
- Required controls: strict branch-name validation and confirmation with exact
  name.

### `nexus_git_branch_switch`

- Executes `git checkout <name>`.
- Inputs: `name`, `cwd`.
- Current boundaries: `checkout` can mutate files and run hooks; branch name can
  begin with `-`; no HTTP MCP confirmation/audit.
- Required controls: use `git switch -- <name>` or validated args, disclose hook
  risk, realpath cwd boundary.

## Security Checklist

- Injection: **Issues found.** Shell execution exists by design; Git option and
  refspec injection are unresolved.
- XSS/renderer compromise: **Issues found.** Renderer can self-confirm MCP
  permissions.
- Authentication: **Partial.** HTTP MCP uses bearer tokens; renderer IPC has no
  per-window/session authorization.
- Authorization/IDOR: **Issues found.** Permission grants are global to
  renderer and not workspace-scoped.
- CSRF: **Not directly applicable** to local IPC, but local HTTP MCP bearer
  tokens remain high-value.
- Race/TOCTOU: **Issues found.** Permission grants can outlive workspace/session
  context; symlink parents can change between check and write.
- Session: **Issues found.** No TTL/single-use grants; fixed renderer session id.
- Cryptography: **Partial.** SHA-256 stable hashing exists, but only 16 hex
  chars are retained and the hash omits workspace/session context.
- Information disclosure: **Issues found.** Symlink read escape and audit
  redaction gaps.
- DoS: **Issues found.** Large/cyclic args, full-file reads, unbounded terminal
  output accumulation, no rate/concurrency limit.
- Business logic: **Issues found.** Bridge is not wired into Jarvis voice flow;
  Git push safety claims are not enforced.

## Validation Performed

- `git log main..HEAD --stat --oneline` to identify the 4 reviewed commits.
- `git diff --find-renames --unified=80 main...HEAD` split by subsystem.
- `rg -n --glob '*.ts' --glob '!**/*.test.ts' "child_process|\\bexec\\(|\\bexecFile\\(|\\bexecFileSync\\(|\\bspawn\\(|eval\\b|Function\\(" src/main src/preload src/renderer src/shared`
- `rg -n --glob '*.ts' --glob '!**/*.test.ts' "readFileSync|readFile\\(|writeFileSync|writeFile\\(|unlinkSync|unlink\\(|rmSync|rm\\(" src/main src/preload src/renderer src/shared`
- One-off symlink boundary reproduction with Node in a temporary directory.
- `git diff --check main...HEAD` passed before adding this report.

I did not rerun `npm test`: the prompt reported the full suite passing, and
`audit-log.test.ts` currently calls `clearAuditLog()` against the real
`~/Library/Logs/NexusIDE/jarvis-actions.log` path. Re-running it on a developer
machine can delete local audit history.
