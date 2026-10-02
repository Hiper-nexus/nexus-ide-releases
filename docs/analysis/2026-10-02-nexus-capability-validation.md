# Nexus capability validation — 2026-10-02

Baseline: main `08755fe3a14bbd38235d0f2718ad460dfc9eed2e`, package 0.76.163.
This report distinguishes reproduced behavior, automated regression checks and
checks that still require an external runtime. Historical 386 tests/22 probes
were not reused as evidence for this baseline.

## Reproduced capability losses and corrections

- Both Claude adapters statically disabled native Task even in operator panes.
  The restriction now follows the free/governed/read-only pane policy at spawn.
  Native subagents and worker handoff instructions now permit the same scoped
  delegation in Autopilot; governed and read-only regression cases retain denial.
- Browser authorization excluded workers by role. Browser access now proves the
  complete project scope and live Main-owned window/session, including ACP. It
  never borrows an unrelated window when a headless binding is missing.
  Review reproduced two additional losses: ACP presentation had no renderer
  PTY ID, and switching projects removed parked mission panes from that list.
  Main now retains the proven origin and revalidates its live physical identity,
  account, scope and authority; nine regression cases passed, including a
  substituted owner before its first renderer sync.
- Computer autopilot refused workers before executing the same injected loop.
  The regression failed with that exact error, then all 27 tests passed after
  removal of the two role-only checks. OS availability and MCP permissions remain.
- Browser key events lacked `code`; keydown/keyup occurred in one synchronous
  turn. Code-based canvas controls and held-key animation therefore lost input.
  Events now include code, with an optional bounded hold across animation frames.
- Worker completion guidance accepted a code result without browser evidence.
  UI/game handoffs now request runtime URL, viewport, actions, observed states
  and remaining gaps; unavailable visual validation must remain partial/blocked.
  This is guidance, not a cryptographic proof of visual quality.
- The screenshot MCP result contains a local path and metadata serialized as
  text by mcp-protocol.ts, not image content. Tool/worker guidance now explicitly
  requests inspection with an available authorized image tool; a path/hash alone
  is not visual verification. Image egress/isolation rules were not bypassed.
- Main CI already failed on transient ENOTEMPTY in Git fixture cleanup. Bounded
  cleanup now disables fixture Git auto-maintenance before its first commit and
  retries complete directory traversals, because Node's internal rmdir retry
  does not re-scan files created after the tree was emptied. A regression
  repopulated .git/objects four times and passed with all 25 tests. The exact
  writer in the hosted CI failure was not identified.

## Visual reproduction

`scripts/browser-functional-smoke.mjs` bundles the application's real browser
preload and automation runtime into an isolated Electron fixture. It exercises
an HTTP server on loopback with an assigned port, form input, save, menu, mobile
geometry, canvas start, code-based controls, held
movement, restart, console capture and load failures. PNGs and report.json are
uploaded by Linux preview. It does not prove full Nexus boot or subjective design
quality. Inspect the report and screenshots, not merely a successful build.

Hosted Linux preview 36961884071, commit
`d20d5ecdb14eb352941173fba32e20a7c7b8ee49`, executed the real Electron
43.7.4/Chromium 150 preload/runtime under Xvfb. The form saved Ada, the menu
opened, a 390 px viewport used one column without horizontal overflow, and the
game advanced from x=40 to x=87 with two moves and seven held animation frames.
Restart reset state, then another control moved to x=65. Console capture worked;
there were no load failures. The five PNGs were downloaded, hashes verified,
and frontend, game and mobile output visually inspected. These are synthetic
DOM keyboard events, not trusted hardware input. Artifact 11209026664 SHA-256:
`d743ae3af6ef8db9da6db3a775773423d34d51fd1e2c1349a103bedcb33cc7b0`.

Local Electron could initialize but BrowserWindow
crashed before rendering. Local Xvfb was blocked by AF_UNIX socket permission.
No local screenshot was claimed. Same-model Nexus versus direct-agent inference was not run:
no authorized provider CLI session/credentials were present in this environment.

Full CI 36961884068 passed on that same commit: 18,656 tests, typecheck and
renderer sinks. Subsequent ACP/browser fixes require their own final-head CI.

## Model identities

The baseline catalog contains `claude-sonnet-5-5`, `claude-opus-5-5`,
`gpt-6.1-sol` and `gpt-6-astra`. Catalog presence is not account entitlement.
Claude CLI aliases are resolved by the actual host control stream; Codex model
identities come from its model cache. No inference, model substitution or
availability claim was made from a display name alone.

The actual ACP client/driver plus a JSON-RPC subprocess fixture reproduced
another loss: public response chunks reached the observer but not the existing
volatile pane output ring. Public text now enters that bounded ring; thought
chunks and unrelated sessions do not. Requested ACP model/effort also previously
existed only in metadata. The corrected path requires exact peer-advertised
config options, applies and confirms them before prompting, and fails explicitly
when unsupported. This fixture does not prove provider entitlement. Nexus account
IDs cannot currently be bound to generic ACP harness authentication; an explicit
ID (including a UI-materialized default) is rejected before token/process creation
instead of claiming a false binding. Native PTY account selection remains the
existing supported path; no adapter is substituted silently.

## Catalogs, TLS and activation

Pinned local build runtime: official Node 22.23.2 archive, SHA-256 verified
against its release manifest; npm 12.0.0; unchanged package lock. `npm ci` and
Node-native rebuild were run. Node/Electron native ABI results are separate:
Electron 43.7.4 embeds Node 24.21.0 / ABI 148.

The real marketplace loader returned 424 agents and 913 skills from immutable
upstream commit `b9b77d4093b125ed8548d5aafdf167381bae6208` after the commits/main
and recursive tree requests. Its 24-hour cache and SHA/path validation remain.
The real model loader's configured cleofasvolarehost URL returned 404; an earlier
request timed out after 5 s. Both preserved the bundled/existing catalog. No
replacement URL or public-provider key was invented. Catalog tests: 46 passed.

`NODE_USE_ENV_PROXY=1` was already set. `NODE_USE_SYSTEM_CA=1` was tested on Node
22.23.2 and Electron Main's embedded Node; public probes passed with TLS intact.
For those Node processes, reusable activation is:

```bash
export NODE_USE_ENV_PROXY=1
export NODE_USE_SYSTEM_CA=1
```

Preserve the existing authorized proxy and extra CA configuration. Do not copy
credentials into a shell profile, repository or diagnostic output. Main global
fetch succeeding does not prove Chromium trust: electron.net used the proxy but
failed ERR_CERT_AUTHORITY_INVALID, including with NODE_USE_SYSTEM_CA=1. Install
the authorized CA in the Chromium/system trust mechanism for that environment;
do not disable TLS. BrowserWindow networking could not be tested locally.

## Delivery limits

Linux preview and release preparation are described in the separate Linux report.
The d20 preview passed its complete source checks and browser fixture but failed
compiling pinned better-sqlite3 against Electron V8 headers. Package, installed
DEB, portable ZIP and Debian smoke steps therefore did not run on this commit.
Ubuntu installed DEB and portable ZIP checks run on hosted Ubuntu x86_64;
Debian 12 checks are additionally scheduled in an immutable official amd64
container with actual package installation and an unprivileged Xvfb runtime.
A container is not proof of a physical desktop or distribution sandbox behavior;
Omarchy/Arch/Hyprland/Wayland are expected targets, requiring a real desktop run.
The available extra certificate was inspected: one CA certificate, no embedded
private key. It is HTTPS trust material, not an Apple Developer ID identity. No new notarized release
is asserted by source changes or a preview artifact.

The production website source is a separate `nexus-site` repository, absent from
the installed repository inventory; no authorized Cloudflare deploy token/project
was available. An unrelated macOS 0.76.165 release was published while this PR
was running; it does not contain this branch's worker changes. This candidate
is 0.76.166, not that published release. Site deployment remains blocked on that source
and its existing production authentication, not on permission from the user.
