# Review Pass 1 — Nexus IDE 0.26.1 hotfix gate

**Reviewer:** REVIEW WORKER (fresh session)  
**When:** 2026-08-05 ~23:08 UTC  
**Branch:** `main` (local, unpushed; ahead ~20 of `origin/main` at pass time)  
**Scope:** wiring / regression / severity / user-acceptance map only  
**Product code touched by this reviewer:** none  
**Verdict status:** **QUEUE OPEN — NOT APPROVE** (partial pass; blockers remain)

---

## Orientation

```
HEAD at pass start (landed, sample): 45da98f5 … 61f91fb1
v0.26.0 tag ancestor: d541d553 chore(release): bump to 0.26.0
```

Same-night hotfix after real-flight bugs on 0.26.0. Several sibling workers still writing (dirty tree at pass time — see §Still landing).

---

## 1. WIRING AUDIT (live call-sites, not unit-green alone)

| Fix | Commit(s) | Live call-site | Wired? |
|-----|-----------|----------------|--------|
| Dictation → operator lane on governed panes | `61f91fb1` | `voice-run-jarvis-turn.ts:365-378` → `deliverDictation` → `deliverOperator` → `submitPromptToPaneOperatorInput` | **YES** |
| Dictation mandatory packaged smoke | `47eb2db1` | `functional-smoke.ts` probe `dictation-delivery`; type in `smoke-types.ts` | **YES** |
| Approval loop — wizard post-seal | `cd621293` | `MissionWizard.tsx` (~1885) `wizardApprovalOutcome(...)` | **YES** |
| Approval loop — skip re-prompt when already current | `664b534f` | `renderer-mission-authority.ts` sets `approvalAlreadyCurrent`; `orch-ipc.ts:confirmMissionAuthorityChange` (~870) short-circuits native dialog | **YES** |
| Black orq pane backstop | `02f41b13` + `9bdc4716` | `terminal-host.ts` adoption path (~731-754) `repaintAdoptedFrame` + local tape | **YES** |
| Packaged UTF-8 mojibake | `96b1be19` + `16a77ad3` | `pty-manager.ts:512` `ensureUtf8Locale(env)`; drops `LC_ALL`/`LC_CTYPE=C` | **YES** |
| Worker handoff guarantee | `4ded5947` | `orch-ipc.ts` `initWorkerHandoffEnforcement()` / `shutdownWorkerHandoffEnforcement()` on orch start/stop | **YES** |
| Control-plane snapshot (P1-0 s1) | `80ef0754` | `orch-ipc.ts` IPC handler; `tools-panes.ts` MCP tool; preload channel | **YES** |
| Control-plane human board (P1-0 s2) | `845a8772` | `MissionResultDetail.tsx:306` `<MissionControlBoard />` | **YES** |
| Space hold-to-talk | `954b1ae3` | `voice-window-ptt.ts` imports `HoldToTalkDiscriminator`; threshold before `onStart` | **YES** |
| Rail: stopped mid-flight not sold as fresh goal | `172d5b7b` | `MissionRail.tsx` passes `hasObservedRuntime` into `railStatusDisplay` + `missionRailResumeCopy` | **YES** (label/copy only — see residual) |
| Retomar → panes by evidence | `24f98406` | `confirm-reopen-mission.ts:101-109` → `missionResumeRoute` before any wizard path | **YES** (with residual hole) |
| Scheduler concurrency verdict | `0531a95e` | `mission-scheduler.ts` / production path | **YES** (internal visibility) |
| Hotfix fast-lane / security seal | `afb6aa98` `1e74ecfd` `45da98f5` | release scripts / gate plan | **YES** for gate machinery; not a runtime UX fix |
| Idle-survival audit | `c2c4d835` | docs only | N/A (analysis, not a fix) |

**No “plumbed but dead” found among the landed runtime fixes above.** Dual approval layers (renderer wizard + main dialog) both call real consumers.

---

## 2. REGRESSION RISK (surfaces that burned 0.26.0 today)

| Surface | Risk | Notes |
|---------|------|-------|
| PREVC / approval sealing | **HIGH residual** | IntentVersion bump after seal is now tolerated (`wizardApprovalOutcome`). Trust / already-current short-circuit must not skip a **material** goal change — covered for goal string, not for roster/plan content drift beyond seal. Promote + experimental still force native dialog (good). |
| PTY write / operator lane | **MEDIUM** | Dictation falls back terminal → operator. False-green path removed. Risk: operator lane reject still surfaces as HUD failure (correct) but may feel “dictation broken” if authority stamp stale. |
| Voice / Space | **MEDIUM** | Hold threshold 250ms; auto-repeat becomes typing. Risk: very fast “hold” talkers may emit a space instead of arming; inverse of the 0.26.0 bug. |
| Terminal adoption repaint | **MEDIUM** | Local tape rewrite can show a **stale** frame if provider later redraws differently; better than permanent black. Bound 256KB. |
| Locale UTF-8 | **LOW** | Only fills broken C/POSIX; legitimate user UTF-8 preserved. Windows no-op (codepage path separate). |
| Mission lifecycle / handoff | **HIGH residual** | Enforcement only acts while `mission.status === 'running'` (`worker-handoff-enforcement.ts:257-258`, `decideQuietWorker`). If the mission flips off `running` **before** the quiet ladder runs, exit/idle paths return `ignore` → **silent hole returns**. Synthetic author prefix excluded from “real handoff” (good). Nudge uses bracketed paste + idle guard (aligned with idle-delivery). |
| Resume / Retomar | **CRITICAL residual** | See §3. `isIntentFirstMissionShell` still true for `awaiting_approval` (`mission-reopen.ts:80-89`). Route protects when `recordedPanes > 0` (durable `mission_panes` store helps). Empty composition still opens wizard. Copy “Ver por que parou” overpromises a WHY surface the click does not open. |
| Fan-out / drain / terminality / clean quit | **MEDIUM** | Handoff synthetic `blocked`/`failed` can unblock orch waiting forever (good for terminality). Risk: synthetic handoff may be treated as real progress by a naive orch brief — summary text is explicit that result is unknown. |

### Operator observation (MCP to every worker)

Overclock injects its MCP surface into worker panes, not only the orchestrator. Nexus already does the analogous thing for **gated** mission panes: `mcp-server.ts` builds a per-token config and applies it for both `orchestrator` and `worker` roles (ephemeral HOME / `--mcp-config` / non-Claude inject). That is required for `nexus_handoff_submit` and control tools. **Not a regression by itself.** Remaining audit for worker 244 should confirm **hooks** (Stop-hook parity) and that worker MCP profile is intentional strict-nexus, not operator-home connector bleed (already partially hardened via `--strict-mcp-config` on gated panes).

---

## 3. SEVERITY — open blockers & notes

### CRITICAL (block release until closed)

| ID | Issue | Evidence |
|----|-------|----------|
| **B-246 residual** | Mission that **stopped mid-flight** still has a path to the **new-mission / goal wizard** when durable pane composition is empty; rail CTA text claims “ver o motivo” but click does not open a stop-reason surface — it reopens / may eject. Real flight 05/08 was exactly data-loss-by-UI. | `mission-reopen.ts:isIntentFirstMissionShell` includes `awaiting_approval`; `mission-resume-route` → wizard if `recordedPanes===0 && isArmedShell`; `missionRailResumeCopy` only changes strings (`172d5b7b`). |
| **B-254 not landed** | Mission self-terminates / stops with **no durable user-visible WHY**. Handoff enforcement helps only the quiet-worker subclass while status is `running`. | Worker 254 still in queue; no `stopReason` projection found on mission rail / result detail for lifecycle close. |

### HIGH (block release)

| ID | Issue | Evidence |
|----|-------|----------|
| **B-249 partial** | Navigation contract “always a way back from wizard to panes” is **still uncommitted** at pass time (`MissionWizard.tsx` dirty + `MissionWizard.back-to-panes.test.tsx` untracked). Without it, any residual eject leaves the operator in a cul-de-sac. | `git status` at 23:08Z |
| **B-244 residual** | Handoff guarantee ignores non-`running` missions; quiet worker after premature mission terminal state does not enforce. Stall auto-probe / guaranteed wake receipt need confirmation beyond this module. | `decideQuietWorker` + `missionRunning` gate |
| **B-252 / CI** | CI red on main — `ci.yml` dirty (Node pin + bubblewrap). Must be green before tag. | dirty workflow |

### MEDIUM (notes — do not alone block if CRITICAL/HIGH clear)

| ID | Issue |
|----|-------|
| M1 | Hold-to-talk 250ms may feel sticky for power users; document in release notes. |
| M2 | Adoption repaint can flash stale frame. |
| M3 | Control-plane board lives on **MissionResultDetail** — operator must open mission detail, not the grid alone. |
| M4 | Kickoff copy rewrite (affirmative Main ownership) still dirty in tree — good UX intent; verify suite pins still green after land. |
| M5 | Engine parallelism (248) not reviewed — still landing. |

### LOW

| ID | Issue |
|----|-------|
| L1 | Idle-survival audit is docs-only; no runtime change claimed. |
| L2 | Fast-lane release machinery is gate-only; no user-facing path. |

---

## 4. USER-ACCEPTANCE MAP (→ release-notes verification section)

Do these **after installing 0.26.1**, not in dev-from-shell alone where noted.

### A. Voice / dictation (0.26.0 regressions)

1. **Hold Space (≥ ~250ms)** on a focused governed agent pane → speak a short PT phrase → release.  
   **Expect:** text lands in the pane (operator lane if terminal lane refuses); HUD success only if delivery confirmed.  
2. **Tap Space once** in the same pane.  
   **Expect:** a single space character; **no** Jarvis/dictation HUD flash.  
3. Packaged app only: run functional smoke / launch probe.  
   **Expect:** probe `dictation-delivery` present and green.

### B. Approval loop

1. Start a mission, approve once, let bootstrap run.  
2. Re-click Start/Approve while mission is already `dispatched`/`executing`.  
   **Expect:** **no** native “Aprovar esta missão…?” loop; dialog does not reappear for same live authority.  
3. Change the **goal text** materially and re-approve.  
   **Expect:** re-prompt / rejection path still works (`goal-changed`).

### C. Black orchestrator pane

1. Open a multi-pane mission; force or wait for **headless adoption** of the orch pane (the path that used to paint black).  
   **Expect:** orch pane shows content within ~1.5s after adopt (local tape backstop), not permanent black.

### D. Packaged UTF-8 (must use .app from Finder, not terminal)

1. Launch the **packaged** app from Finder.  
2. Dispatch a mission with Portuguese goal (missões, não, em-dash).  
   **Expect:** child CLI shows correct glyphs, not `miss√£o` / `n√£o` / `‚Äî`.

### E. Handoff silence (partial until B-244 residual closed)

1. Spawn a worker that finishes work and goes idle **without** calling `nexus_handoff_submit`.  
   **Expect within ~20s:** nudge text with `[NEXUS_HANDOFF_REQUIRED]` in the worker pane.  
2. Still silent after ~45s more.  
   **Expect:** synthetic handoff `blocked` reaches the orchestrator with tail excerpt; mission does not wait forever with zero proof.

### F. Retomar / stop UX (partial — **do not claim full pass until B-246/B-254 closed**)

1. Reproduce mid-flight stop (blocked handoff / dispatch terminal / panes closed) with **prior runtime**.  
   **Expect rail pill:** `Parou — aguarda você` (not generic “Aguarda você”).  
2. Click the mission.  
   **Expect:** **panes** (or mission detail with preserved plan/work), **never** a blank “Nova Missão / definir objetivo” restart.  
3. **Still required for full accept:** a visible **WHY** (handoff summary / stop reason) without retyping the goal.

### G. Control-plane mirror

1. Open mission result / detail for a running multi-worker mission.  
   **Expect:** Mission Control Board shows pane/worker pulse (not empty forever).  
2. From an agent: MCP `nexus_mission_control` (or current tool name) returns one-shot snapshot.

### H. Wizard escape hatch (lands with 249)

1. Open assistente over an **armed existing** mission that has panes.  
2. Click **‹ Voltar aos panes**.  
   **Expect:** soft-close + return to panes view; no dead-end.

---

## 5. STILL LANDING (do not treat as shipped)

| Worker | Topic | At pass time |
|--------|-------|--------------|
| 244 | Handoff guarantee extras + MCP/hooks audit | Core enforcement **landed**; residuals above |
| 246 | Silent stop + Retomar data-loss | **Partial** rail copy + resume route; WHY + empty-composition hole open |
| 249 | Control-plane nav / never eject | **Uncommitted** back-to-panes UI |
| 248 | Engine parallelism | Not reviewed |
| 251 | Release gate / hotfix fast lane | Plan/classifier/seal commits landed; end-to-end gate run not witnessed here |
| 252 | CI red on main | `ci.yml` dirty |
| 254 | Lifecycle: no silent stop | **Not landed** as a closed product surface |

Dirty (sibling workers, ignore for this commit):  
`MissionWizard.tsx`, `MissionWizard.back-to-panes.test.tsx`, `mission-dispatch-kickoff.ts(+test)`, `.github/workflows/ci.yml`, `darwin-pty-supervisor.test.ts`, `launch-wizard.css`, `.agents/`.

---

## 6. FINAL VERDICT (Pass 1 — queue open)

### **BLOCK** (provisional until queue closes)

Exact blockers to clear before **APPROVE** / **APPROVE-WITH-NOTES**:

1. **B-246 residual (CRITICAL):** Retomar a mid-stopped mission must **never** open the new-goal wizard when the mission has observed runtime / sealed plan / commits — including when live panes are gone. CTA must match action; surface **why it stopped**.  
2. **B-254 (CRITICAL):** Durable, user-visible stop reason on self-termination / lifecycle close.  
3. **B-249 (HIGH):** Land and wire “Voltar aos panes” (currently dirty only).  
4. **B-244 residual (HIGH):** Handoff enforcement must not no-op solely because mission left `running` first; confirm stall probe + wake receipt end-to-end.  
5. **B-252 (HIGH):** CI green on the release revision.

**What already looks shippable once blockers clear (wiring verified):**  
dictation operator lane + packaged smoke, dual approval loop fix, black-orq local-tape repaint, UTF-8 child locale, hold-to-talk Space, control-plane snapshot+board, core quiet-worker handoff ladder (with residual).

### Next passes

- Re-run this checklist as commits land; append Pass 2+ under the same file or `…-pass2.md`.  
- When queue closes: re-state **APPROVE / APPROVE-WITH-NOTES / BLOCK** with only remaining exact blockers.  
- Do **not** push. Product code not touched by this worker.

---

## Appendix — commit inventory reviewed (origin/main..HEAD at pass)

Includes (non-exhaustive order):  
`61f91fb1` voice operator lane · `47eb2db1` smoke dictation · `cd621293` prevc seal outcome · `02f41b13`/`9bdc4716` orq repaint · `96b1be19`/`16a77ad3` PTY UTF-8 · `80ef0754`/`845a8772` control plane · `c2c4d835` idle audit docs · `4ded5947` handoff enforcement · `664b534f` approval already-current · `0531a95e` scheduler verdict · `24f98406` resume route · `172d5b7b` rail stopped copy · `954b1ae3` hold-to-talk · release fast-lane commits.

*End Pass 1.*
