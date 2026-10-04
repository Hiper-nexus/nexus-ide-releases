# Actual local Node-entry CLI controls

Scope: frozen Root `701b38c7fdd81085f693512f69a0a7521325124a`, Darwin,
Node22, private HOME/config/cwd/tmp, one actual CLI at a time and the shared
validation mutex. Only inference is simulated through a finite loopback model
gateway. No operator account/config, global install, external AI, `--yolo`,
sandbox disable, persistent/blanket permission allowlist or new PTY grant.
This is standalone installed-CLI evidence, not signed application acceptance.

Primary local `--version` and `--help` ran with network denied and private
HOME under `nexus-c6-node-primary-2zieccvd` in the owned macOS temp directory:

| CLI | Actual installed package/version | Entry / runtime fact | Tool-control state |
|---|---|---|---|
| Qwen Code | `@qwen-code/qwen-code` 0.24.6 | POSIX Node `cli-entry.js` imports CLI in-process; entry SHA256 `902da7fc992f3b6e51f1822d20ae0d525a1a3000e98367e8a0611b129bc875fd` | Actual ordinary ACP shell baseline and scoped scheduler passed; default native node-pty dispatch, exact ordinary one-time approval. |
| MiMo Code | `@mimo-ai/cli` 0.1.15 | `bin/mimo` is a Node launcher that `spawnSync`s native `@mimo-ai/mimocode-darwin-arm64/bin/mimo`. Wrapper SHA256 `b8898bbb2717cb29a1c03137b6b6117ae3c03e2990322ad9ee1e92d195cc5869` | Version/help only. Native tool/env-cleaner control remains pending; Node launcher presence is not a Node tool-transport PASS. |
| MiniMax Code | `@minimax-ai/code` 0.5.5 | Node `cli.js`, SHA256 `8d36dec74e93beddf392459557a7afd8655bcdc874121981608d2c82658814ab` | Version/help/private provider-add help only. Actual tool baseline/scheduler remains pending. |

Qwen test command (serial under the Root mutex):

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH python3 \
  /Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/with-validation-lock.py \
  /opt/homebrew/opt/node@22/bin/node ./node_modules/vitest/vitest.mjs run \
  src/main/orch/native-heavy-node-clis.test.ts --maxWorkers=1
```

The real SDK advertises `run_shell_command` with required `command`. Both
phases keep `--approval-mode default`. ACP exposes no delegated terminal
capability, so Qwen's own shell executes the command; the fixture never
implements a fake shell. It answers only the actual `allow_once` option
(`proceed_once`) for the exact finite command:

```
NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"
```

`allow_always` options are ignored. No unrelated request is approved. The
private Makefile executes a real Node descendant and records stdout,
exercises a write to a second owned private location, and attempts to reach
a second owned loopback listener which was independently proved live by the
parent before launch. The test does not use an unresolvable domain as its
network-negative oracle. The denied listener receives only that parent
positive request; the descendant cannot reach it.

The scheduler phase reuses the existing frozen `NativeHeavyCommands`,
`HeavyCommandPermitPool`, `OwnedCommandProcesses`, signed/ad-hoc-verified
Darwin supervisor/job base and physical watcher. Main fixture accepts only
`darwin-job` claims; `NEXUS_HEAVY_AGENT_ENTRY` pins the canonical actual CLI
entry so the CLI root is excluded. Measured Qwen scheduled control had one
fresh job admission and two nested lease-borrow requests, followed by exactly
`grant, release`; baseline had no admissions or permits. Both produced the
same `REAL_C6_CHILD_DONE` output through the real CLI shell despite stripped
`NODE_OPTIONS`. SDK session closes through stdin EOF; final controls require
physical outer close with code0/no signal and no responsibility-unknown
warning. Private evidence is preserved, never removed as a prerequisite to
claiming PASS.

Policy distinction: `mission-cli-execution-policy.ts` makes advisory outer
file confinement Hardened/read-only-only; ordinary non-governed AI panes do
not take it. Accordingly the successful control retains ordinary file
permissions and the write to the owned secondary path is **allowed**. Its
network restriction is a fixture safety restriction, not a claim that plain
Autopilot has network denial. The same policy is used in both phases.

An earlier stricter outer fixture denied file writes except workspace/home/tmp.
The actual Qwen tool reached the normal one-time approval, then failed at
`posix_openpt: Operation not permitted` before the shell executed. Evidence:
`nexus-c6-qwen-control-ufY81F/baseline/phase.json`. That is a baseline policy
boundary, not a scheduler regression or a proved product defect. Primary
Qwen chunks map `getShouldUseNodePtyShell` to
`tools.shell.enableInteractiveShell`; explicit one-shot `-p` defaults to a
subprocess, while interactive/ACP uses node-pty. Existing Nexus
`prepareQwenMcpSession` preserves settings and does not select that
preference. Canonical Seatbelt write exceptions are `/dev/null` and
`/dev/tty`; no `/dev/ptmx` or broad device grant was added to make the control
pass. The governed/default-PTY boundary therefore remains explicit pending
separate qualification for that product path.

Final positive receipt is at
`/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-qwen-control-Do3Nd9/receipt.json`
with per-phase physical close/approval/actual SDK tool records in its
`baseline/phase.json` and `scheduled/phase.json`. Both closes were code0/no
signal, graceful EOF, stderr empty. Scheduled fresh job PID18126 and nested
borrow PID18174/PID18235 produced one grant/release; baseline had none. The
owned live-TCP negative passed in both phases. Focused real control:
1 PASS/1 suite; app `tsc --noEmit` exit0, renderer sinks0, Main Sync91. All
commands used Node22 and the Root mutex; no shared dependencies were rebuilt.
All current results are source/standalone controls. Remaining: actual MiMo
and MiniMax tools, governed Qwen transport where applicable, and canonical
app/final signed candidate execution. No grouped matrix PASS is inferred from
these shared transports or version strings.
