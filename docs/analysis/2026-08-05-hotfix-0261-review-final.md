# Review FINAL — Nexus IDE 0.26.1 hotfix gate

**Reviewer:** REVIEW WORKER  
**When:** 2026-08-05 ~23:20 UTC  
**Tree:** `main` clean (ahead of origin; only `?? .agents/`)  
**Product code touched by reviewer:** none  
**Evidence this pass:** call-site greps + **134/134** green on gate-critical unit files; full orch/voice suite counts claimed by workers (3252 / 587) accepted as owner reports

---

## FINAL VERDICT

# **APPROVE-WITH-NOTES**

No remaining **CRITICAL** product blockers on the named user regressions.  
No remaining **HIGH** product openers among B-244 / B-246 / B-254 / 245 / 248 / 249 / black-orq / locale.  
Release may proceed under the notes in §Rulings and §Notes. Tag only after the operator completes the **user-acceptance map** for voice hold (note 2) and records the CI debt ticket (note 1).

---

## 1. Wiring close-out (named landings)

| Surface | Commit(s) | Live path | Status |
|---------|-----------|-----------|--------|
| B-254 silent stop + WHY | `e35fb1a8` + **`97542ec9`** | `MissionRail` → `missionStopReason`; durable `latestHandoff` / `plannedWork` prove runtime after reaper | **CLOSED** |
| B-246 wizard ejection | `24f98406` + **`336945f7`** | `confirm-reopen-mission` reads `listMissionPanes` + `missionControlPlane.queue` → `missionResumeRoute(plannedWork)` | **CLOSED** |
| Black orq pane (prior no-op) | `02f41b13` + **`9bdc4716`** | `terminal-host` retains **local** `adoptionTape` on data; backstop `repaintAdoptedFrame` — not main `pty.replay` | **CLOSED** (real paint path) |
| B-244 handoff after mission dies | **`b9739896`** (+ `4ded5947`) | `decideQuietWorker` has **no** `missionRunning` gate; stall probe + escalate; `initWorkerHandoffEnforcement` in `orch-ipc` | **CLOSED** |
| Space hold-to-talk | **`954b1ae3`** | `voice-controller` → `attachWindowPtt` → `HoldToTalkDiscriminator` | **CLOSED** (code + unit; live UAT note) |
| Dictation delivery + smoke | `61f91fb1` + `47eb2db1` | operator lane fallback; mandatory packaged probes | **CLOSED** |
| Approval loop | `cd621293` + **`664b534f`** | wizard outcome + main `approvalAlreadyCurrent` before dialog; trust origin hash | **CLOSED** |
| Mojibake | `96b1be19` + **`16a77ad3`** | `ensureUtf8Locale` strips `LC_ALL`/`LC_CTYPE=C` | **CLOSED** |
| Kickoff ceremony | `91cf7ab5` | lean delivery affirmative ownership | **CLOSED** |
| Nav contract + back | `5833077a` | wizard **‹ Voltar aos panes** | **CLOSED** |
| Control-plane UI | `80ef0754` + `845a8772` | IPC/MCP + `MissionControlBoard` on detail | **CLOSED** |
| Adaptive ramp (real bug) | `0531a95e` + **`5ebcd127`** | neutral full-eligible waves; hardware-seeded maxCap; settings | **CLOSED** |
| CI class | `bb0a2efe` | bubblewrap + darwin/arm64 `runIf` | **CLOSED** for that class |
| Recovery / MCP audit docs | `651f93b9`, `0fe423aa` | analysis only | N/A |

**Plumbed-but-dead check on `9bdc4716`:** tape is retained on session data (`terminal-host` ~611–618) and rewritten locally on empty buffer (~738–747). This is not the exhausted-main-replay path. **Pass.**

**Focused proof this pass:** 134 unit tests green across resume, stop-reason, adoption-repaint, handoff enforcement, stall-watchdog, adaptive ladder, hold-to-talk, window-ptt, functional-smoke, approval-already-current, wizard-approval-outcome, back-to-panes.

---

## 2. Rulings (route the release)

### (1) 252’s 6 pre-existing unrelated CI failures

**RULING: document-and-defer — do NOT block 0.26.1 product ship.**

They are inherited debt outside the hotfix surfaces (unless one of them is HIGH-T1 below). Open a debt ticket with the six names; optional fast-lane waiver if publish automation requires green `check`. Do not hold user fixes hostage to unrelated suite reds.

### (2) Space tap-vs-hold — live verification still pending

**RULING: do NOT block the build on live UAT concurrency; do NOT claim gate coverage that does not exist.**

| Layer | Covers Space hold discriminator? |
|-------|----------------------------------|
| `47eb2db1` packaged smoke (`dictation-delivery` / `dictation-governed-lane`) | **NO** — proves **PTY delivery / authority boundaries** after text exists, not keydown Space semantics |
| Unit suite (`hold-to-talk`, `voice-window-ptt`) | **YES** — pure discriminator + DOM attach contract |
| Live packaged “tap types space / hold arms dictation” | **NOT in gate today** |

**Strict posture (no faith ship for delivery):** delivery is gate-mandatory. Hold discrimination is a **separate** regression (HUD flash / stolen Space). It is **unit-locked and wired**, but live packaged assertion is still open.

**Required for release notes / operator checklist:** explicit UAT items for tap vs hold (map below).  
**Recommended follow-up (not a same-night product blocker):** extend packaged smoke or a renderer integration probe to assert (a) quick Space → space character without dictation start, (b) hold ≥ threshold → dictation arms. Until then, human UAT is the proof of record for that slice.

### (3) User-acceptance map → release notes verification

After installing **0.26.1** (packaged `.app` from Finder for locale/voice):

| # | Action | Expect |
|---|--------|--------|
| 1 | Focus a **governed** mission pane; **hold Space ≥ ~250ms**, speak, release | Text lands in pane; HUD success only if delivery confirmed; `voice.log` may show `lane=operator` |
| 2 | **Tap Space once** in the same pane | Single space character; **no** dictation/HUD flash |
| 3 | Approve a mission once; re-click Start/Approve while it is already running | **No** infinite native “Aprovar esta missão…?” loop; trust checkbox survives squad seal |
| 4 | Launch app **from Finder**; dispatch goal with accents (`missão`, `não`) | Correct glyphs in child CLI — not mojibake |
| 5 | Adopt / open mission with headless orch pane that used to go black | Orch pane shows content within ~1–2s (local tape), not permanent black |
| 6 | Worker finishes work and goes idle **without** handoff | ~20s nudge with `[NEXUS_HANDOFF_REQUIRED]`; later synthetic handoff if still silent |
| 7 | Mission self-stops while a worker is silent | Handoff still appears (mission state is diagnostic, not a mute switch) |
| 8 | Mid-flight stop with sealed plan / handoff (HiperGO-class) | Rail shows **why** (handoff text or “nenhum relatório”); pill “Parou — aguarda você” when runtime was observed |
| 9 | Click Retomar / card on that mission | **Panes** if recorded; else **stay + notice** naming preserved plan — **never** blank Nova Missão goal wizard |
| 10 | Open assistente over an armed existing mission | **‹ Voltar aos panes** returns to work |
| 11 | Open mission **detail** while multi-worker | Control board shows pulse / adaptive or sequential phase (not silent “2 panes mystery”) |
| 12 | Hardened multi-unit plan on capable host | Cap can ramp past floor 2 when waves cleanly admit all eligible work (not reset by serial size-1 waves) |

---

## 3. Notes (non-blocking, track)

| ID | Severity | Note |
|----|----------|------|
| **N1** | Process / MEDIUM | `MissionWizard` test **“deduplicates approval…”** still **red** on current tree (fixture lacks sealed `approvedAt` / toast path). Production dual-layer approval is wired and unit-covered elsewhere. **Fix fixture same-night if cheap; do not treat as user-facing open bug.** |
| **N2** | UAT | Space tap-vs-hold live verification pending (ruling 2). |
| **N3** | Debt | Six unrelated CI residuals (ruling 1). |
| **N4** | LOW | Control board lives on mission detail, not grid chrome. |
| **N5** | LOW | Hold threshold 250ms may feel sticky — document. |
| **N6** | LOW | Residual race branch in `confirm-reopen-mission` (empty specs → wizard) is only reachable after route already chose `panes`/`stay`; not the HiperGO path when `plannedWork>0`. |

---

## 4. What would have been BLOCK (none open)

- ~~B-246 wizard on sealed plan~~ → `336945f7`  
- ~~B-254 silent WHY~~ → `e35fb1a8` + `97542ec9`  
- ~~B-244 running-only handoff~~ → `b9739896`  
- ~~Black orq main-replay no-op~~ → `9bdc4716`  
- ~~Approval re-prompt~~ → `664b534f`  
- ~~LC_* mojibake~~ → `16a77ad3`  

---

## 5. Signature

**APPROVE-WITH-NOTES** — release 0.26.1 is authorized from product-correctness review of the named hotfix queue, subject to:

1. Document-and-defer the 6 CI residuals  
2. Publish user-acceptance map including Space tap vs hold; treat live hold UAT as required operator proof (gate does not cover it)  
3. Prefer fixing HIGH-T1 fixture before/alongside tag if capacity allows  

Reviewer will not push. Product code untouched.

*End FINAL review.*
