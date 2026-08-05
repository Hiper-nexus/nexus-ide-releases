# Review Pass 2 — Nexus IDE 0.26.1 hotfix gate

**Reviewer:** REVIEW WORKER  
**When:** 2026-08-05 ~23:15 UTC  
**Scope:** re-audit of 245/249/248/252 landings + CI residual ruling + remaining blockers  
**Product code touched:** none  
**Prior:** Pass 1 → **BLOCK** (`6def8dd6` / sibling `34e7c853`)

---

## Verdict (Pass 2)

### **BLOCK** (narrower than Pass 1; queue still open)

Ship is closer. Several Pass-1 blockers are **closed by wiring**. What remains is a **short critical path** on the exact user flight (mid-stop + Retomar + handoff after mission dies) plus one **in-queue test red on the approval path**.

---

## 1. Wiring re-audit (requested landings)

| Claim | Commit(s) | Live call-site | Pass-2 |
|-------|-----------|----------------|--------|
| Approval loop (dialog before idempotent lane) | `664b534f` (+ wizard `cd621293`) | `renderer-mission-authority` → `approvalAlreadyCurrent`; `orch-ipc.ts:confirmMissionAuthorityChange` short-circuits when true; trust key uses **origin** roster hash after seal | **WIRED — CLOSED** |
| Mojibake LC_ALL/C beats LANG | `16a77ad3` (on `96b1be19`) | `pty-env-locale.ts` deletes broken `LC_ALL`/`LC_CTYPE`; `pty-manager.ts:512` | **WIRED — CLOSED** (closes prior MEDIUM-3) |
| Kickoff ceremony trim | `91cf7ab5` | `mission-dispatch-kickoff.ts` lean delivery branch only | **WIRED — CLOSED** (copy; suite pins retained) |
| Retomar: proof > classification | `24f98406` | `confirm-reopen-mission.ts` → `listMissionPanes` then `missionResumeRoute` | **WIRED for recordedPanes>0** |
| Wizard escape hatch | `5833077a` | `MissionWizard` `backToPanes` → softClose + `confirmAndReopenMission`; button only if `armedMissionSnapshot` | **WIRED — CLOSED (249 nav)** |
| Control-plane UI mirror | `845a8772` | `MissionResultDetail` → `MissionControlBoard` → preload `missionControlPlane` → same snapshot as MCP tool | **WIRED — CLOSED** |
| Cap/phase visibility (248) | `0531a95e` (+ board pulse) | `wave-concurrency-verdict` binding `adaptive` vs `configured`; production passes `contractCap`; pulse names sequential phase | **WIRED — CLOSED** (visibility; does not raise Hardened cap by itself) |
| CI platform/sandbox | `bb0a2efe` | `.github/workflows/ci.yml` bubblewrap + node pin; `runIf(darwin[/arm64])` on mac-only tests | **WIRED** (fixes the 100% red class; see §2 for residuals) |
| Stop reason on rail (254 partial) | `e35fb1a8` | `MissionRail.missionMeta` → `missionStopReason` before `Retomar · date` | **WIRED but EVIDENCE-WEAK** — see B-254 residual |

### In-flight (dirty tree at pass time — **not** release-landed)

| WIP | Files | Intent |
|-----|-------|--------|
| B-246 plannedWork | `mission-resume-route.ts`, `confirm-reopen-mission.ts` (dirty) | `plannedWork` from `missionControlPlane.queue.length`; stay+notice if plan exists with zero panes |
| B-244 handoff after mission dies | `worker-handoff-enforcement.ts` (dirty) | remove `missionRunning` gate; mission state becomes diagnostic note only |
| Stall probe escalate | `stall-watchdog.ts` (dirty) | probe mute worker + escalate after grace |
| Adaptive ladder tests | `adaptive-wave-ladder.test.ts` (untracked) + scheduler dirty | 248 follow-through |

With dirty B-246: `mission-resume-route.test.ts` **9/9 green**. On clean HEAD without that WIP, the new `plannedWork` suite would still fail (type field existed in WIP before body landed fully). **Do not count B-246 closed until commit.**

---

## 2. RULE: do the “6 pre-existing CI failures” BLOCK 0.26.1?

### Ruling: **NO — they do not block product correctness of this hotfix**

**They are inherited CI debt.** Document and fix on a separate track (or the next patch). They do **not** gate “are the 0.26.1 user bugs fixed?”

### How this was judged (aligned with your 0.25.1 precedent)

| Question | Answer |
|----------|--------|
| Did the hotfix **introduce** them? | No — worker 252’s class of reds (macOS/arm64 codesign tests on ubuntu, missing bubblewrap) existed since the workflow was born; `bb0a2efe` addresses that class. |
| Are they **in the release path of the hotfixed surfaces** (voice, approval, resume, handoff, locale, black pane, control board)? | **Not as claimed residuals.** Precedent from 0.25.1 was: reds **of the shipping fix path** must be fixed, not waived. Inherited platform/env debt outside that path is not the same thing. |
| Does a red GitHub `check` job still hurt? | Yes for **automation pride / merge hygiene**. Use the **hotfix fast lane + durable waiver** (`1e74ecfd` / `45da98f5`) if you must tag before the debt track closes — do **not** pretend green. |

### Caveat (still a release-process note, not a “6 debt” note)

One failure **is** on the hotfix surface and **does** block until fixed or proven fixture-only with a replacement assertion:

- **HIGH-T1:** `MissionWizard guided approval handoff > deduplicates approval…` still **red** on current tree (reproduced Pass 2: toast `Missão iniciando` never fires). Sibling review bisected to `cd621293` + missing `approvedAt` on mock. This is the **only automated cover of approve → toast → bootstrap**. Same spirit as 0.25.1: **fix the fixture / assert sealed mission**, do not ship with this red.

If worker 252’s “6 remaining” **includes** HIGH-T1 or any other test of a land fix, those specific ones **do** block. The other five, if platform/env/unrelated modules, **do not**.

I could not re-list the exact six post-`bb0a2efe` on `main` remote (local queue is unpushed; last remote CI runs predate the hotfixes). Owner 252 should paste the six names into the waiver/debt ticket.

---

## 3. Severity list (updated)

### CRITICAL — block tag

| ID | Owner | Status | What remains |
|----|-------|--------|--------------|
| **B-246** | 246 | **OPEN** (partial land + WIP) | Landed: proof-first when `recordedPanes>0` (`24f98406`); rail CTA for observed runtime (`172d5b7b`); wizard back (`5833077a`). **Open:** real flight had **`mission_panes` empty** + sealed plan (8 tasks). WIP adds `plannedWork` + control-plane queue read — **must commit + wire call-site only**; also kill residual wizard shortcuts when `specs.length===0 && isIntentFirstMissionShell` after route already said stay. |
| **B-254 residual** | 254 | **OPEN (severity land)** | `e35fb1a8` module is sound and **MissionRail imports it**, but `hasObservedRuntime` is computed from **live** `paneMissions` / layout panes (`MissionRail.tsx:435-441`, `:863`). After panes are reaped that count is **0**, so `missionStopReason` returns **null** even when a **blocked handoff with full summary** exists — the exact HiperGO card failure. Fix: observe runtime from durable panes **or** any handoff/plan evidence, not layout alone; surface `nextAction` too (today only `reason` is clipped into meta). |

### HIGH — block tag

| ID | Owner | Status | What remains |
|----|-------|--------|--------------|
| **B-244** | 244 | **OPEN** (core landed; residual is the user scenario) | Landed: `initWorkerHandoffEnforcement` in `orch-ipc`. **Residual you named is correct:** `decideQuietWorker` on **committed** code still gates on `mission.status === 'running'`. Dirty WIP removes that gate — **commit it**. Stall probe/escalate also dirty. |
| **HIGH-T1** | 245 / tests | **OPEN** | `MissionWizard.test.tsx` “deduplicates approval…” red. Fixture must return sealed approved mission (`approvedAt` + post-seal version). |

### CLOSED since Pass 1 (do not re-drive)

| ID | Notes |
|----|-------|
| Approval re-prompt loop (245) | `664b534f` + `cd621293` dual layer |
| B-249 nav contract | `24f98406` + `5833077a` |
| 248 silent cap=2 | `0531a95e` + control board pulse (visible verdict; Hardened ladder behavior unchanged by design) |
| 252 CI class (darwin/bubblewrap) | `bb0a2efe` |
| UTF-8 LC_* residual | `16a77ad3` |
| Kickoff negative wall | `91cf7ab5` |
| Control-plane human mirror | `845a8772` |

### MEDIUM / LOW (notes only)

| ID | Note |
|----|------|
| M-smoke-operator-lane | Packaged dictation smoke still does not prove operator-lane **accept** (only terminal + reject) — ship-with-note |
| M-hold-250ms | Document Space hold threshold |
| M-board-location | Control board is on mission **detail**, not grid chrome |
| L-param-dead | `plannedIntentVersion` unused in `wizardApprovalOutcome` |

---

## 4. Remaining blockers for owners (crisp)

Drive **only** these for release:

1. **246 — commit + finish Retomar for sealed-plan / empty `mission_panes`**  
   - Land dirty `plannedWork` path.  
   - Prove call-site always passes queue length (not optional).  
   - No wizard when plan/handoff/runtime evidence exists.  
   - Acceptance: replay mission-3be48989 state → click never opens Nova Missão; stay/notice or panes; plan visible.

2. **254 — WHY must use durable evidence**  
   - `hasObservedRuntime := durable panes > 0 OR handoff exists OR plannedWork > 0` (not layout-only).  
   - Card shows handoff summary (or explicit “nenhum relatório”) + next step.  
   - Acceptance: same flight card shows worker blocked text, not `Retomar · date`.

3. **244 — handoff guarantee survives mission self-stop**  
   - Commit removal of `missionRunning` ignore gate.  
   - Land stall probe → escalate.  
   - Acceptance: mission leaves `running` while worker silent → synthetic handoff still appears with mission-state note.

4. **HIGH-T1 — green the approval handoff test**  
   - One fixture fix; keep it as lock for the loop bug.

5. **252 debt track (non-blocking product)**  
   - Name the six residuals; ticket; optional fast-lane waiver if tagging before debt clears.  
   - Do **not** hold 0.26.1 user fixes hostage to unrelated suite debt.

---

## 5. User-acceptance delta (add to release notes)

| Action | Expect after 0.26.1 (once blockers closed) |
|--------|-----------------------------------------------|
| Re-approve live mission | No infinite native dialog; trust checkbox survives squad seal |
| Finder launch + PT prompt | Correct accents (LANG + no LC_*=C) |
| Retomar mid-stopped mission | Panes or stay+plan notice — **never** goal wizard if plan/work exists |
| Card of stopped mission | Shows **why** (handoff text) + what to do |
| Silent worker after mission dies | Still produces handoff evidence |
| Mission detail | Control board names adaptive cap / sequential wait |
| Wizard over armed mission | **‹ Voltar aos panes** returns to work |

---

## 6. Final statement

**Pass 2 verdict: BLOCK**

Not because the queue failed — because the **two CRITICALs you named are still not closed on landed commits** (246 residual + 254 evidence bug), **244 residual matches the user failure and is still dirty**, and **HIGH-T1** keeps the approval path’s only e2e-ish unit test red.

**CI “6 leftovers” after 252: do not block product correctness of 0.26.1**; treat as inherited debt / waiver candidates. **Do** block on HIGH-T1 and any residual that is actually on a hotfix path.

Next: Pass 3 when 246/254/244 commits land — expect possible **APPROVE-WITH-NOTES**.

*End Pass 2.*
