# Overclock → Nexus Parity Gap — Loop-Integrity Dossier

**Date:** 2026-08-05
**Author:** Synthesizer (3-lane gap-analysis: Overclock inventory · Nexus source inventory · prior-art digest)
**Scope:** Read-only. Answers: *what does Overclock have/do that Nexus does not, and why does Overclock's loop close end-to-end while Nexus's stalls?* The next phase PORTS what is mapped here.

---

## Executive summary

Nexus already has **~90% of Overclock's orchestration MECHANISMS by file:line** — every one of the 8 core loop mechanisms (orchestration topology, handoff/wake, pane lifecycle, provider reroute, recipes/catalog/squads, voice, media, workspace policy) is HAS or PARTIAL in Nexus source, several with Nexus-only hardening (receipt chain, agent attestation, phantom-cascade guard). So **"why Overclock closes and Nexus stalls" is NOT a missing-feature problem.** It is a small, concentrated set of **loop-integrity gaps**: enforcement that Overclock does *unconditionally by default* but Nexus does *opt-in, advisory, or serially* — worker TTL gated behind a flag (`worker-handoff-ttl.ts:62`), a router that only advises instead of binds (`task-router.ts:68`, prior-art RC3), a guided plan that is single-writer *by construction* (one giant ownership scope, `nexus-paralelismo-real-pendente`), plus the five "piloto automático" blockers (design-without-contract, empty pane, serial orchestration, bug≡feature, pilot-without-instruments) and the freeze C4 gate that is too heavy for a brand-new project. Close those and the loop closes; they are the P0 list below. The remaining gaps are policy/persona surface (workspace policy modes, agent-level personas, general autoClose) and are P1/P2. Overclock's core is closed bytecode (`index.jsc`), so enforcement-internal parity can only ever be **behavioral**, not line-faithful — stated honestly in §(e), along with the deliberate Nexus divergences that should be **kept, not "fixed"** (formalized as three EXCEED-not-regress axes in §(f)).

**P0 count evolved 3 → 7 → 10 over the campaign.** The dossier opened with **3** loop-integrity P0s, expanded to **7** as §(a) #1–#7 were traced end-to-end, and grew to **10** once a **live 85-story stuck-mission DB diagnosis** exposed three fan-out/terminality holes that only surface at real fan-out width and drain depth — invisible in the small-N reasoning that produced #1–#7:

- **P0-8 (NL fan-out):** `resolveSealTopology` routes natural-language goals to the `delivery` **single-executor** topology — an NL mission **never fans out**, so it can never exhibit the ≥2-writer cadence P0-3 unlocks. The topology decision silently caps parallelism at 1 before dispatch even begins.
- **P0-9 (drain cap 64):** wave-drain exists **only for the `wave-pack` topology and is capped at 64** — a fan-out wider than 64 leaves the tail undrained, so the mission cannot fully close even when every writer is healthy.
- **P0-10 (blocked-technical terminality):** a QA/review task that is **dependency-stuck stays `blocked` forever** — there is no terminal resolution for a blocked-technical task, so one stuck reviewer pins the whole plan open (the same "lifecycle edge that never fires" class as §a#1).

These three are the campaign's newest P0s and carry PENDING hashes (see §(d) status ledger).

---

## (a) Loop diff, mechanism-by-mechanism — ranked by how directly each blocks end-to-end close

This section answers the master question. Each gap has evidence on **both** sides (Overclock behavioral ref + Nexus file:line) and is ranked by how directly it explains "Overclock closes, Nexus stalls."

### #1 — Worker never closes ⇒ orchestrator never wakes (TTL is opt-in in Nexus, unconditional in Overclock) — **highest**

- **Overclock:** worker that forgets to hand off is **closed by the Stop hook unconditionally**, and the caller is woken with an `[auto]` handoff (`handoff-stop.mjs:18` `AUTO_MARK='[auto]'`, `:442` `closedBy:'stop-hook'`). "Green-means-close" is the default terminal state; `autoCloseOnHandoff` ships (concept, commit `869c08f7`; timing engine in `index.jsc` = bytecode limit). The blocked spawner is explicitly told the wake is delivery-driven: "worker calls handoff_submit and its result is typed into your input, waking you… NEVER poll" (`105.txt:16`).
- **Nexus:** the equivalent exists — `worker-handoff-ttl.ts:37` `WORKER_POST_HANDOFF_TTL_MS = 30_000` (comment literally: "espelhando o TTL observado no Overclock 1.2.4") — but it is **OPT-IN behind a feature flag**: `FEATURE_FLAG_IDS.missionWorkerHandoffTtl` (`feature-flags.ts:70`), read as a gate at `worker-handoff-ttl.ts:62`. With the flag off (default), a worker that goes idle without a semantic handoff is **never reaped**, so the orchestrator's idle-flush (`idle-delivery.ts:38-50`) never fires and the mission hangs.
- **Why it stalls:** Overclock's loop is closed by an *unconditional* close→wake edge. Nexus has the same edge but ships it disabled, so the single most load-bearing "close" transition is absent by default. This is the #1 direct cause.
- **Cross-ref:** `merge-abandonado-mesmo-processo-sem-watchdog` (entry stuck 22 min, 91 ticks applied=0) and `waiver-mascara-task-nunca-executada` are the same class — a lifecycle edge that never fires.

### #2 — Router advises but does not bind ⇒ monoculture / wrong-tier routing (advisory vs authoritative) — **very high**

- **Overclock:** squad policy is **authoritative at launch** — Read/Grep/Edit/Bash/Workflow are *removed* from delegator tiers by squad policy (`105.txt:127-134`), chefe routing groups a pipeline into contiguous same-role blocks and spawns exactly one `pane_spawn({chefe})` per block (`105.txt:50-69`). The squad's roster *is* the routing.
- **Nexus:** `DEFAULT_ROUTING_TABLE` at `task-router.ts:68` (5 tiers trivial/easy/medium/hard/critical, multi-LLM diversity) is real, but prior art (`analise-senior-2026-07-15-orquestracao.md`) records five root causes that make it **consultivo/advisory** in the agêntico path: RC1 quality fixtures fake-pre-empt diversity, RC2 substring match, **RC3 router consultivo (advisory only)**, RC4 agêntico mode ignores the saved squad, RC5 phantom model. `orca-traycer-dossie-decisao` re-confirms "agêntico ignora squad salvo" as a live 0.19.41 path bug.
- **Why it stalls:** if the route table is advice the agêntico loop can ignore, work lands on the wrong tier / a single provider, which then hits limits (see #4) — the mission converges to one writer and stops making forward progress. Overclock's roster is a hard constraint, so it can't drift into monoculture.

### #3 — Guided plan is single-writer *by construction* ⇒ no real parallelism (serial vs disjoint-ownership) — **very high**

- **Overclock:** area managers fan out to **≤5 leaf mecânicos** with a per-agent width cap (`106.txt:28` "AT MOST 5 slices, per-agent width cap"; `:79` "≤5 leaf workers"), each a real pane doing disjoint work; the pipeline advances as handoffs land.
- **Nexus:** the machinery for parallelism exists — `task_dispatch_queue` (`task-dispatch-store.ts:364`), claim authority (`task-dispatch-claim-authority.ts`), worktrees (`worktree-manager.ts`), worktree-dep scheduling (`mission-scheduler-worktree-dependencies.ts:11`) — **but** the guided plan is "1 escritor por construção" (`nexus-paralelismo-real-pendente`): ownership is encoded in `execution_mode` + per-task `worktree_id` (`task-dispatch-store.ts:313`) as one *giant identical* ownership scope, and reviews are serial, so 11 "parallel" stories serialize onto one writer. True fan-out needs decomposition with **disjoint** ownership.
- **Why it stalls:** an orchestrator that can only ever have one live writer cannot exhibit Overclock's close-and-advance cadence — every task waits behind the previous one, and any single stuck task (see #1) freezes the whole plan. This is prior-art blocker #3 "orquestração serial" (`criterio-piloto-automatico.md`).

### #4 — Reroute skipped on the fast path ⇒ single-provider exhaustion freezes the mission — **high**

- **Overclock:** worker that exhausts a provider **re-routes within the roster** to another agent of the same category (behavioral; engine in `index.jsc` = bytecode limit). `providers.json` roster + `retiredClaudeAccountIds` show live reroute is a first-class runtime concern.
- **Nexus:** all four reroute layers exist and are Nexus-superior — migration 027 `provider_reroute_json` (`project-runtime-orchestration-migrations.ts:884`), policy (`provider-reroute-policy.ts:7`), claim-authority enforcement (`task-dispatch-claim-authority.ts:134-247`), store writes (`task-dispatch-store.ts:2443/2487/2607/2662`), plus the phantom-cascade guard (`failover-handoff.ts:1`). **But** prior art shows the reroute is bypassed on a real path: `waiver-mascara-task-nunca-executada` — a 401 dispenses the advisory at attempt 0 and writes `status=done`, so **the roster reroute is never consulted**, causing a 32-min gate timeout. So the reroute is present but not *always on the path that needs it*.
- **Why it stalls:** the same single-provider dead-end Overclock routes around, Nexus can fall into when a waiver short-circuits the reroute consult — the task is marked done-without-running and the mission silently stops advancing.
- **Cross-ref:** `auditoria-freeze-familia-travas-2026-07-17` single-provider respawn loop (closed 23/07) is the same failure family.

### #5 — Design without an enforceable contract ⇒ plan can't be sealed/verified ("design sem contrato") — **high**

- **Overclock:** recipes carry `spine[].role` that *drives* chefe-block routing (`squads.json` orchestratorInstructions), and a run is stamped `[RECIPE-RUN id=…]` — the plan is an executable contract, not prose.
- **Nexus:** PREVC exists (`guided-mission-prevc.ts`, `prevc-autopilot-coordinator.ts`, `guided-prevc-mcp-fence.ts`) and receipts are enforced (`task-dispatch-store.ts:412` "receipt externo/sintético é proibido para same_checkout/read_only"), but prior art records the contract-shaped stalls: `prevc-auto-freeze-deadlock-bug` (the fence *requires* a contract but nothing else creates it → mission blocked forever until `ensureGuidedMissionPrevcForScope` was re-fired), and `orca-traycer-dossie-decisao` "modo Squad não sela o plano." This is blocker #1 "design sem contrato" and #4 "bug≡feature" (`criterio-piloto-automatico.md`).
- **Why it stalls:** if the plan is never sealed into a verifiable contract, the fence blocks and the loop can't legally advance — a *correctness* gate becomes a *liveness* trap.

### #6 — Empty pane / worker boots but never executes ("pane vazio") — **high**

- **Overclock:** one-call **birth-executing** spawn — the pane is "born ALREADY EXECUTING it — ONE call, never spawn then write" (`105.txt:3`), birth prompt via CLI argv (`handoff-stop.mjs:28`). `pane_wait_idle` is boot-confirmation only (≤15s). There is structurally no window where a pane exists but idles empty.
- **Nexus:** spawn authority + resume exist (`spawn-authority.ts:1`, `respawnWithResume` `terminal-host.ts:1493`, `pane_resume` action `:132`), but prior art blocker #2 is exactly "pane vazio" (`criterio-piloto-automatico.md`): a pane that comes up without its task actually running. Login-stuck and stall watchdogs (`login-stuck-watchdog.ts` commit `9980e3db`, `stall-watchdog.ts`) are the mitigations, i.e. the failure was real enough to need a watchdog.
- **Why it stalls:** an empty worker never hands off (→ #1), so the orchestrator waits on a wake that will never come.

### #7 — Freeze C4 too heavy for a NEW project ⇒ bootstrap blocked (`.context` gate) — **medium-high**

- **Overclock:** no bootstrap freeze gate observed; a squad spawns and immediately works from `orchestratorInstructions`.
- **Nexus:** freeze authority (`mission-freeze-authority.ts`) + the C1–C4 gate stack (`auditoria-freeze-familia-travas-2026-07-17.md`); **C4 is still heavy for a NEW project with no `.context`.** Cross-ref `analise-senior-2026-07-16-tres-causas-raiz`: "gate bloqueia bootstrap e trava toda a missão." Earlier freeze-family bugs (checkout sujo, maxWorkers vivos, erro acionável) are fixed; open: stalled, drift pós-freeze.
- **Why it stalls:** a brand-new project trips a gate designed for an established one and never leaves bootstrap.

### #8 — Pilot without instruments ⇒ stalls are invisible, so no recovery fires ("piloto sem instrumentos") — **medium (amplifier)**

- **Overclock:** `handoff-pending-<paneId>` markers make "chef idle awaiting workers" observable; `soft-status.mjs` per-pane. State is legible.
- **Nexus:** telemetry is partial — `mission-ux-pack-handoff-2026-08-03` shipped silent-verdict fixes (`260eb2e6`) and a boot-telemetry skeleton (`6bdb7ac0`) but increments 2–6 are pending; `resgate-2026-07-31` added a presenter + `blocked` detail because diagnosis was invisible. Blocker #5 "piloto sem instrumentos" (`criterio-piloto-automatico.md`).
- **Why it stalls:** this doesn't cause the stall, it *hides* it — a stalled mission with no instrument reads as "working," so the operator (or an autopilot) never intervenes. It amplifies #1–#7.

### #9 — Natural-language goals never fan out (`delivery` single-executor topology) — **high (P0-8)**

- **Overclock:** area managers fan out to ≤5 leaf mecânicos regardless of how the goal was phrased; there is no "NL ⇒ single executor" branch — the topology is driven by the recipe spine, not by whether the goal arrived as prose.
- **Nexus:** `resolveSealTopology` maps a natural-language goal to the **`delivery` single-executor** topology. An NL mission is therefore capped at **one writer before dispatch begins** — it can never reach the ≥2-writer cadence P0-3 unlocks, because the topology decision has already collapsed the plan to a single lane.
- **Why it stalls:** this is P0-3's precondition failing one layer earlier. Even with disjoint-ownership decomposition landed, an NL-originated mission routes around it entirely and serializes onto a single executor. Surfaced by the live 85-story DB diagnosis: the stuck mission was NL-originated and had exactly one live writer by topology, not by contention.
- **Cross-ref:** compounds §a#3 (single-writer by construction) — #3 is the plan shape, #9 is the topology router that forces that shape for NL input.

### #10 — Wave-drain exists only for `wave-pack` and is capped at 64 ⇒ wide fan-out can't fully drain — **high (P0-9)**

- **Overclock:** the pipeline advances as handoffs land with no observed fixed drain ceiling; a chefe block of any width drains as its workers report.
- **Nexus:** wave-drain is implemented **only for the `wave-pack` topology** and is **capped at 64**. A fan-out wider than 64 leaves a residual tail that the drain loop never processes, so the mission cannot reach a fully-closed state even when every writer is individually healthy and has handed off.
- **Why it stalls:** at real fan-out width (the campaign runs 85 stories) the cap bites directly — the last (width − 64) stories are stranded post-handoff, mimicking a hang. This is invisible below width 64, which is why #1–#7's small-N reasoning missed it.
- **Cross-ref:** the observable signature matches `merge-abandonado-mesmo-processo-sem-watchdog` (entry stuck, applied=0) but the root cause is a drain ceiling, not an abandoned merge.

### #11 — Blocked-technical task is non-terminal ⇒ one dependency-stuck reviewer pins the plan open forever — **high (P0-10)**

- **Overclock:** a worker either hands off (green-means-close) or is reaped by the Stop hook; there is no "blocked forever with no terminal edge" state — every worker resolves to a terminal outcome.
- **Nexus:** a QA/review task that is **dependency-stuck stays `blocked` indefinitely** — there is no terminal resolution for a blocked-technical task. The task never fails, never waivers, never reroutes; it simply holds, and the plan cannot seal because a non-terminal task is still open.
- **Why it stalls:** this is the same "lifecycle edge that never fires" class as §a#1, but for the *review* side rather than the *worker* side — a single blocked reviewer is enough to keep an otherwise-complete 85-story plan from closing.
- **Cross-ref:** same family as `merge-abandonado-mesmo-processo-sem-watchdog` and `waiver-mascara-task-nunca-executada` — a terminal transition that was never defined for this state.

> **Ranking rationale:** #1 is the direct close→wake edge; #2–#4 push the mission toward the single-writer dead-end where that missing edge bites; #5–#7 block the *start* of the loop (contract, non-empty worker, bootstrap gate); #8 is the observability amplifier that lets any of the above go unrecovered. **#9–#11 are the fan-out/terminality tier surfaced only by the live 85-story DB diagnosis:** #9 forces NL missions single-writer at the topology router (P0-3's precondition), #10 caps the drain so wide fan-out cannot fully close, #11 leaves a blocked reviewer non-terminal so one stuck task pins the plan open. They rank *high* rather than *highest* because they bite only at real fan-out width/depth — but at the campaign's 85-story scale they bite every run.

---

## (b) Inventory table — Overclock × Nexus (one row per Lane-1 mechanism)

| # | Mechanism | Overclock evidence (behavioral) | Nexus evidence (file:line) | Status |
|---|-----------|--------------------------------|----------------------------|--------|
| 1 | **Orchestration topology** | 3 fixed pure-delegator tiers; tools removed by squad policy (`105.txt:127-134`); chefe contiguous-block routing (`105.txt:50-69`); worker cap ≤5 (`106.txt:28,79`) | mission-store/kickoff, PREVC (`guided-mission-prevc.ts`), MCP fence (`guided-prevc-mcp-fence.ts`), gate (`gate.ts:1`), dispatch queue (`task-dispatch-store.ts:364`), claim authority (`task-dispatch-claim-authority.ts`), router (`task-router.ts:68`), squads (`squad-store.ts`), scheduler (`mission-scheduler-production.ts`) | **PARTIAL** — present but router advisory (RC3) + single-writer (§a#2,#3) |
| 2 | **Handoff / wake** | Stop hook `handoff-stop.mjs:539` UserPromptSubmit banner; ≤280 verbatim (`:157`); `[auto]` on forget (`:18`,`:442`); origin gate `:31`; fullText cap 60000 | `nexus_handoff_submit` (`worker-handoff-contract.ts:76`), idle-delivery (`idle-delivery.ts:38-50`), outbox, `pty-stream-handoff.ts:88`, physical-ack authority, **receipt chain (`receipt-chain.ts`) + agent attestation (`agent-attestation.ts`) = Nexus-only** | **HAS** (Nexus-hardened) |
| 3 | **Pane lifecycle** | Birth-executing one-call spawn (`105.txt:3`); `pane_wait_idle` ≤15s boot only; resume closed worker w/ context (`106.txt:6`); worker TTL/autoClose (commit `869c08f7`, engine bytecode) | spawn authority (`spawn-authority.ts:1`), pane limits soft16/hard20 (`pane-limits.ts:1`), resume (`terminal-host.ts:1493`, `:379`, `:132`), **worker TTL opt-in (`worker-handoff-ttl.ts:37`, gate `:62`)**, watchdogs (`stall-watchdog.ts`, `login-stuck-watchdog.ts`) | **PARTIAL** — TTL opt-in (§a#1); no general autoClose for non-worker panes |
| 4 | **Provider reroute / failover** | Roster `providers.json`; reroute-within-roster (engine bytecode); `retiredClaudeAccountIds`; at-rest encryption `.providers-encryption-broken/.bak` | migration 027 `provider_reroute_json` (`…migrations.ts:884`), policy (`provider-reroute-policy.ts:7`), claim enforce (`…claim-authority.ts:134-247`), store writes (`task-dispatch-store.ts:2443…`), **phantom-cascade guard (`failover-handoff.ts:1`) = Nexus-only** | **HAS** (Nexus-superior) — but bypassed by waiver on one path (§a#4) |
| 5 | **Recipes / catalog / squads / personas** | recipes site/app/saas/automacao/jogo-web-mvp; `[RECIPE-RUN id=…]`; `spine[].role`; 2-phase catalog immersion (`106.txt:21-37`); 5 builtin squads; **named leaf personas** | catalog (`catalog.ts:34`), overlay (`catalog-overlay.ts`, `recipe-overlay.ts:13`), recipe lint (`recipe-lint.ts`), squads (`squad-store/architect/reuse`), builtin (`builtin-squads.ts`), squads.json migration (`de58c3e5`), stack-detector | **PARTIAL** — recipes/catalog/squads HAS; **agent-level personas MISSING** (persona only in voice config `voice-ipc.ts:97-99`) |
| 6 | **Voice (ClockVoice / Jarvis)** | `audio-config.json`: groq whisper-large-v3, pt→english outputMode, hold+Space, chunkMs 4700; agent-side `105.txt:23` | `src/main/jarvis/`, realtime (`factory.ts:1`), passive wake (`jarvis-passive-nlu.ts`, `passive-wake-matcher.ts:2` commit `ecf8ea6e`), same-utterance inject (`voice-ipc.ts:811`), AEC (`aec-*.ts`, fix `d706e57`), dictation (`bed8df1b`), hot-session guard | **PARTIAL** — mechanisms HAS; **cold-start latency P0-2 (8–18s) still open** (no warm-path reuse in code; `jarvis-transplante-overclock-incompleto`) |
| 7 | **Media (conditional, degrade-by-tier)** | `overclock_media_providers` LIVE state; degrade video+img→img→CSS, never error (`105.txt:85-95`); env-var keys | registry (`media-providers.ts:88`), hasKey conditional (`:200-227`), MCP `nexus_media_providers` (`tools-media.ts:37`), vault (`media-keys.ts`), aliases, cost est (`:40-78`) | **DIVERGES-on-purpose** — Nexus enforces model whitelist (no silent fallback) + safeStorage vault vs Overclock silent-substitute + env vars |
| 8 | **Workspace policy** | `write_external` mode: read/edit inside AND outside primary workspace; out-of-policy → ask to update settings (`105.txt:25-28`, `106.txt:1-4`); per-pane guardrail hooks | workspace types (`workspace-types.ts:1`), path enforce (`workspace-path.ts`), governed boundary (`governed-workspace-control-boundary.ts:1`), task `execution_mode` (`real-mission-e2e-contract.ts:471`: isolated_worktree/read_only/same_checkout) | **PARTIAL / MISSING** — no explicit workspace-level `write_external`/`read_only` policy *type*; policy is implicit at dispatch + MCP allowlists |
| 9 | **MCP tool surface** | panes + handoff + `overclock_mission/squad/agent/skill/model/recipe/stack/catalog/marketplace/media/vault/open_browser/navigate/clarify/task/workflow`; per-pane scoping `mcp-pane-*.json` | native orch + embedded MCP 24 tools (commit `ab5c3347`, v0.7.5 parity); marketplace clone (`fe02afbb`) | **HAS** (parity claimed at v0.7.5) |
| 10 | **Orchestration model / tiers** | overclock-orchestrator opus-4-8 per squad; workers tagged scout/builder/reviewer w/ cli+model+effort+allowedSkills allowlist; `minAppVersion 1.1.1` | `DEFAULT_ROUTING_TABLE` 5 tiers (`task-router.ts:68`), route-pipeline, squad roster w/ category tags (`builtin-squads.ts`, `builtin-squad-ids.ts`) | **PARTIAL** — table exists but advisory in agêntico path (RC3/RC4) |

Legend: **HAS** = present & at least at parity · **PARTIAL** = present but disabled/advisory/incomplete on a loop-critical path · **MISSING** = no equivalent · **DIVERGES-on-purpose** = intentionally different, keep (see §e).

---

## (c) Already ported (commits) vs pending

### Already ported — verbatim from Lane 2

- `869c08f7` — worker TTL post-handoff, **opt-in** (paridade Overclock 1.2.4)
- `9980e3db` — credential probe + login-stuck watchdog (F-256)
- `0a4b8573` — real pane activity cards
- `a1a289b6` — P0–P3 UI/UX parity (Orca / Overclock)
- `7ed2079c` — sci-fi redesign + cross-platform
- `5f6b0575` — Providers hub, scan-first
- `ecf8ea6e` — matchWakeWord port + same-utterance inject
- `640175a5` — Overclock-style wake
- `db4c5e91` — voice hot-session + parity gates
- `de58c3e5` — workspace wizard + squads.json migration
- `f0708a74` — settings drawer catalog/modules sidebar
- `ab5c3347` — native orch + embedded MCP (24 tools, v0.7.5 parity)
- `fe02afbb` — marketplace clone + subscription auth
- `ea385671` — v0.3.0 benchmark applied

### Pending / absent — verbatim from Lane 2

- Workspace policy modes (`write_external`)
- General pane autoClose (non-worker panes)
- Agent-level personas independent of voice
- Jarvis cold-start P0-2 (8–18s)
- Parallel real-task ownership (disjoint-worktree parallelism, `nexus-paralelismo-real-pendente`)

---

## (d) Proposed porting order

Effort key: **S** ≈ ≤½ day · **M** ≈ 1–3 days · **L** ≈ >3 days. P0 = unblocks the end-to-end loop (maps 1:1 to §a).

### P0 — close the loop (do these first; they are §a #1–#11)

The STATUS column carries the campaign's landed/pending hashes. **Landed** = verified against HEAD this session. **PENDING** = a real fix identified but not yet committed (placeholder to be filled when the commit lands).

| ID | What | Why it unblocks | Effort | Status (hash) | Target Nexus files |
|----|------|-----------------|--------|---------------|--------------------|
| **P0-1** | **Make worker post-handoff TTL default-ON for guided/autopilot missions** (keep opt-out for E2E, see §e) — flip `missionWorkerHandoffTtl` default, or add a mission-scoped override that defaults true when not an E2E run | Restores the unconditional close→wake edge (§a#1) — the single most direct stall cause | **S** | **landed** `568c1324` (TTL de worker pós-handoff default-on com opt-out) | `feature-flags.ts:70`, `worker-handoff-ttl.ts:62`; guard behind mission mode in `prevc-autopilot-coordinator.ts` |
| **P0-2** | **Router advisory → authoritative in agêntico path** — bind the resolved route/squad so the agêntico loop cannot ignore it; fix RC1 (quality-fixture pre-emption), RC2 (substring match), RC4 (agêntico ignores saved squad) | Stops monoculture / wrong-tier routing that drives the mission into single-provider dead-ends (§a#2) | **M** | **landed** `492920e0` (vincula squad à reserva de rota e gate de `pane_spawn` no caminho agêntico) | `task-router.ts:68`, `route-pipeline.ts`, agêntico dispatch path; squad bind in `squad-store.ts` / `builtin-squads.ts` |
| **P0-3** | **Disjoint-ownership decomposition for guided plans** — split the one giant ownership scope into per-story disjoint `worktree_id` sets so ≥2 writers can run (mirror Overclock ≤5 leaf cap) | Turns serial single-writer into real fan-out; removes head-of-line blocking (§a#3) | **L** | **landed (reworked across seams)** `007888ae` (seam A: decomposer emits disjoint per-story ownership) · `17096105` (seam B: wire disjoint-writer guard into dispatch claim) · `1c495e85` (seam D: serial-merge intentional for disjoint fan-out). **Seams are LIVE at `claimTaskDispatch:424`** (verified this session). | `task-dispatch-store.ts:313`, `mission-scheduler-worktree-dependencies.ts:11`, `guided-mission-prevc.ts`; receipt validators must accept disjoint scopes |
| **P0-4** | **Always consult roster reroute before waivering a provider failure** — the 401/waiver path must call `provider-reroute-policy` before writing `status=done` | Closes the "waiver masks a task that never ran" hole that skips reroute (§a#4) | **M** | **landed (pre-campaign)** — wired at `failover.ts:493`, hardened for all attempts, 17 tests green (cross-ref `p0-4-reroute-antes-do-waiver-ja-landou`) | `provider-failure-waiver.ts`, `provider-failure-task-policy.ts`, `task-dispatch-claim-authority.ts:134-247` |
| **P0-5** | **Guarantee a sealed contract exists before the fence blocks** — ensure `ensureGuidedMissionPrevcForScope` fires fire-and-forget on bootstrap and Squad mode seals its plan | Prevents the "fence requires a contract nothing creates" deadlock (§a#5) | **S–M** | **landed (pre-campaign)** — `ensureGuidedMissionPrevcForScope` re-fired fire-and-forget (cross-ref commit `5b93ec6e`) | `guided-mission-prevc.ts`, `guided-prevc-mcp-fence.ts`, `prevc-autopilot-coordinator.ts` |
| **P0-6** | **Birth-executing worker guarantee** — verify the spawn actually carries its task into execution (argv/first-turn), and treat a non-executing boot as a fault the watchdog reaps | Eliminates the "pane vazio" that never hands off (§a#6) | **M** | **landed (pre-campaign)** — spawn-authority + stall/login watchdogs | `spawn-authority.ts:1`, `main-owned-agent-spawn.ts`, `terminal-host.ts:1493`, `stall-watchdog.ts` |
| **P0-7** | **Freeze C4 lightweight path for new projects (no `.context`)** — relax/auto-satisfy C4 when the project is greenfield | Stops brand-new missions from trapping in bootstrap (§a#7) | **S–M** | **landed (pre-campaign)** — C4 (`inspectContextReadiness`) auto-satisfied for greenfield workspace (cross-ref `p0-7-freeze-c4-greenfield-ja-coberto`) | `mission-freeze-authority.ts` (C4 gate) |
| **P0-8** | **NL fan-out** — stop `resolveSealTopology` from routing natural-language goals to the `delivery` single-executor topology; NL goals must be eligible for a fan-out topology | Removes P0-3's precondition failure — an NL mission that can never reach ≥2 writers (§a#9) | **M** | **PENDING** `<hash>` | `resolveSealTopology` (seal-topology resolver); `guided-mission-prevc.ts` topology selection |
| **P0-9** | **Drain cap 64** — raise/remove the 64-wide wave-drain ceiling and extend drain beyond the `wave-pack` topology so fan-out wider than 64 fully closes | A wide fan-out (85 stories) currently strands its tail post-handoff (§a#10) | **M** | **PENDING** `<hash>` | wave-drain loop (wave-pack topology); drain-width constant |
| **P0-10** | **Blocked-technical terminality** — define a terminal resolution for a dependency-stuck QA/review task so it does not stay `blocked` forever | One stuck reviewer no longer pins an otherwise-complete plan open (§a#11) | **M** | **PENDING** `<hash>` | task-dispatch terminal-state authority; QA/review blocked-state handling |

### Campaign status ledger (all landed/pending hashes, incl. non-loop items)

| Item | Status | Hash(es) |
|------|--------|----------|
| P0-1 worker TTL default-on | landed | `568c1324` |
| P0-2 router→authoritative + agêntico gate | landed | `492920e0` |
| P0-3 disjoint-ownership fan-out (seams A/B/D; LIVE at `claimTaskDispatch:424`) | landed (reworked) | `007888ae` · `17096105` · `1c495e85` |
| P0-4 reroute-before-waiver | landed (pre-campaign) | see `failover.ts:493` |
| P0-5 sealed-contract-before-fence | landed (pre-campaign) | `5b93ec6e` |
| P0-6 birth-executing worker | landed (pre-campaign) | spawn-authority + watchdogs |
| P0-7 freeze C4 greenfield path | landed (pre-campaign) | `inspectContextReadiness` auto-satisfy |
| P0-8 NL fan-out | **PENDING** | `<hash>` |
| P0-9 drain cap 64 | **PENDING** | `<hash>` |
| P0-10 blocked-technical terminality | **PENDING** | `<hash>` |
| quit-hang (v0.25.0) | landed | `76d405d1` (SIGTERM→SIGKILL bounded) · `a78dbc21` (quit deadline + `app.exit` backstop) |
| dictation delivery to pane | **PENDING** | `<hash>` |

### P1 — instruments + policy/persona surface

| ID | What | Why | Effort | Target Nexus files |
|----|------|-----|--------|--------------------|
| **P1-1** | **Finish mission instruments** (increments 2–6) — chef-idle-awaiting-workers marker, blocked-reason surfacing, boot telemetry | Makes stalls visible so recovery/autopilot can fire (§a#8) | **M** | per `docs/analysis/2026-08-03-mission-ux-handoff.md`; extend `260eb2e6`/`6bdb7ac0` |
| **P1-2** | **Workspace policy modes** (`write_external` / `read_only`) as a first-class `WorkspacePolicy` type | Parity with Overclock `105.txt:25-28`; make the implicit dispatch policy explicit & user-settable | **M** | new type in `workspace-types.ts:1`, enforce in `governed-workspace-control-boundary.ts:1`, `workspace-path.ts` |
| **P1-3** | **Agent-level personas** independent of voice — a Persona entity (system-prompt identity per leaf agent) | Parity with Overclock named leaf mecânicos; decouple from `voice-ipc.ts:97-99` | **M** | new persona store next to `squad-store.ts`; wire into `spawn-authority.ts` |
| **P1-4** | **General pane autoClose for non-worker panes** | Parity with Overclock green-means-close beyond the worker-TTL path | **S–M** | extend `worker-handoff-ttl.ts` / `pane-registry.ts` |

### P2 — remaining behavioral parity & long-horizon

| ID | What | Why | Effort | Target Nexus files |
|----|------|-----|--------|--------------------|
| **P2-1** | **Jarvis cold-start P0-2** (8–18s) — instrument cold-start in the app, then add warm-path reuse | Voice parity; currently blocked because reuse is untested in-app (`jarvis-transplante-overclock-incompleto`) | **L** | `src/main/jarvis/`, `factory.ts:1`; needs in-app instrumentation first |
| **P2-2** | **Goal-driven mission-driver** (Ralph gap) — cron is time-driven; add a goal-driven driver (spec exists, not solution) | The one real gap vs Ralph (`ralph-cross-ref-mission-driver`); `ralph.sh` itself is a security regression, do not port it | **L** | per `docs/superpowers/specs/2026-07-13-mission-driver-design.md` |
| **P2-3** | **Media degrade-by-tier UX** (never-error tiering) *as UX*, keeping the whitelist | Match Overclock's graceful degrade without adopting silent fallback | **S** | `media-providers.ts:200-227`, `tools-media.ts` |

---

## (e) Where 100% parity is impossible — or undesirable (no whitewashing)

### Impossible to make line-faithful (behavioral-only by necessity)

Overclock's core is **closed bytecode**: `dist/index.jsc` (bytenode V8, 3.38 MB, unreadable). The enforcement internals live there — **worker-cap counting, TTL/autoClose timers, the provider reroute engine, the catalog/recipe engine, and media gating are all in `index.jsc` (grep = 0 hits in the binary).** Therefore parity for *exact* TTL duration, cap arithmetic, reroute selection order, and gating thresholds can only ever be **behavioral** (reconstructed from prompts `system-prompt-pane-105/106.txt`, hooks `handoff-stop.mjs`, configs `providers.json`/`squads.json`/`audio-config.json`, and the live MCP schema) — **never line-faithful.** Any claim of "matches Overclock's TTL/cap exactly" is unverifiable; Nexus's `WORKER_POST_HANDOFF_TTL_MS = 30_000` is a *stated mirror* of "observed 1.2.4," not a copied constant. **Evidence limit stands: do not pretend to have Overclock source.**

### Deliberate Nexus divergences to KEEP (do not "fix" toward Overclock)

1. **`execution_mode` ownership vs Overclock wildcard registry.** Nexus encodes ownership in `execution_mode` + per-task `worktree_id` (`task-dispatch-store.ts:313`) with **no wildcard default**. Overclock's named `worktree_ownership` with wildcard defaults *caused* an ownership-collision bug on the Nexus side once (`stale-worktree-ownership-blocks-future-missions`). Keep Nexus's explicit model — P0-3 must add disjointness *without* reintroducing a wildcard registry.
2. **Receipt chain + agent attestation (Nexus-only).** `receipt-chain.ts`, `agent-attestation.ts`, `agent-attestation-gate.ts` give Nexus verifiable handoffs Overclock has neither of. This is a security/integrity advantage — keep it even though it adds a step Overclock skips.
3. **Model whitelist, no silent fallback (media).** Nexus enforces the model whitelist and *errors* rather than silently substituting; Overclock silently substitutes (`105.txt:85-95` degrade). Keep Nexus's no-silent-fallback (P2-3 adds the *UX* of graceful degrade without adopting silent substitution).
4. **safeStorage vault vs env-var keys.** Nexus keys live in the safeStorage vault (`media-keys.ts`, `media-providers.ts`); Overclock uses env vars (+ `.providers-encryption-broken/.bak`). Keep the vault — it is strictly safer.
5. **Phantom-limit cascade guard (`failover-handoff.ts:1`).** Nexus-specific isolation of the continuity pack to stop a detector re-reading its own error and downing the fleet (`failover-phantom-cascade-continuity-pack`). No Overclock equivalent observed; keep.
6. **Opt-in worker TTL for E2E.** P0-1 flips the *default* to on for guided/autopilot missions, but the **opt-out must remain** — real-mission E2E anchors workers to live PTYs and needs them *not* auto-reaped (`e2e-cdp-noturno-aprendizados`, `keychain-locked-main-thread-freeze`). Overclock closes unconditionally; Nexus should default-on-but-overridable, not unconditionally-on.

---

## (f) Deliberate-divergence axes (Nexus must EXCEED Overclock, never regress)

§(e) lists divergences to KEEP. These three are the axes where Nexus is *ahead* of Overclock and where **matching Overclock would be a regression**. Each records the Overclock behavior — including bugs observed live this session — as the evidence of what Nexus must NOT reproduce.

### Axis (a) — Multi-CLI per-member binding vs claude-monoculture-by-policy

- **Nexus (ahead):** each squad member binds its **own CLI** (claude/codex/gemini/…). The agêntico gate at `tools-panes.ts:390-402` admits any CLI in the squad roster (`squad_binding_violation` only rejects a CLI *outside* the roster — it never forces a single provider), and reroute-within-roster (`provider_reroute_json`, migração 027) re-routes an exhausted member to another agent of the same category.
- **Overclock (behind, by policy):** in build v1.3.0 every squad mission is **claude-monoculture by policy** — `pane_spawn` of any non-claude CLI is denied VERBATIM with `roster_violation: squad panes must use agent_invoke, not pane_spawn`, and the `agent_invoke` tool the gate demands is absent from every toolset. Every catalog persona is `cli:claude`.
- **Regression to avoid:** collapsing Nexus to a single-CLI roster to "match" Overclock. Nexus fleet diversity is a strict superset; keep it.

### Axis (b) — Post-handoff TTL WITH ghost-safe respawn

Nexus pairs the worker post-handoff TTL (P0-1, `568c1324`) with **ghost-safe respawn** (`respawnWithResume`, `terminal-host.ts:1493`; receipt chain + agent attestation). Overclock closes on TTL but its close/respawn path shipped the following bugs **observed live this session** — these are exactly the failure modes Nexus's ghost-safe path must NOT reproduce:

1. **`reused:true` + `delivery:dropped_pane_gone` race** — a caller reused a pane the runtime had already dropped, so the delivery targeted a gone pane and was lost. Nexus's physical-ack + receipt chain must make a reused-but-gone pane a hard fault, never a silent drop.
2. **TTL ghosts requiring `pane_close` purge + resume** — TTL left ghost panes that had to be manually purged with `pane_close` and then resumed to recover; **validated 6+ times this session**. Nexus respawn must reap-and-resume atomically so no ghost survives the TTL edge.
3. **Caller `width_cap` counting DEAD panes against the live budget** — dead panes were still counted toward the caller's width cap, starving the live budget so new workers couldn't spawn. Nexus width accounting must count only *live* panes.

- **Regression to avoid:** adopting Overclock's unconditional-close timing without the ghost-safe reap/resume + live-only width accounting — that would import bugs 1–3.

### Axis (c) — Fan-out width 11+ and drain 85+ vs ≤5-per-chefe ceiling

- **Nexus (ahead, target):** the campaign targets **fan-out width 11+** and **drain depth 85+** (the live 85-story mission). P0-3 (disjoint ownership), P0-8 (NL fan-out), and P0-9 (drain cap) exist precisely to reach and sustain that scale.
- **Overclock (behind, by structure):** area managers fan out to **≤5 leaf mecânicos** with a per-agent width cap (`106.txt:28,79`). Overclock's loop closes cleanly *because* it never fans past 5 — a ceiling, not a capability.
- **Regression to avoid:** capping Nexus fan-out at ≤5 to inherit Overclock's clean-close behavior. The correct move is to close P0-9's drain ceiling so Nexus closes cleanly *at* 85, not to shrink the fan-out to Overclock's 5.

---

## Appendix — verification notes

Load-bearing P0 anchors re-verified against HEAD this session (read-only): `worker-handoff-ttl.ts:37` (`WORKER_POST_HANDOFF_TTL_MS = 30_000`, comment "espelhando o TTL observado no Overclock 1.2.4") and its opt-in gate at `:62` reading `FEATURE_FLAG_IDS.missionWorkerHandoffTtl` (`feature-flags.ts:70`); `DEFAULT_ROUTING_TABLE` at `task-router.ts:68` (Lane 2's `task-router.ts:1` was the file, not the table); `execution_mode` ownership + receipt gating in `task-dispatch-store.ts:313,412` (`isolated_worktree`/`same_checkout`/`read_only`); `guided-mission-prevc.ts` and `task-dispatch-claim-authority.ts` present. All other file:line refs carried faithfully from the Lane-2 full-source explorer inventory; all Overclock refs are behavioral (prompts/hooks/configs/live MCP), never source.

---

## Apêndice: contrato multi-CLI observado (codex/gemini × claude)

A Task 2 tinha como objetivo capturar o loop de worker NON-claude com workers heterogêneos reais (codex-cli + gemini-cli), como referência comportamental. A tentativa em si produziu o achado primário: neste build do Overclock (v1.3.0) as squad missions são claude-monocultura POR POLÍTICA — a superfície multi-CLI existe no nível de tool, mas um roster gate a fecha a mid-mission em todo tier. Os achados estão separados em três classes de evidência explícitas (não confundir).

> **CORREÇÃO (não há gap de shim per-CLI no Nexus).** O "shim per-CLI de handoff-teaching" **JÁ EXISTE no Nexus e não é P1**. O contrato de worker (`worker-handoff-contract.ts:76`, `nexus_handoff_submit`) e os construtores de prompt de kickoff/same-checkout anexam a linha de handoff-teaching (`… chame nexus_handoff_submit …`) a **todo** prompt de worker — `withSameCheckoutWorkerContract` em `tools-panes.ts:157-167` e o kickoff em `mission-dispatch-kickoff.ts:447` — independentemente da CLI. Isso é o análogo direto da linha que o delegador do Overclock anexa só para não-claude, mas no Nexus é incondicional. A vinculação multi-CLI POR MEMBRO também já é enforçada: `tools-panes.ts:390-402` admite **qualquer** CLI do roster do squad (`squad_binding_violation` recusa só CLIs de fora do roster — nunca força claude). Ou seja, onde o Overclock fecha em claude-monocultura por política, o Nexus **já** roda handoff-teaching per-CLI + binding per-membro. Trate as linhas abaixo sobre "assimetria de handoff-teaching" como descrição do **Overclock**, não como lacuna do Nexus.

### 1. OBSERVED-ENFORCED (ao vivo, determinístico)

- **Roster gate:** `pane_spawn` de qualquer CLI não-claude é negado com a string de erro VERBATIM: `roster_violation: squad panes must use agent_invoke, not pane_spawn`.
- Reproduzido em AMBOS os tiers: L1 (scout-chef, pane-106) e T1 (piloto, pane-105) — mesmo erro determinístico.
- CLIs testados, todos `enabled:true` e ativos per `pane_list_providers`: codex (agent codex / providerId codex-cli), gemini (gemini-cli), kimi (kimi-cli, substituto planejado). Todos negados. ~5 tentativas em L1 + o teste T1 do piloto. NÃO é falha de boot/credencial. (Um `HTTP 404 "no such session"` transitório apareceu na primeira tentativa com codex, depois o roster_violation determinístico em cada retry.)
- `agent_invoke` (a tool que o gate exige) está AUSENTE de todos os toolsets — ToolSearch retorna "no matching deferred tools". O gate exige uma tool removida globalmente da plataforma.
- Toda persona do catálogo é `cli:claude` (`overclock_agent_list`). O caminho de persona (única forma que passa pelo gate) portanto produz apenas claude. Combinar uma persona claude com um agente não-claude (`persona:"explore", agent:"codex"`) falha com `agent_not_found: explore` — personas têm escopo de CLI restrito ao claude.
- **Conclusão:** squad missions rodam claude-only por política neste build.
- **POLICY/TOOLING VERSION-SKEW (registrado explicitamente):** o próprio schema do `pane_spawn` anuncia um enum `agent` (claude, codex, gemini, kimi, antigravity, cursor, copilot, grok, opencode, kiro) e valores `providerId` para codex/gemini/antigravity — i.e. a SUPERFÍCIE DE SPAWN documenta CLIs heterogêneos enquanto o ROSTER GATE de squad os proíbe a mid-mission. Superfície e enforcement estão em desacordo.

### 2. DOCUMENTED-CONTRACT (da própria documentação das tools — alta confiança, NÃO verificado ao vivo)

- **(a) HANDOFF-TEACHING ASSIMETRIA:** workers não-claude só reportam SE o DELEGADOR anexar `finally call handoff_submit({summary, status, artifacts})` ao prompt deles (per doc do `pane_spawn`: "for NON-claude CLIs end the prompt with 'finally call handoff_submit(...)'"). Essa linha anexada pelo delegador é o mecanismo habilitador.
- **(b)** workers claude são ensinados per-session pelo app, com um Stop-hook que os BLOQUEIA de parar até que entreguem o handoff (doc do handoff_submit + o artefato de runtime da Lane-1 `~/.overclock-app/handoff-stop.mjs`: AUTO_MARK `[auto]`, `closedBy:'stop-hook'`). Não-claude não possuem essa rede de segurança documentada → maior risco de non-report silencioso.
- **(c) SUPERFÍCIE DE SPAWN:** agent / providerId / model por registry de provider; `effort` mapeado POR CLI — claude & grok low..max, codex low..xhigh, gemini & antigravity NÃO têm knob de effort (ignorado). Assimetria de controle de harness.

### 3. UNVERIFIED-LIVE (pendente)

- Latência de boot por CLI; task-at-birth via argv para não-claude; reaping pós-handoff por CLI (TTL default).
- **Aguardando captura viva — possível via pane aberto manualmente pelo usuário (+PANE), fora do gate de roster.**

### Implicação de design para o Nexus

O Nexus já vincula providers POR MEMBRO (P0-2 / reroute-within-roster: `provider_reroute_json`, migração 027; `src/main/orch/provider-reroute-policy.ts`; router multi-LLM em `src/main/orch/task-router.ts`) E já enforça binding multi-CLI por membro no caminho agêntico (`tools-panes.ts:390-402`). Isso significa que o Nexus **JÁ EXCEDE** o comportamento observado do Overclock em diversidade de frota — buscar paridade NESTE eixo seria uma REGRESSÃO (formalizado como eixo (a) em §(f)). Multi-CLI é comportamento REALIZADO do Nexus, não meta pendente; o shim per-CLI de handoff-teaching (item 2a) **já está implementado** e é incondicional (`tools-panes.ts:157-167`, `mission-dispatch-kickoff.ts:447`, `worker-handoff-contract.ts:76`), não uma peça a construir. Cross-ref `src/shared/failover-handoff.ts`.

### Assimetrias-chave (ranqueadas)

1. **AUTORIDADE DE SPAWN** (observed-enforced, a mais forte): não-claude não pode sequer ser instanciado numa squad mission em nenhum tier — a assimetria precede o runtime.
2. **HANDOFF-TEACHING** (documented): claude auto-ensinado + Stop-hook obrigatório; não-claude só reporta se o delegador anexar a linha — sem rede de segurança → risco de non-report silencioso.
3. **KNOB DE EFFORT** (documented): claude/grok/codex têm tiers; gemini/antigravity não → assimetria de controle de harness.
4. **REAPING / LATÊNCIA** (unverified): pendente de captura viva.
