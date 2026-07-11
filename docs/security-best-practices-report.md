# NexusIDE Security Best-Practices Review

## Executive summary

The reviewed PREVC/autopilot changes preserve the existing fail-closed authority model and add material isolation improvements. No critical or high-severity vulnerability remains in the changed surface after remediation. The full test suite passes.

No software can truthfully claim compliance with “all security standards” without a named standard, deployment profile and external audit. This review applies the repository's TypeScript/React/Express guidance and the Nexus threat boundaries. Formal SOC 2, ISO 27001, OWASP ASVS or supply-chain certification remains separate work.

## Remediated findings

### SEC-001: validation processes could write to the checkout

- Severity: High
- Location: `src/main/context/sensor-broker.ts:267`; `src/main/runtime/process-sandbox.ts:365`
- Evidence: the sandbox plan was shared with mutable terminal commands and previously mounted/allowed writes to the project root.
- Impact: a compromised or incorrect sensor could alter the checkout while claiming to validate it.
- Fix: sensor plans now set `readOnlyRoot`; Seatbelt removes checkout write permission, Bubblewrap uses a read-only bind and Windows OCI mounts `/workspace` read-only. Only the private runtime remains writable.
- Verification: `process-sandbox.test.ts` proves root read-only/runtime writable behavior.

### SEC-002: Windows had no supported confinement provider

- Severity: High
- Location: `src/main/runtime/process-sandbox.ts:391`; `src/main/runtime/nexus-doctor-capability-checks.ts`
- Impact: accepting Windows without confinement would expose host files and network to autonomous validation commands.
- Fix: Windows now supports a fail-closed OCI provider with no network, read-only container root, dropped capabilities, no-new-privileges, PID/memory limits and an image pinned by SHA-256 digest. The Doctor verifies the runtime and local image; absent configuration remains a blocker.
- Verification: cross-platform plan and Doctor tests cover valid and invalid configurations.

### SEC-003: OCI mount option ambiguity

- Severity: Medium
- Location: `src/main/runtime/process-sandbox.ts:404`
- Impact: comma/newline characters in a checkout path could alter Docker's comma-delimited mount specification.
- Fix: ambiguous delimiters and NUL are rejected before the argv plan is produced. Runtime and image are separately constrained; no shell parses the command.

### SEC-004: autonomous workflow could finish an incomplete multi-task mission

- Severity: High
- Location: `src/main/orch/tools-context.ts:155`; `src/main/context/prevc-autopilot-policy.ts`
- Impact: leaving execution after the first merged worktree could validate only part of the requested mission.
- Fix: every mission task must be registered before the first worktree, the plan becomes sealed, each worktree must reference a planned task, and execution advances only when every planned task has an integrated worktree.
- Verification: deterministic policy tests cover empty, partial and fully integrated plans.

### SEC-005: automatic stall recovery needed exact session authority

- Severity: Medium
- Location: `src/main/orch/stall-watchdog.ts:107`; `src/main/orch/failover.ts`
- Impact: a recovery request directed at a stale or cross-project pane could restart the wrong process.
- Fix: recovery requires the exact owner, installation, project, checkout, mission, pane and session. It resumes the same account without keychain mutation and fires once after a second timeout.
- Verification: lifecycle tests cover colliding pane IDs, scope changes and exact-session recovery.

## Remaining hardening work

### SEC-R1: OCI image provenance

- Severity: Medium
- Status: Open
- Current control: immutable digest pinning prevents tag drift.
- Recommended next control: publish the Nexus sensor image with SBOM, vulnerability scan and Sigstore/cosign signature, then verify the signature before Doctor readiness.

### SEC-R2: formal compliance profiles

- Severity: Informational
- Status: Open
- Recommendation: define explicit profiles (for example OWASP ASVS L2 for the server and an Electron desktop threat model), produce traceable controls and commission an independent release audit.

### SEC-R3: long-running silent jobs

- Severity: Low
- Status: Accepted operational tradeoff
- Current control: alert at 10 minutes, recovery only at 20 minutes, exact-session resume, one recovery request.
- Recommendation: allow per-task timeout declarations for known long compilers or training jobs.
