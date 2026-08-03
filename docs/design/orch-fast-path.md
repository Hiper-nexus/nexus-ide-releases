# ADR — Orch Fast Path (velocidade real vs Overclock)

**Status:** Accepted  
**Date:** 2026-08-03  
**Branch:** `feat/mission-wave-pack`  
**Owner:** orchestration  
**Cross-ref:** `docs/design/mission-wave-pack.md`, `docs/analysis/2026-08-02-overclock-124-distill.md`

## Context

Overclock feels faster because **brief → first writable pane** is short.
Nexus kept Guided PREVC (freeze, Doctor, fence) on the critical path even when
Wave Pack already opted out at the authority layer — bootstrap still called
`ensureMissionPrevc` for every non-fanout topology, including `wave-pack`.

Vibe-coding feature work (`risk=normal`) does not need the full PREVC ceremony
before the first PTY. Sensitive/destructive work still does.

## Decision

1. **`missionRequiresGuidedPrevc`** is `false` when:
   - topology is `wave-pack` or `team-read-only-fanout`, **or**
   - `intentContract.risk === "normal"` (fast path product default)
2. **Bootstrap / opportunistic PREVC** only run when `guidedPrevcRequired`
   is true — never keyed solely on `!isTeamReadOnlyFanout`.
3. Setting **`orch.fastPath`** (default `true`) is the kill-switch surface for
   operators who want PREVC on every standard mission again (`false` restores
   legacy: normal risk still requires PREVC when Guided authority applies).
4. **Keep before first writable pane:** dispatch authority, plan seal,
   mission-runtime squad pin, attachments, worktree, MCP bearer, credential
   probe (login). OS process sandbox and agent attestation crypto are
   **Hardened opt-in** (`squadCliPolicy=governed`, `agentAttestationGate=required`).
5. **Autopilot (default) copies Overclock order:** no Seatbelt pre-requisite,
   no attestation crypto on handoff, YOLO/network on; orchestratorRuntime
   cosmetic drift warns instead of re-approving.

## Consequences

- Feature missions (normal) spawn and mutate without PREVC fence / Maestro
  freeze ceremony; ownership + merge queue remain.
- Sensitive/destructive keep Guided PREVC.
- Wave Pack no longer pays a free PREVC freeze at bootstrap.
- Tests that assumed `risk=normal` ⇒ PREVC must be updated.

## Non-goals (this change)

- Soft-status cross-CLI hooks
- Hibernation
- Wizard mode toggle UI (resolver already supports `forcedMode`)
- Cutting squadRevisionHash / runtime equality (still protect in-flight missions)

## Review fix log (2026-08-03)

| Gap | Fix |
|-----|-----|
| Kickoff taught PREVC/ACK/done on fast-path delivery | `standardStateLines` / `standardSequenceLines` treat `topology=delivery` + `guidedPrevcRequired=false` as Main-owned motor (no ceremony) |
| Vacancy showed `prevc_freeze` when skipped | Bootstrap emits `prevc_freeze` only when `guidedPrevcRequired` |
| Pack peers ignored files across missions | `exclusiveOwnershipOverlap` relaxes Pack inventory only when `sameMission` |
