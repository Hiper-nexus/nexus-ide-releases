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

Final source checks: Node 22 `tsc --noEmit` exit 0, renderer sink audit 0
executable sinks, Main sync ratchet 91 reviewed legacy uses/no new synchronous
processes, and `git diff --check` exit 0. No production source changed.
