# C6 remaining installed CLI controls

Source snapshot: `be091fd6534a01a6f6ba5e5a05a020bcf4e69079` (2026-10-04).
These are local actual-CLI controls, not signed-app or release acceptance. No
operator credentials, global configuration, or installed dependency was changed.
Empty private HOME authentication failures below do not establish the operator's
native authentication status.

| CLI | Actual installed primary | Measured result | Still required |
|---|---|---|---|
| Aider | UV `aider-chat` 0.86.2, Python 3.12 | Real owned-PTY baseline and scheduled shell execution passed with the exact command's normal one-time approval. Default Nexus `--yes-always` separately declined the shell command. | Canonical app/candidate execution; the default refusal is a CLI capability limit, not a scheduler execution PASS. |
| Devin | Native 3000.11.3 (`9c803229faa4`) | Native `auth status` confirms Logged in, credentials unchanged. Supported API-server override reaches the actual account-status protobuf endpoint in the owned gateway. Empty private HOME results are historical isolation controls. | Real native account validation plus finite inference/tool control; no entitlement response or codec is fabricated. |
| AGY | Native 1.2.16 | Existing Nexus native Keychain accessor confirms a usable OAuth payload. Empty private HOME failed eligibility before gateway parsing or tools. | Actual native eligibility plus public bounded gateway/tool control. Installed help exposes no auth-status command; no eligibility bypass or external inference was attempted. |

## Aider physical proof

`src/main/orch/native-heavy-aider.test.ts` uses the existing Node-PTY bootstrap
and Darwin supervisor, private HOME/workspace, actual `buildControlArgs`, and a
bounded loopback OpenAI-compatible inference fixture. The installed Aider parser
extracts the model's bash block and its ordinary confirmation invokes its own
shell transport. The fixture never runs the model's command itself.

The only approved command is
`NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"`. The private Makefile runs
Node and writes `ACTUAL_AIDER_NODE_DONE` to its private marker. The fixture sends
`y` once only after the exact command and `Run shell command?` prompt. It does
not persist an allowlist or change the CLI guard. `permissionMode: default`
selects that ordinary prompt; default Nexus arguments remain separately tested.

Actual primary `aider/run_cmd.py:14` chooses pexpect when stdin is a TTY;
`:88` onward executes inherited `SHELL` (`/bin/zsh` here). Its headless
`Popen(shell=True)` branch at `:62` is a different raw-sh boundary and is not
covered by this PTY result. `aider/io.py:866` deliberately answers no when
`yes=True` and `explicit_yes_required=True`; `base_coder.py:2459` requests that
explicit confirmation for model shell commands. Thus `--yes-always` refusal is
preserved rather than silently replaced with a grant.

The measured one-time run passed 1 test/1 suite in 26.07 s. Evidence is preserved
at `/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-aider-pty-2yxxnl/receipt.json`.
Its source SHA is the snapshot above, in-flight fixture SHA256 is
`5f955b89f2cd9483d8de3d1820d3d4a8171e6aa906d4a399037450379bd03fa5`.
Both phases observed actual PTY exit `{exitCode:0,signal:0}` and the exact marker.
Baseline had no admissions. Scheduled execution admitted fresh Darwin job
PID 84486 and borrower PID 84533, then exactly `grant,release` after physical
drain. No responsibility-inventory-unknown message was observed. The separate
default-guard run passed 1 test/1 suite in 9.97 s with no marker/admission; it
proves refusal only. The final source replaces an unavailable TypeScript exit
event alias with the identical inline payload type; the runtime receipt above
remains tied to its recorded in-flight fixture bytes.

Reproduction (Node 22 and the release validation mutex):

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  python3 /Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/with-validation-lock.py \
  /opt/homebrew/opt/node@22/bin/node ./node_modules/vitest/vitest.mjs run src/main/orch/native-heavy-aider.test.ts --maxWorkers=1

NEXUS_TEST_AIDER_APPROVE_ONCE=1 PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  python3 /Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/with-validation-lock.py \
  /opt/homebrew/opt/node@22/bin/node ./node_modules/vitest/vitest.mjs run src/main/orch/native-heavy-aider.test.ts --maxWorkers=1
```

## Primary artifact provenance and preconditions

- Aider entry: `/Users/cleofaspereirarocha/.local/share/uv/tools/aider-chat/bin/aider`,
  SHA256 `692dfbe49ed117d567642e4e104b9be08cc64634fa87a40af87f8bed64229e82`.
  Installed `run_cmd.py`: `f7e36948be2196a22775ffc43758e79967e35fbbc83db0e02a018f19102bd91c`;
  `io.py`: `7f62a79c8202f2a3793410bac4c983e417fb886513b90faf0e0579d5bb7d047b`;
  `coders/base_coder.py`: `a621097e9d258629f2d28f2f083fb772ba956017b9f7ea7535a40544b751d081`.
- Devin entry: `/Users/cleofaspereirarocha/.local/share/devin/cli/_versions/3000.11.3/bin/devin`,
  SHA256 `7ef3859e68d4eabc0115e51898fcd4eab1edde753c27a472349ef551180b38ff`.
  Public help declares `--config`, `auth status`, print/ACP and permission mode.
  The installed primary declares `DEVIN_API_URL`; no guessed authentication or
  backend protocol is accepted as a working control. Private evidence:
  `/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-devin-preflight-gxdjxd6w`.
- AGY entry: `/Users/cleofaspereirarocha/.local/bin/agy`, 175966448 bytes,
  SHA256 `7dca095cfc1df2c057a385ed88a76c7ba98dc103258a80be87a8f42e484cb3aa`.
  Installed primary declares `AGY_LLM_GATEWAY_URL`, `API_KEY`, `HEADERS`,
  `MODELS`, `WIRE_PROTOCOL`, `PROXY_URL`, `CA_CERT`, and private app-data paths.
  A loopback-allowed private attempt stopped at native eligibility/auth, before
  the intentional schema probe. An earlier bind EPERM came from the fixture's
  network restriction and is not a CLI/product failure. Private evidence:
  `/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-agy-gateway-schema-oqus7k84`.

The historical adapter matrix's unmeasured Aider entry is superseded by this
installed-PTY proof. Devin/AGY real tool admission remains open, as do the
canonical signed candidate controls. Shared Bash/Node tests do not close these
individual native CLI requirements.

## Native authentication follow-up

The initial Devin write-denied attempt is now explained: `tracing-appender`
panicked at `rolling.rs:154` / `chisel/main.rs:105`, reporting failure to create
its initial log file, before authentication. With writes allowed only to the
existing native `~/.local/share/devin/cli/logs` directory plus private cache/TMP,
native `auth status` exited 0 and confirmed Logged in. Network remained denied;
the native credentials file's inode/size/mtime were unchanged. Raw stdout (which
can contain identity) was discarded. Sanitized evidence:
`/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-devin-status-reason-tlxl6pby/status-log-allowed.json`.

AGY's existing `subscription-auth.ts` accessor invokes `security
find-generic-password -s gemini -a antigravity -w` against the native HOME, then
checks its payload in memory. That exact read-only accessor command exited 0
with a usable token payload; neither token nor raw output was stored or shown.
This establishes local auth availability, not entitlement or tool execution.
Evidence: `/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-native-auth-gateway-h4f358eq/agy-auth.json`.

The first Devin `DEVIN_API_URL` control timed out at 12 s with zero owned gateway
requests. The installed primary's auth-status text explicitly names the separate
`WINDSURF_API_SERVER_URL` override. Using that supported override reached three
POSTs to `/exa.seat_management_pb.SeatManagementService/GetUserStatus` (981-byte
protobuf bodies) and a POST to
`/exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents`.
Only method/path/body length/top-level field names were retained; header, query,
body, and identity values were discarded. The gateway returned 503 rather than
manufacturing eligibility. The CLI hit the 12 s ceiling before tool dispatch;
the native credential stat remained unchanged. Evidence:
`/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-native-auth-gateway-h4f358eq/devin-api-server-gateway.json`.

Devin's account-status protobuf and AGY's native eligibility remain precise
unproved boundaries. They are not missing-login claims, scheduler failures, or
product permission restrictions. Future session controls can reuse canonical
`prepareCheckoutProviderHome('devin')`, which provides private durable state and
links the exact source auth file without copying credentials; normal auth
lineage must remain in place.

## Actual authenticated Devin tool control

`native-heavy-devin-authenticated.test.ts` is explicitly opt-in. It uses normal
`--permission-mode dangerous`, actual `models list` (selected advertised
`deepseek-v4-pro-high`), canonical checkout credential links, owned PTY/supervisor,
and a 30 s physical ceiling per invocation. The model sees only the finite
Make/Node task; output/argv/credentials are not retained. Network is unrestricted;
the fixture protects original credential/config files from writes. No monetary
cap is asserted.

Private HOME baseline and scheduled CURRENT environment both passed, 1 test in
44.79 s: `/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-devin-auth-KfLDg6/receipt.json`.
Scheduled Bash/login-false actual exec admitted fresh job 39158 and borrower
39206, both allowed; the marker, physical PTY exit 0, natural Main claim `gone`,
grant/release, and zero cleanup stop calls were independently observed. Existing
BASH_ENV interception works for this actual CLI; no new provider hook was used.

Native HOME comparison is a preserved RED, not downgraded:
`/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-devin-auth-NHNjYr/receipt.json`.
Baseline produced the marker/exit 0. Scheduled startup Node job 42342 acquired
the sole build permit and admitted borrowers 42608/42798. Other startup jobs,
including 42344 (`@playwright/mcp`), and finite Bash/Make job 42897 waited behind
it; their actual admission replies were denied when the owner hit the 30 s
physical deadline (signal 9). The marker remained absent after all claimed jobs
were physically `gone` and before any cleanup stop (`stopCalls:0`). The first
Node's module was deliberately not retained in that receipt; a separate bounded
owned-process diagnostic is required to identify it. Native credential stat
remained unchanged in both controls. Both receipts bind source `d42842c93`,
in-flight fixture SHA256 `f8776d1f562489b9e6629dd89714941b60f18e9bfd4ff6ae4385a0e8a8d41e4f`,
and actual supervisor/CLI hashes.

This HOME difference can matter in production: `pty-manager.ts:2056` calls
`prepareCheckoutProviderHome`, whose Devin environment sets only XDG_DATA_HOME
(`managed-credentials.ts:752`), preserving incoming HOME absent later decoration.
The native profile autoloads MCP services. It is not dismissed as a fixture-only
configuration. Production recognition of persistent service/dispatcher processes
must be reviewed before closing this boundary.

Earlier `r1fT2M` is historical only: its queued-admission HTTP idle deadline
incorrectly remained active after request parsing, producing actual exec
`nexus-heavy: local admission request failed` / exit 74. The final fixture clears
that read timer after bounded parsing and records actual admission responses;
the native HOME RED above persists with this correction. A natural physical
claim barrier also precedes cleanup, so forced drain is not mistaken for normal
command completion.

Run only with explicit authorization for the small authenticated task:

```sh
NEXUS_TEST_DEVIN_AUTHENTICATED=1 PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  python3 /Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/with-validation-lock.py \
  /opt/homebrew/opt/node@22/bin/node ./node_modules/vitest/vitest.mjs run src/main/orch/native-heavy-devin-authenticated.test.ts --maxWorkers=1
# Add NEXUS_TEST_DEVIN_NATIVE_HOME=1 to preserve the native MCP startup regression.
```

### After F-907 and its npx-symlink follow-up (04/10, 22:3x BRT)

Both HOME cases are now green with the integration catalog. These controls ran
as one-shot launchd jobs, because the darwin PTY supervisor rejects launch from
inside a Nexus pane (exit 76, launch authorization before responsibility
disclaim); that rejection is environmental and is not counted as a result.

- F-907 alone (`995c27284` catalog): private HOME PASS (46.8 s,
  `nexus-c6-devin-auth-UVU2pV`); native HOME still RED (scheduled phase hit the
  30 s ceiling). The added sanitized argv diagnostic showed the four startup
  launchers as `node …/bin/npx -y mcp-remote|figma-developer-mcp|@playwright/mcp|firecrawl-mcp`:
  Node keeps the `bin/npx` link in argv[1], so the dispatcher rule keyed on
  `npx-cli.js` never matched and the generic Node rule gave each one a build
  permit (`nexus-c6-devin-auth-39qGtu`; scheduled-only diagnostic
  `nexus-c6-devin-auth-9f67XF`). One intermediate native run timed out already
  in the ungated baseline (`nexus-c6-devin-auth-3mswmA`): native MCP startup
  through `npx -y` makes this HOME noisy near the 30 s ceiling.
- Follow-up: `catalog.cjs` resolves an argv[1] named `npx`/`npm` to npm's own
  `npx-cli.js`/`npm-cli.js` before classifying (an unrelated file named `npx`
  stays metered). All four child services are recognized by the F-907 metadata
  rules (`mcpName` for firecrawl/figma/@playwright, the `mcp-remote` proxy name).
- Native HOME after the follow-up: PASS, 1 test, baseline and scheduled exit 0,
  marker present, only the finite Make job claimed (`darwin-job`, `gone`),
  `grant`/`release`, natural claims gone, `stopCalls` 0, native credential stat
  unchanged (`nexus-c6-devin-auth-XV8Rw4`).
- Private HOME repeated with the same catalog: PASS, baseline and scheduled,
  only the Make job claimed, credential stat unchanged (`nexus-c6-devin-auth-rnUSpo`).

The fixture now records sanitized launcher argv (basenames only, URLs and long
values redacted) for each claim and accepts `NEXUS_TEST_DEVIN_PHASES=scheduled`
to isolate the scheduled phase.

Final source checks: Node 22 `tsc --noEmit` exit 0, renderer sink audit 0
executable sinks, Main sync ratchet 91 reviewed legacy uses/no new synchronous
processes, and `git diff --check` exit 0. No production source changed.
