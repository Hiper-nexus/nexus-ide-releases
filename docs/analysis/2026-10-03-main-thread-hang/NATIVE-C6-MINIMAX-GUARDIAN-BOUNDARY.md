# MiniMax real baseline and scheduled guardian boundary

Actual installed `@minimax-ai/code` 0.5.5:
`~/.npm-global/lib/node_modules/@minimax-ai/code/cli.js` entry SHA256
`8d36dec74e93beddf392459557a7afd8655bcdc874121981608d2c82658814ab`.
Its installed better-sqlite3 is ABI147; ordinary Homebrew Node is
`/opt/homebrew/Cellar/node/26.9.0/bin/node`, v26.9.0/ABI147. Node22 validation
cannot initialize that installed DB binding (ABI127). No global/shared
dependency was installed, rebuilt or replaced. Validator/Main fixture ports
stay Node22. Fixture records the actual Node/version/hash and the Nexus
resolver result for that explicit private PATH; it does not infer the live
operator application's boot PATH.

Private BYOK configuration uses the CLI's normal command:
`provider add --name NativeFinite --api-format openai-completions --model
finite-model --api-key-env NEXUS_FAKE_PROVIDER_KEY --base-url <owned-loopback>/v1
--use`. The normal `--use` endpoint test receives only the finite fixture
response and selects that private provider. Merely adding it, or supplying
the global `--model` flag to ACP, left its hosted default selected and failed
`session/new` with `mcode login` required. No login or auth bypass was used.

With ordinary unchanged ACP permission mode and that private default,
baseline completed the actual advertised `bash` tool and exact command:

```
NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"
```

It produced `REAL_C6_CHILD_DONE`, preserved the policy's allowed write to a
second owned private path, and could not reach the additional owned TCP
listener which the parent had independently proved live. The CLI made no
permission request for this command in its ordinary mode; the fixture did
not switch mode or add an allowlist. Baseline had zero Main admissions.

Scheduled with the same ordinary mode/config reached a fresh Main
`darwin-job` admission but **failed** before the Makefile result. Actual SDK
tool output: `Parent-death guardian target registration timed out`, execution
status unknown, exitCode null, task status failed. One `grant, release` was
observed for the admitted cohort; this is not a successful command or CLI
scheduler PASS. Both CLI/supervisor instances subsequently closed through
EOF, code0/no signal, stderr empty.

Primary installed source is `chunks/chunk-S6GSNWAM.js`, SHA256
`9b6ff16a181cc05ad0c67935080d3e097e03c9fdad14bdc0681df2ec296a5ae3`.
The `tj(targetPid, graceMs, leaseId)` call spawns `process.execPath` with:

```
["--input-type=module", "--eval", guardianSource,
 String(targetPid), String(graceMs), leaseId]
```

It is detached and uses `stdio: [ignore, ignore, ignore, ipc]`. Its deliberately
cleared env permits only present SystemRoot/windir, plus Electron's
ELECTRON_RUN_AS_NODE where relevant. `Ik(targetPid)` obtains this guardian,
sends `{type: arm, leaseId, pid, graceMs}` and awaits the exact `armed` reply
matching PID/lease through `rj()` with a 1000ms target-registration bound.
The target spawn caller creates its guarded shell, calls `Ik(child.pid)`,
awaits `guardian.ready`, and only then writes `ready\n` to the guarded shell's
stdin and records `command_dispatched`. On failure it destroys stdin, stops
the exact target and awaits its close before surfacing the error.

This ordering establishes a concrete control-process/target interaction:
generic Node-eval classification can wrap/admit a guardian or delay it behind
the target's permit. Determining which exact PID/IPC envelope failed belongs
to the Native resource owner; it remains a hypothesis until that boundary is
traced. Do not disable the SDK guardian, broaden sandbox/permission rights,
or treat increasing its timeout as proof of correction.

Retained actual evidence:
`/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-minimax-control-IsbEnq`.
Baseline CLI/supervisor PID52139, scheduled PID52214, fresh admitted job
PID52249. Per-phase files preserve actual tool inputs/results and records:

| Artifact | SHA256 |
|---|---|
| `baseline/phase.json` | `11f4a92f649eb1cf43fd0a57e1e282dfb0ca1bf8bd0759398c2868d08417905c` |
| `scheduled/phase.json` | `7edd42c1c7227755f8923a13338242e233e34d9704b0134174f17aba0985971b` |

Explicit RED fixture command under Node22 + shared mutex:

```sh
NEXUS_TEST_NATIVE_NODE_CLI=minimax PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  python3 /Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/with-validation-lock.py \
  /opt/homebrew/opt/node@22/bin/node ./node_modules/vitest/vitest.mjs run \
  src/main/orch/native-heavy-node-clis.test.ts --maxWorkers=1
```

The original frozen MiniMax control was RED at this boundary; the verified
resource follow-up appears below. Default focused selection remains Qwen,
whose positive control is distinct. No generic matrix PASS, candidate
execution, operator profile/process or external inference is claimed.

## Verified resource follow-up

The original RED artifact above is retained as baseline evidence. The owner
fixed the guardian/target circular wait in F900, then independent review found
that a loose node-basename/environment/options matcher could also exempt a
different execution. The narrowed matcher requires the exact current
process.execPath, fixed source digest/argv/IPC, deliberately closed SDK env,
no shell execution, and only measured spawn fields. Primary chunk line171
also contains `windowsHide:true`; preserving it closed the first strict
real-round rejection without relaxing any executable/env boundary.

Fresh post-fix union: 27 PASS / 1 unrelated CLI skip / 2 suites (37.46s),
including actual MiniMax baseline/scheduled and all new negative matcher
controls; full tsc exit0. The one-second guardian registration and its IPC
contract remain unchanged. These are local/source controls, not signed
candidate or universal adapter evidence.
