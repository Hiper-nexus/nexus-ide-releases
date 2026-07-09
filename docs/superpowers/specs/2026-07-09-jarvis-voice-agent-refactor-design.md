# JARVIS Voice Agent — Senior Analysis & Refactor Design

**Date:** 2026-07-09
**Status:** Approved by owner (design); pending implementation plan
**Scope:** `src/main/voice`, `src/renderer/voice`, `src/main/jarvis`, `src/shared/voice-*`, plus a new codegen dispatch seam

## 1. Vision

An Iron-Man-style voice agent that coordinates the whole Nexus IDE by voice:

- Converses with the owner in **PT-BR** (STT + spoken replies).
- Reads the current IDE context (active pane, file, selection, visible errors) to ground actions.
- Executes actions in Nexus through a typed tool catalog.
- Turns a spoken PT-BR request into an **engineered English prompt** and dispatches it to an
  **external coding CLI** (Claude Code / Codex), watches the run, and speaks a real PT-BR
  result summary back — not a canned ack.
- Runs on **Gemini Live or OpenAI Realtime behind one provider interface**; the shipped
  default is decided by measurement, not on paper. Classic pipeline remains the
  always-available graceful degrade.

**Owner decisions locked in:**

| Decision | Choice |
|---|---|
| Codegen target | External CLI (Claude Code / Codex) via **headless structured dispatch** (no TTY scraping) |
| Realtime providers | Both Gemini Live and OpenAI Realtime behind one interface; Gemini default now; measured A/B decides final default |
| Delegation confirmation | **Voice confirmation** ("confirmo?") for code delegation; native OS modal only for destructive actions |
| Screen reading scope | Structured text++ (selection + visible diagnostics); pixel vision is out of scope |
| Competitor code | **No source copying from Overclock** (legal risk). Clean-room behavioral analysis only |

## 2. Diagnosis (verdict: refactor, not rebuild)

The hard primitives already exist and are tested: `TurnExecutionOwner`,
`RealtimeTranscriptWaiter`, realtime-ownership, the immutable FSM in `jarvis-live.ts`, the pure
gate/suppression/coalescer modules, a layered provider interface, and a brain cascade with
deadlines and graceful fallback. They stay.

**Single root cause: no single owner of the turn lifecycle.**

- State is an untyped mutable blackboard: `src/renderer/voice/voice-session-state.ts` exports
  15+ `let` flags mutated from ~8 modules with no invariants.
- Phase is split across two divergent enums (`VoiceUiStatus` renderer-side vs
  `JarvisLiveState` main-side) written from 38 unchecked call sites. Contradictory states are
  representable and occur.
- Cancellation is not a threaded token: greeting/rebuild/follow-up timers fire after teardown
  or after a newer wake.
- Two independent reconnect authorities (live-transport-controller + gemini-live-transport)
  fight over one WebSocket — the mechanical root of "two voices", "HUD vanished", and muted
  zombie sockets.

### Critical findings (verified in code)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| C1 | CRITICAL | macOS phantom TCC grant delivers `rms:0` while "granted" → wake unreachable. Plus: STT failure pins status at `transcribing`; `onWake` early-returns forever | `TASK/items/WAKE-BROKEN-001.md`; `wake-engine.ts` (threshold 0.48); `voice-controller.ts` onWake guard |
| C2 | CRITICAL | `finishAndProcess` has ~20 early returns, each individually responsible for `openLiveAudioGate()`; one missed exit = permanent silence (the documented stuck-mute bug) | `voice-finish-and-process.ts` L162 comment; gate calls scattered at L168/173/179/268/314/325/340/378 |
| C3 | CRITICAL | `send_to_pane` (code-task path) has **no confirmation gate** and a silent target fallback (askingPane→orchestrator→focusedPane) that can type an engineering brief into a bare bash shell, or fire on a misheard/injected utterance | `jarvis-action-executor.ts:456-472`; `jarvis-brain.ts:85-99` (doctrine is soft guidance only) |
| H1 | HIGH | Two-tier reconnect race on one socket | `live-transport-controller.ts` L80-82,762; `gemini-live-transport.ts` L232-233,358-362 |
| H2 | HIGH | Mutable blackboard + dual phase enums (above) | `voice-session-state.ts`, `voice-store.ts`, `jarvis-live.ts` |
| H3 | HIGH | Cancellation not threaded through timers | `voice-controller.ts` beginListening; `live-followup.ts` polls |
| H4 | HIGH | Self-talk loop: mic reopens into JARVIS's own ~20s TTS tail with AEC off; fixed 1200 ms suppression lapses mid-speech; text-only echo guard misses garbled STT; live micIn streams raw PCM with no input echo guard | `voice-suppression-window.ts`, `live-local-audio-gate.ts`, `transcript-filter.ts` |
| M1 | MEDIUM | Action vocabulary duplicated across 5 surfaces; system prompt exists in 4 copies (one dead: `jarvis-live-prompt.ts`) | `shared/voice-ipc.ts` L235-263,439-466; `voice-realtime-actions.ts`; `jarvis-brain.ts` |
| M2 | MEDIUM | Machine-channel doctrine (English-to-panes) only exists in Classic brain prompt; realtime path would leak raw PT-BR to panes. `translate` hinges on one runtime override contradicting `DEFAULT_VOICE_CONFIG` | `jarvis-brain.ts:96-99` vs `prompts/system.en.md`; `voice-finish-and-process.ts:441` |
| M3 | MEDIUM | Report-back loop not closed: after `send_to_pane` user gets a canned PT ack; `captureResponse` exists but is not wired to this path | `voice-run-jarvis-turn.ts:250-289` |
| M4 | MEDIUM | Hot modules oversized: finishAndProcess 578 (one ~490-line fn), voice-controller 685, live-transport-controller 787 (self-casts `this as ToolDispatchHost`), gemini-live-transport 699, jarvis-brain 700, jarvis-action-executor 551 (~370-line if-ladder) | `wc -l` verified |
| L1 | LOW | Wake ONNX on main thread; 4.9 MB base64 models embedded in `.ts`; sessions not disposed | `wake-engine.ts`, `wake-models.ts` |

**Open diagnostic:** duplicate audio may also come from a cross-app collision (Overclock voice
sidecar has independent locks; single-instance log does not rule it out — see memory note).
Phase 0 adds instance/lock logging to attribute "two voices" correctly before we claim the
reconnect collapse eliminates the class.

## 3. Target architecture

One coordinator, one phase, one cancellation token, one reconnect policy. Everything proven
stays; four seams are added.

### 3.1 Shared contracts — `src/shared/voice/` (dependency-free)

- **`voice-phase.ts`** — canonical enum
  `Phase = idle | wake | listening | thinking | acting | speaking | error` plus a
  machine-checked `TRANSITIONS: Record<Phase, readonly Phase[]>` table. `VoiceUiStatus` and
  `JarvisLiveState` become projections; exactly one phase is mirrored over IPC.
- **`action-registry.ts`** — single source of the action vocabulary:
  `ActionDef { id, argsSchema (zod), risk: 'safe'|'confirm'|'destructive', paths: ('classic'|'realtime')[], summaryPt }`.
  Derives the `JarvisAction` union, `SAFE_REALTIME_ACTIONS`, the live tool-result enum,
  `mapActionToTool` routing, and the prompt catalog fragment. Adding an action = one edit.
- **`prompt-doctrine.ts`** — the ONE language-channel + engineering-prompt fragment (PT `say` /
  English `action.text`, never raw Portuguese to a pane). Injected into brain prompt, realtime
  `system.en.md`, and factory fallback. Dead `jarvis-live-prompt.ts` is deleted.
- **`language-guard.ts`** — pure heuristic used as defense-in-depth (§3.5). No new dependency.

### 3.2 Turn coordinator — `src/main/voice/coordinator/`

- **`turn-machine.ts`** — small reducer that is the **sole writer** of `Phase`.
  `dispatch(event)` validates against `TRANSITIONS`; illegal moves are rejected and logged.
  Every phase has a watchdog-backed guaranteed exit ("never deadlocks" becomes structural).
  Emits one phase event to the renderer HUD.
- **`cancellation.ts`** — a `CancellationToken` minted per turn (extends today's
  `turnExecution.token`), threaded through **every** timer: grace, idle, reconnect,
  tool-result, question-poll, releasePoll, hard-rebuild, follow-up. New wake or teardown
  cancels the token and aborts all in-flight work.
- `voice-session-state.ts` stays as the storage seam, but its `let` flags move behind typed
  transitions; ad-hoc setters are removed from callers.
- **Kill-switch:** config flag `voice.coordinatorV2` (default **off** until validated in the
  field). Off = legacy path untouched. Classic remains the degrade target regardless.

### 3.3 Provider abstraction — extend existing `src/main/jarvis/realtime/provider.ts`

Keep `RealtimeProvider → RoleAwareRealtimeProvider → TurnManagedRealtimeProvider` and the
factory cascade (gemini → openai → classic) with degrade observability. Add exactly one thing:

- **`ReconnectSupervisor`** — the single reconnect/watchdog/backoff/stale-socket authority,
  consumed by both providers. Transports own the raw socket only. Primary justification:
  collapsing Gemini's own two-tier reconnect race (field bug today) — provider symmetry is a
  by-product, not the driver.
- Controller stops casting `this as ToolDispatchHost`; it receives an injected host object.
- **No OpenAI-specific stability investment before the supervisor lands** (would be throwaway).

### 3.4 Turn lifecycle (one path; both transports converge)

```
idle → wake (open gate; greeting bound to token)
     → listening (wake-mic hot; Live PCM through live-local-audio-gate)
     → thinking (Classic: STT+brain | Realtime: provider decides)
     → acting (single dispatch map; TurnExecutionOwner.claim)
     → speaking (TTS or provider audio)
     → idle | reply-follow-up
```

- Every arrow is a validated transition; every phase has a watchdog exit.
- **Barge-in vs suppression (resolved):** during `speaking`, full STT is suppressed for the
  measured real playback duration (from `playAudioBase64`'s returned duration), but the wake
  engine stays hot in **keyword-only mode** with the echo guard applied. Barge-in = wake word
  or PTT during `speaking` → one `speaking→listening` transition that owns
  stopPlayback + gate-open + provider `interrupt()`. You can always interrupt by name; the mic
  never free-listens into the TTS tail.
- The mute invariant is structural: `finishAndProcess` is wrapped so `openLiveAudioGate()`
  runs in a `finally` on every exit path, then split into small pure decision functions
  returning a typed `TurnDecision`.

### 3.5 PT-BR-in / English-codegen pipeline (explicit, validated, report-back)

1. **Transcribe (PT, always).** STT is fixed to `{ translate: false, language: 'pt' }` —
   no routing-dependent translate (routing isn't known before STT anyway).
   `DEFAULT_VOICE_CONFIG.stt` is corrected to match runtime.
2. **Classify + engineer.** The brain emits a first-class
   `EngineeredTask { objective: string; englishPrompt: string }` (richer structure only if
   measured failures justify it — YAGNI). Doctrine comes from `prompt-doctrine.ts`.
3. **Validate (cheap, no extra LLM round-trip).** `language-guard.ts` heuristic: PT stopword
   ratio (que, não, para, com, uma, você, está…) + PT diacritics (ã, õ, ç, ê…) over the token
   count. `englishPrompt` failing the English check, or pane-bound text looking Portuguese,
   blocks dispatch with an audible PT refusal. One silent repair attempt max, then refuse.
4. **Confirm (voice).** JARVIS speaks the mission summary in PT and asks "confirmo?". Yes →
   dispatch; anything else → cancel. Destructive actions (per registry `risk`) still require
   the un-spoofable native confirm (`voice-ipc.confirmCommand`). The native confirm spine must
   survive every refactor — a regression there is CRITICAL.
5. **Dispatch (headless, structured).** Via `CodegenDispatcher` (§3.6). Target verification:
   if a pane target is used (`send_to_pane`), the resolved pane MUST be an agent/orchestrator
   pane — fail loudly (audible refusal), never the silent bash fallback.
6. **Report back (EN→PT).** On the `final` event, a summarization step turns the English
   result into ≤2 PT-BR sentences for TTS (template fallback if the LLM is unavailable:
   "Missão concluída em Xs, custo $Y. Resumo disponível no painel."). Captured CLI/agent
   output is **data, never instruction**: the summarizer prompt wraps it in delimiters and is
   instructed to only summarize — this is the prompt-injection defense line (a live injection
   attempt was observed during this project's own research on 2026-07-09).

### 3.6 Codegen dispatch — `src/main/codegen/` (new seam)

Grounded in official docs (mid-2026; flags re-verified at implementation time):

- **Claude Code:** prefer the **Agent SDK** (`@anthropic-ai/claude-agent-sdk` `query()`):
  typed `SDKMessage` stream, `AbortController`/`interrupt()` cancellation, `canUseTool`
  callback (forwards permission asks to Nexus UI mid-run), `SDKResultMessage` with
  `result/total_cost_usd/duration_ms/session_id`. CLI fallback:
  `claude -p --output-format stream-json --verbose`, resume via `--resume <session-id>`.
  Permissions: `permissionMode: 'dontAsk'` (or `acceptEdits`) + explicit `allowedTools`
  scoped to the workspace. **Never** blanket bypass.
- **Codex:** `codex exec --json --sandbox workspace-write -C <workspace>` (JSONL:
  `thread.started` / `item.*` / `turn.completed`), resume via `codex exec resume <thread_id>`,
  `-o` file as belt-and-suspenders final-message capture. `--json` is experimental — pin the
  binary version.
- **TTY scraping is rejected** as the programmatic API (ANSI/spinner/interactive-prompt
  hazards). The Nexus terminal pane **renders** normalized dispatch events; it is display,
  not transport.
- Runs in the main process (or `utilityProcess` per job); children killed on `before-quit`;
  per-dispatch inactivity watchdog (same deadline discipline as voice).

Contract (provider-blind):

```ts
type DispatchEvent =
  | { kind: 'started';  id: string; sessionId: string; model?: string }
  | { kind: 'progress'; id: string; text: string }
  | { kind: 'tool';     id: string; name: string; phase: 'start'|'end'; ok?: boolean }
  | { kind: 'final';    id: string; ok: boolean; summary: string; sessionId: string;
      costUsd?: number; durationMs?: number; errorSubtype?: string }
  | { kind: 'error';    id: string; message: string; fatal: boolean };

interface CodegenDispatcher {
  dispatch(req: DispatchRequest): AsyncIterable<DispatchEvent>;
  cancel(id: string): void;
}
```

### 3.7 Screen context (structured text++)

Extend the existing clamp+coalesce path (no pixel vision):

- Selection model: file, cursor line, language, clamped `selectedText`.
- Visible diagnostics: LSP problems or trailing terminal error scrape.
- Replace the `isScreenContext` string-sniff with a typed envelope
  `{ kind: 'screen' | 'tool' | 'wake' }` through the `ScreenCoalescer`.

## 4. Provider strategy

**Ship Gemini Live as default now; keep OpenAI Realtime behind the same interface; Classic
never retires (graceful degrade).** Grounds: config already defaults to `gemini-live`
(`voice-config.ts:116,138,318`); the Gemini transport has the mature stability machinery
(singleton guard, connectionGeneration, progress watchdog, session resumption, TurnQueue +
ScreenCoalescer); OpenAI's transport currently has thinner recovery. After the
ReconnectSupervisor lands (equal resilience), run the head-to-head through the existing
`metrics.ts` (audio-in→transcript, transcript→action/audio, roundtrip, per-session JSONL) and
confirm or switch the default. Don't block shipping on the A/B; don't pick the final default
on paper.

## 5. Phased plan (each phase ships alone; sequencing corrected per adversarial review)

### Phase 0 — Unblock + kill the CRITICALs (all independent of the coordinator)

1. **C1a:** startup mic-liveness probe — sustained `rms:0` despite "granted" → guided
   `tccutil reset` + re-Allow flow (keep the `com.nexuside.dev` dev identity path).
2. **C1b:** watchdog-forced exit from `transcribing` so a failed STT can never permanently
   gate `onWake`.
3. **C2:** wrap `finishAndProcess` body so `openLiveAudioGate()` runs in `finally` on every
   exit path. (Full decomposition of the function waits for Phase 1; the invariant lands now.)
4. **C3:** `send_to_pane` hardening — verify target is an agent/orchestrator pane, fail
   loudly; add the voice-confirm gate for code delegation; native confirm for destructive.
5. **H4:** self-talk — tie suppression to measured real playback duration; extend input
   echo/noise guard to the live micIn path; cap reply-loop reopen into the TTS tail.
6. Observability: degrade-reason + per-turn latency log line; instance/lock logging to
   attribute "two voices" (internal race vs cross-app collision) before Phase 1 claims the fix.

### Phase 1 — Coordinator + stability (split into 4 independently shippable slices)

- **1a. CancellationToken** threaded through every timer (behind `voice.coordinatorV2`).
- **1b. Phase enum + turn-machine** as sole phase writer; project both legacy enums; collapse
  the 38 setStatus sites to dispatched moves; fold blackboard flags behind transitions.
- **1c. ReconnectSupervisor** — one reconnect authority; transports own raw sockets only;
  remove the `ToolDispatchHost` self-cast (injected host object).
- **1d. Decompose the hot functions** (finishAndProcess → typed `TurnDecision` producers;
  barge-in as the single `speaking→listening` transition).
- **Test plan (new code is the risk):** property tests on the transition table (every
  dispatch from every phase is legal-or-rejected; every phase has a watchdog exit);
  cancellation tests (all registered timers die on cancel); ReconnectSupervisor tests over a
  scripted fake socket (drop/timeout/zombie sequences); finally-invariant test for the gate;
  existing pure-module tests preserved.

### Phase 2 — Single source of vocabulary + confirmation

1. `action-registry.ts` as single source; derive all 5 surfaces.
2. Extract SYSTEM_PROMPT to a versioned prompt file; `prompt-doctrine.ts` injected into brain
   + realtime `system.en.md` + factory fallback; delete `jarvis-live-prompt.ts`.
3. Collapse `executeJarvisAction`'s ~370-line ladder into a typed dispatch map (exhaustiveness
   from the union).
4. Uniform confirm gate keyed by registry `risk` (voice-confirm for `confirm`, native for
   `destructive`); consolidate the three `findOrchestratorPane` copies.

### Phase 3 — PT→EN pipeline + CodegenDispatcher

1. `EngineeredTask { objective, englishPrompt }` as a first-class, tested step.
2. `language-guard.ts` (stopword/diacritic heuristic) blocking + one repair attempt.
3. STT simplification: always `translate:false, language:'pt'`; fix config default.
4. `src/main/codegen/` dispatcher: Claude Code (Agent SDK) + Codex (`exec --json`) providers,
   event normalization, watchdog, cancel; renderer renders events in the terminal pane.
5. Report-back: `final` event → EN→PT summarization (injection-safe, delimiter-wrapped) →
   spoken PT summary; wire `captureResponse` on the pane path for legacy agents.

### Phase 4 — Intelligence, grounding, measured A/B

1. Provider A/B through `metrics.ts`; confirm or switch the default.
2. Screen-context++: selection model + visible diagnostics; typed context envelope.
3. Routing observability: log intent (chit-chat/action/code-task) + source per turn.
4. Wake ONNX to a worker thread; revisit 4.9 MB base64 models (packaged asset vs
   offline-guarantee tradeoff); ensure ONNX dispose.
5. Memory: deterministic capture in addition to LLM discretion; surface silent persistence
   failures.

### Separate XL workstream (tracked independently, not in this refactor)

Planning contract: replace the two-hop free-text stdin kickoff with a structured
mission handoff (typed `EngineeredTask` → orchestrator), or give the brain direct
task-router access. Decide + prototype after Phase 3 is stable.

## 6. Non-goals

- No rebuild of the audio engine or wake pipeline (proven primitives stay).
- No pixel-vision screen reading in this cycle.
- No source copying from Overclock; behavioral benchmarking only.
- No UI reskin — the pixel/operator aesthetic stays; HUD changes limited to projecting the
  single Phase.
- No OpenAI-specific stability work before the ReconnectSupervisor exists.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Coordinator refactor regresses field-stable behavior | `voice.coordinatorV2` kill-switch; phases ship alone; Classic degrade always on |
| Self-talk fix (acoustic, AEC-off) stalls Phase 0 | It's scoped to suppression-by-measured-duration + input guard; keyword-only barge-in is the escape hatch, not full AEC |
| Codex `--json` schema drift | Pin binary version; `-o` file fallback for final message |
| Injected/misheard utterance triggers delegation | Voice-confirm gate + language guard + injection-safe summarizer + native confirm for destructive |
| "Two voices" is cross-app, not internal | Phase 0 instance/lock logging attributes it before Phase 1 claims the fix |
