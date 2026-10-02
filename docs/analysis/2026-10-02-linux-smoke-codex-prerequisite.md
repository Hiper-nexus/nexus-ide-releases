# Linux packaged smoke: real Codex prerequisite

## Failure and cause

Linux preview run [36968857288](https://github.com/Hiper-nexus/nexus-ide/actions/runs/36968857288), job `110718402591`, selected source `e860b15faea4a5856475dd703fc30fd9f642254d`. The compiler, source tests, browser Electron smoke, and DEB/RPM/ZIP makers completed. The first packaged application then failed `mission-prepare`: `Codex não está instalada ou o binário não está executável.`

At that source, `src/preload/functional-smoke.ts` uses a Codex roster and invokes the real `orch:mission.prepare` IPC. `src/main/orch/mission-orchestrator-runtime.ts` rejects an adapter whose `installed` flag is false. The Codex builtin declares external command `codex` and npm installation; `adapter-registry.ts` obtains installation state from `path-resolver.ts`, which discovers executable files on PATH. Forge does not bundle Codex. The Linux workflows provided no Codex prerequisite. The Windows workflow already installs native Codex `0.145.0` before its packaged smoke.

This is a missing Linux CI prerequisite. The evidence does not establish a Darwin Codex binary shipped inside the Linux application or justify changing production discovery, readiness, or mission authority.

## Correction

Both Linux workflows install the same real provider version before package runtime smoke. `scripts/install-linux-smoke-codex.mjs` downloads the official native Linux x64 package directly, bounds its byte count, verifies the pinned npm SHA512 before extraction, checks package identity and executable ELF architecture, checks the native SHA256, and runs native `--version` in a separate empty home without credentials. The installer publishes only its dedicated package root and native bin directory through the runner environment/PATH. It emits an independently named prerequisite receipt, outside the production Linux publisher contract.

The Debian smoke mounts only that pristine native package root read-only, with an explicit PATH. It checks the same binary hash and executes `--version` as UID 10001 before either installed-DEB or extracted-ZIP smoke. The workspace and Node mounts remain read-only. No runner home, provider profile, npm cache, or broad runner temporary directory is mounted.

The functional mission gate remains in place. No fake CLI, provider login, inference call, or readiness bypass is added. The dependency is installed in the CI environment, outside the distributed application. Linux users must still install and authenticate their selected provider CLI.

| Authority | Exact value |
| --- | --- |
| CLI version | `0.145.0` |
| Native npm package | `@openai/codex@0.145.0-linux-x64` |
| Native target | `x86_64-unknown-linux-musl` |
| Native archive bytes | `135637111` |
| Archive SRI | `sha512-u8w8LLv3DvsfrDCoswLIemZ0SoNEXyi511WsfFsSiYUazk9qMsB/NtU8N9vhAfN7mZAxLFoMex4v66JjHuZWwA==` |
| Official matching archive SHA256 | `11239480f8e3efd1430f23bbe91c1a397856b8bbe6185ccbaee2382d25e03df2` |
| Native binary SHA256 | `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14` |
| Native executable | `vendor/x86_64-unknown-linux-musl/bin/codex` |
| Version output | `codex-cli 0.145.0` |

Primary integrity sources: [npm native metadata](https://registry.npmjs.org/@openai%2fcodex/0.145.0-linux-x64), [npm wrapper metadata](https://registry.npmjs.org/@openai%2fcodex/0.145.0), and [OpenAI release asset digest](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.145.0). The downloaded registry archive independently matched both npm SRI and the official GitHub asset SHA256. All eight entries were regular files under `package/`, without links, scripts, or traversal. The native binary is static PIE ELF64 x86-64 and returned exit 0 with the pinned version under Node `22.23.2`.

## Verification and limits

Focused tests reproduced the absent workflow prerequisite and absent Debian mount before the change. After the correction, 20 focused tests passed: installer integrity/platform/executable rejection, workflow ordering and existing publisher separation, and the Debian Docker host boundary. The installer test uses the system `true` executable only to prove rejection of an unrelated ELF, never as a successful provider prerequisite.

A local offline installation of the actual pinned archive passed all native checks. The exact failing-source production resolver was also executed: with empty PATH it returned `null`; with the verified native bin directory it returned the exact executable via `process-path`. This reproduction preserves the production resolver and uses the real Linux native CLI.

The complete packaged mission/persistence and Debian install gates require a new Actions run with the correction. Local unit and native-version checks do not establish provider authentication, agent inference, Bubblewrap confinement, a Hyprland session, or Omarchy desktop operation. Release dispatch still requires a source tag containing the relevant workflow/tooling; older tags do not acquire this fix.

The existing QA index remains unchanged; this workflow prerequisite evidence is recorded here without allocating an exhausted finding ID.
