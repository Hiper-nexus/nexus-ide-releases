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

Local Electron 43.7.4/Chromium 150.0.7871.250 could initialize but BrowserWindow
crashed before rendering. Local Xvfb was blocked by AF_UNIX socket permission.
No local screenshot was claimed. The hosted Ubuntu Xvfb workflow must supply
execution evidence. Same-model Nexus versus direct-agent inference was not run:
no authorized provider CLI session/credentials were present in this environment.

## Model identities

The baseline catalog contains `claude-sonnet-5-5`, `claude-opus-5-5`,
`gpt-6.1-sol` and `gpt-6-astra`. Catalog presence is not account entitlement.
Claude CLI aliases are resolved by the actual host control stream; Codex model
identities come from its model cache. No inference, model substitution or
availability claim was made from a display name alone.

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
was available. The live /api/releases snapshot and download redirects lagged the
public mirror's 0.76.163 release. Site deployment remains blocked on that source
and its existing production authentication, not on permission from the user.
