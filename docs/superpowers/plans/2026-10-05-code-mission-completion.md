# Code mission completion implementation plan

**Goal:** A standard code mission, including one started from a pane without a squad, completes only with an independent frontier review and mechanical evidence for the current candidate.

**Architecture:** Extend the existing Main-owned automatic completion proof and reconciliation path. Candidate snapshots, review routing, mechanical checks, lifecycle flights and human override keep their existing owners. No squad, roster, branch switch, WIP cleanup, or new approval UI is introduced.

**Stack:** Existing TypeScript Main process, Vitest, candidate snapshot helpers and mission stores.

**Design authority:** The operator approved the design presented in the current session. The parent owns `tools-domain.ts` and `mission-engine-production.ts` wiring; this worker owns completion policy, proof and reconciliation helpers. Execute inline, without extra agents or commits.

## Contract and constraints

- The candidate comes from `captureWorkingTreeCandidate` in the mission execution scope; its base is Main-proved, never inferred from a model's prose or the current HEAD alone.
- Unknown baseline selects an explicit full-current-state snapshot and review, without a claim about authorship. An incomplete snapshot remains unverified with an actionable retry/explicit human completion path.
- A dedicated review binds mission, candidate fingerprint, HEAD and independent reviewer session. A changed candidate invalidates review and checks.
- Mechanical evidence must represent an executed applicable check. `unavailable` is not `passed`.
- Exemptions apply to Main-proved non-code/text-only work and existing ops authority. The explicit human completion override remains separate.
- No changes to shared contracts, runtime concurrency, branches, dependencies or UI without parent coordination.

## Steps

- [x] Define the Main-only policy/ports for candidate capture, independent review and structured mechanical results with the parent before production edits.
- [x] Write failing integration cases for standard missions with and without squad: prose, self-review, cheap review, stale candidate and unavailable checks cannot complete; an exact independent review plus passing checks can.
- [x] Implement the smallest helper and proof extension; expose results as `exempt`, `waiting`, `blocked` or `verified` for the existing coordinator.
- [x] Parent wiring: connect the exported verifier to the Main reviewer runtime and its mission/candidate ticket deduplication. The coordinator already reuses completion flights, preserves branded fingerprints and exposes actionable retry results.
- [x] Verify docs-only, read-only and ops cases; preserve initial WIP and support a fingerprint-bound full-state review when the baseline is unknown. Human override remains the parent's unchanged final-boundary authority.
- [x] Run focused Node 22 tests serially using an ABI-compatible test checkout; hand off the exact integration contract and changed paths for parent wiring and typecheck.

Validation: 175 tests passed across eight focused suites on Node 22, serial execution (2026-10-06). The integration fixture executes real candidate capture, static analysis, coordinator and production completion boundary; its frontier judge and process-check outputs are controlled fixtures, not claims of a paid-provider E2E run. Final runtime wiring and consolidated typecheck belong to the parent.

## Integration review — 2026-10-06

The production runtime now binds the review ticket to mission authority, execution
root, baseline, HEAD and candidate fingerprint. A rejected review returns concrete
findings to the current Maestro through the confirmed transport. Review panes close
only after their report is persisted; candidate changes invalidate approval. These
are source-level implementation claims, not release or real-provider E2E evidence.

Additional regression boundaries found during senior review:

- A standard mission without a squad must prefer its existing frozen Council just
  like a guided mission. The new free-mission case failed before the fix; all 78
  civilian-delivery tests passed afterward.
- An unchanged delivered artifact is part of the reviewed candidate; README-only
  changes cannot exempt a code artifact. Tracked build/vendor files remain covered.
- Missing tools, lockfiles, incomplete discovery and skipped E2E tests must not be
  converted to not-applicable checks. Existing inherited/base failures retain F-246.
- Final code verification must execute its applicable regression checks even when
  the optional fast worker regression gate is disabled.

Before integration: complete consolidated typecheck/tests, final independent review,
and confirm Main-owned mechanical processes respect the same RAM/heavy-command
budget as worker commands. Windows compiler launch must be checked without relying
on executing a `.cmd` file directly.

Before publication: collect the two external sessions' remaining deliveries, review
the resulting main commit, build the exact candidate, run packaged real-provider
missions from both entry points and record platform-specific evidence. Hosted CI is
currently blocked by the repository Actions budget; no Windows/Linux result is
inferred from macOS source tests.

### Mandatory Main checks and physical budgets

Strict completion injects the existing sandbox and owned-process launcher into compiler/audit sensors. Legacy sensor callers retain their current executor. The regression gate's default executor uses the shared heavy permit for every caller, including worker handoff and +Pane. Typecheck and audit run sequentially in strict completion so the audit's shorter deadline is not repeatedly spent queued behind its own compiler.

Each physical command consumes the same project/RAM permit as native validators. A bounded logical timeout returns retryable unavailability without consuming repair budget; permit and private HOME are retained until the independent physical-exit proof resolves. Late preparation after cancellation is disposed without spawning. No approval or inferred process exit is added.

Platform prerequisites are explicit: macOS requires the existing signed command supervisor; Linux requires Bubblewrap and its owned PID-namespace path; Windows requires the configured OCI runtime and digest-pinned image. Missing infrastructure is unavailable, never passing evidence. Windows compiler/config/report arguments are translated into the existing workspace/runtime mounts; external dependency paths are rejected rather than attributed to a mount. The OCI image must provide the runner executable selected by the existing sandbox mapping and compatible dependencies. Mocked cross-platform contracts and host tests do not constitute Windows/Linux hardware proof; run the platform smoke before claiming release parity.

### Native Go and Rust regression receipts

The existing regression gate now runs complete native suites alongside its existing JavaScript/Python impact selection. The root Go module, modules enclosing changed/delivered artifacts, and positively scoped go.work Use modules each run `go test -json -count=1 -p=1 -parallel=1 ./...`. Rust runs `cargo test --workspace --no-fail-fast --jobs 1 --message-format=json -- --format pretty --test-threads 1` with color disabled; `--locked` applies only when a lockfile exists. Positive TOML workspace membership deduplicates member manifests; excluded independent crates remain covered. Custom test harnesses without supported receipts remain explicitly unavailable (non-test benchmarks do not impose a test obligation).

Go requires paired per-case run/terminal events plus package completion and process status. Rust requires complete stable libtest blocks with matching case/result counts; Cargo compiler JSON is inventory, never passing test evidence. Zero executed tests never mean passed; successful compilation with complete applicability evidence may report no-tests/N/A. Skipped/filtered coverage, malformed/truncated reports, missing toolchains and timeouts cannot produce passing evidence. F246 reproduces the same Go package/test case on the actual baseline. Rust failure names alone do not prove target identity, so Rust failures remain unwaived with an explicit note until a target-bound receipt exists. A newly generated lockfile changes the observed candidate and requires a retry, rather than approval of the earlier snapshot.

Toolchain discovery is separate Main code (`native-regression-command`), with private caches/HOME and precisely scoped SDK reads. Execution reuses the owned heavy-command permit and sandbox. Coverage is the host platform/default feature configuration exercised by these commands, not proof of another OS or inactive feature. Native fixtures use fake executions; a separate real Rust SDK/HOME smoke supplements them without claiming packaged-app or cross-platform E2E coverage.

Format references: https://pkg.go.dev/cmd/test2json and https://pkg.go.dev/cmd/go ; https://doc.rust-lang.org/rustc/tests/index.html and https://doc.rust-lang.org/cargo/reference/external-tools.html#build-finished . Stable libtest pretty output is intentional: its JSON format remains unstable.

### Native execution evidence (macOS arm64, 2026-10-06)

The installed Rust SDK compiled and executed one real libtest in a private HOME,
then the same production command/environment/parser ran under the existing macOS
`buildScopedExecPlan` sandbox. Both reported the actual case, with private Cargo
cache and no HOME/Cargo credential-profile read grant.

A temporary official Go 1.27.1 arm64 SDK was checksum-verified before use. The
production command/environment/parser executed one real Go test under the same
macOS sandbox. A second real fixture used `go.work` with two modules: A's test
imported B successfully, and the Main discovery reported both module roots.
No Go installation or shell profile was changed.

These tests prove the SDK/cache/argv/parser path on this host. They do not prove
packaged Electron ownership, a real LLM mission, Windows, Linux, or 16/32 GB hardware.
Evidence logs are `/tmp/nexus-native-rust-sandbox-evidence.json`,
`/tmp/nexus-native-go-sandbox-evidence.json`, and
`/tmp/nexus-native-go-workspace-evidence.json`.

Primary contracts checked: [Go tests and cache](https://pkg.go.dev/cmd/go),
[test events](https://pkg.go.dev/cmd/test2json),
[Go workspaces](https://go.dev/ref/mod#workspaces),
[Cargo test selection](https://doc.rust-lang.org/cargo/commands/cargo-test.html),
[Cargo build JSON](https://doc.rust-lang.org/cargo/reference/external-tools.html#build-finished),
[libtest](https://doc.rust-lang.org/rustc/tests/index.html),
[rustup auto-install control](https://rust-lang.github.io/rustup/environment-variables.html),
and [Cargo cache/compiler variables](https://doc.rust-lang.org/cargo/reference/environment-variables.html).

### Consolidated source gate

On 2026-10-06, Node 22 executed 57 suites serially: **1,642 passed, one skipped**.
The skipped case requires an actual Linux PID namespace and its explicit runtime
flag; it is not a Linux compatibility pass. TypeScript completed with exit 0.
A SHA-256 manifest confirmed no candidate file changed during the test/typecheck
flight. Renderer-sink audit reported zero sinks; Main synchronous-process audit
reported no new uses (91 existing reviewed uses).

The initial broad run caught an incomplete `path-resolver` mock and a fixture
that failed to forward delivered `requiredPaths`. Both were corrected: ordinary
project config bytes can be reviewed and completed; protected provider config
remains a preserved delivery with no automatic claim that its bytes were reviewed.
The two affected suites then passed 87 tests before the successful broad rerun.

Independent review closed the tracked P1/P2 findings, including physical cleanup,
Go/Rust module boundaries and configuration confidentiality. Source verification
is complete for this candidate; the publication and packaged-mission checklist
above remains open. Logs: `/tmp/nexus-final-gate-57-v2.log`,
`/tmp/nexus-final-gate-typecheck-v2.log`, and
`/tmp/nexus-final-gate-v2-source-manifest.json`.
