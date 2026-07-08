# VOICE-PARITY-001 — JARVIS fluidity parity (nexus ↔ overclock)

## Summary

The user's fluidity complaint traces to a single architectural fork: nexus ships **Classic** (discrete wake→STT-batch→brain→TTS turns) as its production default, while Overclock runs a **live full-duplex Gemini realtime socket** (streaming audio in/out, server-side barge-in, server-side incremental transcription, hot session reuse). Every axis gap — latency, streaming, barge-in, listening continuity — reduces to *discrete-turn Classic* vs *live socket*. Critically, the Overclock reference is **not theoretical**: its sidecar is REACHABLE and code-verified at `/Applications/Overclock.app/Contents/Resources/sidecar/dist`, so every reference behavior below is anchored to a real `file.js:line`. nexus already contains the fluid ceiling — a complete realtime/gemini-live transport — but it is compiled and **hibernated** (`transport === 'classic'` → `resolveRealtimeProviderIds` returns `[]`, no socket ever opened). This report identifies **10 prioritized gaps**; it is a scout report and proposes no implementation.

## Current state (nexus) — per axis, with file:line evidence

### Latency
- Wake ACK ("Pois não?") is spoken and **fully awaited** before the listen mic opens on both paths — `src/renderer/voice/voice-controller.ts:750` (voice 750-758, click 737-745). Voice path snapshots `WAKE_PREROLL_MS` pre-roll at `:730`; click has no pre-roll so words during ACK are dropped by design.
- A **cold** ACK inserts a full TTS network round-trip before the mic opens — `src/renderer/voice/voice-wake-ack.ts:82` (`SPEAK_DEADLINE_MS = 40_000`, tail guard 180ms at `:91`; `warmAckCache` at `:61-76`).
- STT→brain→action→TTS are **strictly serial, no speculative overlap** — `src/renderer/voice/voice-controller.ts:1367` (brain awaits transcribe at `:1239-1249`, action at `:1392`, first spoken token at `:1443`). Perceived latency = STT + brain + action + first-TTS, fully additive.
- The instant "think filler" that masks STT+brain latency is **skipped on the primary voice-wake path** — `src/renderer/voice/voice-controller.ts:1228` (gate `1228-1232`, `activeCaptureReason !== 'wake'`). Normal "Hey Jarvis" turns hear silence end-of-speech → brain reply.
- Wake capture cannot close for `WAKE_MIN_LISTEN_MS = 3_200` (voice) / `2_400` (click) — `voice-controller.ts:92`; stop logic `src/renderer/voice/wake-mic.ts:255-263`. Hard latency floor even when the user finishes early.
- STT walks a **serial provider chain**, each failing provider burns its full timeout — `src/main/voice/stt-service.ts:282` (`STT_CLOUD_TIMEOUT_MS = 12_000`, `STT_LOCAL_TIMEOUT_MS = 30_000`; local whisper.cpp spawns a fresh subprocess per call at `:50-58`, no warm process).
- Brain walks a serial chain too — `src/main/voice/jarvis-brain.ts:495` (`BRAIN_TIMEOUT_MS = 15_000` per attempt, `BRAIN_DEADLINE_MS = 35_000` at `voice-controller.ts:106`); regex fast-paths at `:471-476` bypass the LLM for imperatives.
- Wake detector one-time ONNX cold start + `DEBOUNCE_MS = 2_500` — `src/main/voice/wake-engine.ts:101` (`THRESHOLD = 0.48`).
- Post-reply reopen fixed `REPLY_LISTEN_DELAY_MS = 700` + dynamic suppression — `src/renderer/voice/jarvis-reply-loop.ts:8`, applied `voice-controller.ts:1456-1464`.
- TTS is pipelined first-sentence/rest — `voice-controller.ts:651` (`SPEAK_DEADLINE_MS = 40_000`).

### Streaming
- Classic STT is **fully batch**: the entire utterance WAV is one request, full transcript awaited — `src/main/voice/stt-service.ts:135-179` (`response_format:'json'`, no SSE/partial). No transcript dispatched until the utterance finalizes (`voice-controller.ts:1072-1074`, transcribe `1239-1249`).
- Local whisper.cpp also batch — whole WAV to disk, `-otxt -nt`, full file read — `src/main/voice/stt-service.ts:234-246`.
- TTS synthesis is batch per segment: whole audio body buffered before playback — `src/main/voice/tts-service.ts:195-231` (Piper concats all stdout at `131-161`).
- Pipelining exists only at **sentence granularity** — `voice-controller.ts:651-670`; split caps first segment at 180 chars — `src/renderer/voice/speech-segments.ts:6-28`.
- Playback is **decode-whole-then-play** (`decodeAudioData` over the entire segment) — `src/renderer/voice/voice-playback.ts:44-65`. No progressive playback within a segment.
- The **only true audio streaming** path (gapless PCM 24kHz queue, per-frame mic up) is the hibernated realtime transport — `src/renderer/voice/live-audio.ts:78-106`, gated by `isRealtimeLive` at `voice-controller.ts:171-180`.

### Barge-in
- Voice barge-in is **HALF-DUPLEX**: wake detection is software-gated off while JARVIS speaks — `src/renderer/voice/wake-mic.ts:388` (`if (Date.now() < wakeSuppressedUntil) return;` before `sendWakeAudio` at `:392`). Mic stream keeps running; detection is muted.
- Post-TTS suppression is a **dynamic 3.5s–12s window**: `min(12_000, max(3_500, sayText.length*70 + 2_000))` — `voice-controller.ts:1456` (comment `1453-1455` says reopening the mic during TTS caused a feedback loop). A ~143-char reply pins the 12s ceiling.
- ACK gets fixed `WAKE_ACK_SUPPRESS_MS = 8_000` — `voice-controller.ts:89` (applied `732/738/751`).
- Barge-in **only via orb/click** (or a fresh wake once suppression lapses) — `voice-controller.ts:710` (`stopAllPlayback()` 710, `cancelUtterance()` 711, `liveInterrupt` 726-727). Click cuts TTS anytime; voice cannot mid-TTS.
- Command-capture also withholds frames from the detector — `wake-mic.ts:384`.
- Transcript-level echo layer — `src/main/voice/echo-suppress.ts:49` (≥80% word overlap, 300-char/60s window; `recordEcho` at `voice-controller.ts:511,1451`).
- Realtime audio-out re-arms 1.2s deaf slices per chunk — `voice-controller.ts:220`.

### Fallbacks & watchdogs
- STT fallback sequential/error-driven — `src/main/voice/stt-service.ts:282-293`; a **hung** cloud provider burns 12s each (24s for two) before local — `:43-44,150-158` (under `TRANSCRIBE_DEADLINE_MS = 60_000`).
- Brain double-hang (15s+15s=30s) can let `BRAIN_DEADLINE_MS = 35_000` cut off both the 3rd provider **and** the graceful local fallback (which runs only after the loop at `:517-520`) — `src/main/voice/jarvis-brain.ts:412,440-448,495-521`, deadline `voice-controller.ts:106`. The graceful fallback is unreachable when most needed.
- Local brain fallback is a **canned** context-aware reply, not a local LLM — `jarvis-brain.ts:347-369,517-520` (commit e5996d0).
- TTS chain ends in keyless macOS `say` + `TTS_STICKY_FALLBACK_RETRY_MS = 60_000` — `src/main/voice/tts-service.ts:42,70-71,284-337`.
- Local whisper/Piper run async with SIGKILL timeouts (no event-loop freeze) — `stt-service.ts:50-58`; `tts-service.ts:131-161`.
- Homebrew PATH hardening for keyless local STT — `stt-service.ts:191-194,238-242` (commit 6c5ca68).
- Wake-lock PID mutex — `src/main/voice/wake-lock.ts:71-95,40-48` (no timers).
- Renderer `withTimeout` belt-and-suspenders — `voice-controller.ts:101-131,1239-1249,1367-1375`.

### Listening continuity
- Classic is **turn-scoped, not always-listening**: after speaking, the mic reopens only if the brain flags `expectReply`; otherwise the turn ends and the user must re-wake — `voice-controller.ts:1459-1467`.
- `wantsReply` driven by `expectReply` (+ confusion/realtime overrides) — `src/renderer/voice/jarvis-reply-loop.ts:54-74`. Default is drop-mic.
- Anti-loop cap `MAX_AUTO_REPLY_LOOPS = 5` forces re-wake mid-conversation — `jarvis-reply-loop.ts:9,61-64` (increment at `voice-controller.ts:1463`).
- **Only** the realtime transport gives true always-listening — `jarvis-reply-loop.ts:1-6,65` (requires `realtimeTurnActive && isRealtimeLive`).
- Reopen fixed 700ms handoff + wake-suppression — `voice-controller.ts:1456-1464`.
- Voice/click share one handler, differ in ordering — `voice-controller.ts:704-758,674-687`.
- Click ACK reordered before capture — `voice-controller.ts:733-746` (commit c27d36b).
- Click min-listen 8000→2400ms, realtime-transcript wait honors local speech — `voice-controller.ts:94,1113-1123` (commit e9953b9).

## Reference (overclock) — per axis, code-verified [path] vs [inferred]

### Latency
- `delegar` returns an **immediate natural ack without awaiting the brain** — `send()` is fire-and-forget/enqueued, result narrated later. [code-verified: `/Applications/Overclock.app/Contents/Resources/sidecar/dist/JarvisService.js:970-985`]
- Coarse `delegar` tool routes heavy work to Claude brain; `consultar/ler/navegar` answered directly so the voice loop never blocks on the slow LLM. [code-verified: `.../GeminiLiveSession.js:810`]
- `contextWindowCompression.slidingWindow` truncates history so per-turn input cost stanches. [code-verified: `.../GeminiLiveSession.js:702`]
- Screen-update coalescing `SCREEN_UPDATE_DEBOUNCE_MS = 1500` collapses navigation bursts. [code-verified: `.../GeminiLiveSession.js:336`]
- Idle-timeout widened 90s→`IDLE_TIMEOUT_MS = 5min` to keep a warm sliding-window session, accepting ~1s relight. [code-verified: `.../JarvisService.js:420-429`]
- Harness annotate/propose default to cheap fast tier (`claude-sonnet-5`, effort low, thinking disabled). [code-verified: `.../harnessAssistant.js:19`]
- `voiceSafeText` strips code/JSON/mcp syntax so TTS output is shorter/faster. [code-verified: `.../voiceSafeText.js:21`]

### Streaming
- Input audio streamed as base64 **PCM 16kHz** chunks via `realtimeInput.audio`, each mic chunk sent immediately when WS OPEN. [code-verified: `.../GeminiLiveSession.js:292`]
- End-of-turn signalled with `realtimeInput.audioStreamEnd:true`. [code-verified: `.../GeminiLiveSession.js:287`]
- Output audio streamed as base64 **PCM 24kHz** `audio_chunk` events (`done:false`), flips `live_state` to 'speaking'. [code-verified: `.../GeminiLiveSession.js:750`]
- **Server-side streaming input transcription** (`inputAudioTranscription:{}`) emitted per message as `live_transcript role:user`. [code-verified: `.../GeminiLiveSession.js:695`]
- **Server-side streaming output transcription** (`outputAudioTranscription:{}`) emitted as assistant transcript. [code-verified: `.../GeminiLiveSession.js:769`]
- Brain reply **streamed token-by-token** to renderer; state flips to 'thinking' on `message_start`, 'speaking' on first `text_delta`. [code-verified: `.../JarvisService.js:2509-2520`]
- Final brain reply narrated back into the live session with menu-aware compression + 600-char cap. [code-verified: `.../JarvisService.js:2380-2388, 1571-1592`]
- Live prompt hard-caps response ('EXTREMAMENTE breve', 1-sentence acks). [code-verified: `.../jarvisLivePrompt.js:23`]
- Progress `[update]`s narrated one short sentence at a time. [code-verified: `.../jarvisLivePrompt.js:67`]

### Barge-in
- **Server-side barge-in** via `sc.interrupted===true`: emits `done:true` then a dedicated `interrupted` event → renderer `player.stop()` flushes already-scheduled buffers, `live_state='listening'`, releases turn queue. [code-verified: `.../GeminiLiveSession.js:794`]
- Echo suppression prevents Jarvis's own TTS returning through the mic from becoming a phantom command / false barge-in (substring or ≥80% word overlap vs `recentSpokenNorm`, 300-char cap). [code-verified: `.../GeminiLiveSession.js:761`]
- `turnComplete` emits final `done:true`, returns to listening, releases queue, resets per-turn counters. [code-verified: `.../GeminiLiveSession.js:803`]
- No explicit barge-in code in `JarvisService` — interruption/turn-cutting is delegated to `GeminiLiveSession`; this file only queue-serializes narration. [inferred: `.../JarvisService.js:642-644, 1628`]
- No barge-in/VAD/turn-cancellation in the six support files; lives in `JarvisService`/`GeminiLiveSession`. [inferred: `.../harnessAssistant.js:6`]

### Fallbacks & watchdogs
- `TURN_MAX_MS = 15s` circuit breaker releases the turn queue if a turn never signals completion. [code-verified: `.../GeminiLiveSession.js:393`]
- `SETUP_TIMEOUT_MS = 10s` watchdog terminates a stuck WS to force reconnect. [code-verified: `.../GeminiLiveSession.js:490`]
- Exponential-backoff reconnect (3 attempts, `2^n·1000ms`), error emitted only on exhaustion. [code-verified: `.../GeminiLiveSession.js:863`]
- Singleton session guard (F-133): at most one live session/process; orphans auto-terminate. [code-verified: `.../GeminiLiveSession.js:852`]
- Per-turn SDK progress watchdog `SDK_PROGRESS_TIMEOUT_MS = 30_000`, re-armed on every SDK message → abort + spoken/UI error. [code-verified: `.../JarvisService.js:40-42, 2461-2472`]
- Grace/warm session validated before reuse; ineligible zombie socket discarded, fresh connect (F-138). [code-verified: `.../JarvisService.js:466-481`]
- Turn errors classified into `timeout`/`auth`/`stream_error` typed outcomes. [code-verified: `.../JarvisService.js:2562-2578`]
- Cross-instance wake mutex lockfile (`~/.overclock-ssh/jarvis-wake.lock`, PID+isDev). [code-verified: `.../JarvisWakeLock.js:46`]
- Liveness treats `EPERM` as alive, only `ESRCH` as dead. [code-verified: `.../JarvisWakeLock.js:20`]
- Harness one-shot LLM passes 60s-bounded, degrade to empty. [code-verified: `.../harnessAssistant.js:52`]

### Listening continuity
- **Hot session reuse** (softStop keeps WS alive `graceMs`) preserves native-audio prosody across a quick re-toggle. [code-verified: `.../GeminiLiveSession.js:237`]
- `lastServerMsgAt` + `REUSE_FRESHNESS_MAX_MS = 120s` gate reuse; reuse currently **force-disabled** (server-side zombie risk) → always fresh connect. [code-verified: `.../GeminiLiveSession.js:172`]
- Pending mic buffer `PENDING_MIC_MAX_BYTES = 160000` (~5s): chunks between wake-HIT and `setupComplete` queued (oldest dropped), flushed on connect. [code-verified: `.../GeminiLiveSession.js:265`]
- `sessionResumption` handle captured and replayed in setup for resumable reconnects. [code-verified: `.../GeminiLiveSession.js:723`]
- Warm-socket reuse `LIVE_GRACE_MS = 90s` — `stopLive` soft-stops into `graceSession`, `startLive` promotes it as warm continuation skipping context re-injection. [code-verified: `.../JarvisService.js:570-580, 461-471, 416-419`]
- After idle-dormancy, next spoken chunk **transparently re-opens** the session; first-frame audio buffered in `pendingMic`, ~1s accepted latency, no greeting. [code-verified: `.../JarvisService.js:628-641`]
- Idle timer re-armed on real interactions; dormancy at 5min nulls session+history (billing zeroes) but **mode stays armed, mic keeps listening**. [code-verified: `.../JarvisService.js:593-627`]
- `liveHistory` (cap 40) survives socket death; reconnect within `RESUME_WINDOW_MS = 5min` injects last ~6 turns as `[reconexão]` so the model resumes. [code-verified: `.../JarvisService.js:408-415, 529-543`]
- Wake=HIT queues a spoken greeting as `pendingContext` before socket start, flushed at `setupComplete`. [code-verified: `.../JarvisService.js:554-561`]
- Final utterance deterministically routed to a pane with a pending narrated question (bypasses model). [code-verified: `.../JarvisService.js:496-505, 2131-2153`]
- Persisted memory injected into both brain and voice prompts so facts aren't re-asked. [code-verified: `.../JarvisMemory.js:75`]

## Prioritized gaps

Ranked by fluidity impact, then reach. Every gap cites a nexus `file:line`.

| # | Axis | nexus file:line | Overclock reference behavior | Fluidity impact | Suggested fix direction (DO NOT implement) | Builder complexity |
|---|------|-----------------|------------------------------|-----------------|--------------------------------------------|--------------------|
| 1 | Streaming | `stt-service.ts:135-179` (batch WAV, no partials) | Server-side streaming `inputAudioTranscription` [`GeminiLiveSession.js:695`] + PCM stream up [`:292`] | **High** | Reactivate the hibernated realtime transport (or add a streaming-STT provider) so partials appear before end-of-utterance | XL |
| 2 | Barge-in | `wake-mic.ts:388` + `voice-controller.ts:1456` (deaf 3.5–12s during TTS) | `sc.interrupted` → `player.stop()` [`GeminiLiveSession.js:794`] | **High** | Server-VAD/full-duplex barge-in via realtime transport; note Gemini `interrupt()` is a no-op, OpenAI-realtime does true `response.cancel` | XL |
| 3 | Latency | `voice-controller.ts:1367` (serial STT→brain→action→TTS) + `:1228` (filler skipped on wake) | Immediate `delegar` ack without awaiting brain [`JarvisService.js:970-985`]; token-by-token stream [`:2509-2520`] | **High** | Play a cached ack/filler on the wake path; overlap action/first-TTS with brain streaming | L |
| 4 | Listening continuity | `voice-controller.ts:1459-1467` (turn-scoped re-wake) | Idle-dormancy at 5min, mode stays armed, mic keeps listening [`JarvisService.js:420-429, 593-627`] | **High** | Keep the listen window hot across turns with a dormancy/idle model instead of `expectReply`-gated reopen | L |
| 5 | Latency | `voice-controller.ts:750` + `voice-wake-ack.ts:82` (ACK awaited before mic; cold = full TTS round-trip) | `pendingMic` buffers pre-`setupComplete` [`GeminiLiveSession.js:265`]; greeting queued as `pendingContext` [`JarvisService.js:554-561`] | Med | Open capture concurrently with the ACK and buffer pre-roll on both paths (click currently has none) | M |
| 6 | Latency | `voice-controller.ts:92` + `wake-mic.ts:255-263` (`WAKE_MIN_LISTEN_MS=3200` floor) | Server VAD ends turn via `audioStreamEnd` [`GeminiLiveSession.js:287`] | Med | VAD-based endpointing so a finished command closes without the fixed min-listen floor | M |
| 7 | Listening continuity | `tts-service.ts:284-337` (`stickyTtsProvider` pins provider, not prosody; cold synth per turn) | Warm-socket reuse `LIVE_GRACE_MS=90s` preserves prosody [`JarvisService.js:570-580`] | Med | Realtime session reuse (part of live transport) for prosody continuity | L |
| 8 | Fallbacks & watchdogs | `jarvis-brain.ts:495-521` + `voice-controller.ts:106` (35s deadline can cut off graceful local fallback) | Re-armed `SDK_PROGRESS_TIMEOUT_MS=30s` [`JarvisService.js:2461-2472`] | Med | Hedge/parallelize brain providers or trigger local fallback before the outer deadline can pre-empt it | M |
| 9 | Listening continuity | `jarvis-brain.ts:380-409` (last-8-turn window, no cross-reconnect resume) | `liveHistory` cap 40 + `[reconexão]` resume window 5min [`JarvisService.js:529-543`]; `contextWindowCompression` [`GeminiLiveSession.js:702`] | Low-Med | Persist conversation state across session/socket death with a resume window | M |
| 10 | Streaming | `voice-playback.ts:44-65` (decode-whole-then-play per segment) | Gapless PCM 24kHz queue [`live-audio.ts:78-106`, present but hibernated] | Low | Progressive/gapless chunk playback (already implemented in the dormant live path) | M |

## Parity acceptance criteria — measurable

Numbers derived from the constants found in the codebase.

- **Wake → ACK start < 200ms** on the hot path. The warm `ackCache` plays instantly plus `WAKE_ACK_TAIL_GUARD_MS = 180` (`voice-wake-ack.ts:91,94-95`); the cold `SPEAK_DEADLINE_MS = 40_000` round-trip must **never** occur on a normal wake (warm cache guaranteed post-`warmAckCache`).
- **Time-to-first-audio < 1000ms** from end-of-speech. Overclock accepts ~1s only on the first post-dormancy utterance (`JarvisService.js:628-641`); the fluid target is sub-second by streaming or an immediate ack. Today this is additive `STT + brain + first-TTS` (up to `STT_CLOUD_TIMEOUT_MS = 12_000` + `BRAIN_TIMEOUT_MS = 15_000` on cold paths).
- **Voice barge-in cutoff < 300ms** while JARVIS is speaking. Currently a spoken interrupt is blocked for `min(12_000, max(3_500, len*70+2_000))` ms (`voice-controller.ts:1456`); Overclock cuts on the `interrupted` event effectively immediately (`GeminiLiveSession.js:794`).
- **No re-wake needed within a session window of ≥10 turns / ≥300s.** Match `IDLE_TIMEOUT_MS = 5min` and `RESUME_WINDOW_MS = 5min` (`JarvisService.js:420,529-543`), and lift the `MAX_AUTO_REPLY_LOOPS = 5` re-wake trigger (`jarvis-reply-loop.ts:9`) as the continuity ceiling.
- **STT partial transcript visible < 500ms after speech onset.** Today time-to-first-transcript = full-utterance-capture (`WAKE_MIN_LISTEN_MS = 3_200` floor) + one round trip; server-side `inputAudioTranscription` (`GeminiLiveSession.js:695`) is the reference for incremental partials.
- **Command end detected by VAD, not a fixed floor:** a finished command should close in ≤ `WAKE_SILENCE_MS = 1_200` after last speech, without waiting out the 3.2s min-listen (`wake-mic.ts:255-263`).

## File clusters & anti-collision lanes

A future builder owns exactly one lane per gap so parallel work does not collide.

- **wake/capture** (gaps 4, 5, 6): `src/renderer/voice/wake-mic.ts`, `src/main/voice/wake-engine.ts`, `src/renderer/voice/voice-capture.ts`, `src/renderer/voice/voice-wake-ack.ts`, `src/renderer/voice/wake-rearm.ts`, `src/renderer/voice/agc.ts`, `src/main/voice/wake-lock.ts`.
- **STT** (gap 1): `src/main/voice/stt-service.ts`, `src/main/voice/transcript-filter.ts`, `src/main/voice/voice-secrets.ts`.
- **TTS/playback** (gaps 7, 10): `src/main/voice/tts-service.ts`, `src/renderer/voice/voice-playback.ts`, `src/renderer/voice/speech-segments.ts`, `src/renderer/voice/live-audio.ts`.
- **brain** (gaps 8, 9): `src/main/voice/jarvis-brain.ts`, `src/main/voice/echo-suppress.ts`.
- **orchestrator/state-machine** (gaps 3, 4): `src/renderer/voice/voice-controller.ts`, `src/renderer/voice/jarvis-reply-loop.ts`. *(High-churn hub — gaps 3 and 4 both touch it; sequence, don't parallelize, within this file.)*
- **live-transport** (gaps 1, 2, 7): `gemini-live-transport.ts`, `gemini-live-provider.ts`, `openai-realtime.ts`, `factory.ts` (`resolveRealtimeProviderIds`), `live-transport-controller.ts`, `provider.ts`. *(Reactivating this lane is the single largest lever — gaps 1, 2, 7, and 10's gapless playback all resolve here.)*

## Evidence appendix

**nexus files cited (all under `/Users/cleofasrocha/dev/nexus-ide/`):**
- `src/renderer/voice/voice-controller.ts`
- `src/renderer/voice/voice-wake-ack.ts`
- `src/renderer/voice/wake-mic.ts`
- `src/renderer/voice/jarvis-reply-loop.ts`
- `src/renderer/voice/speech-segments.ts`
- `src/renderer/voice/voice-playback.ts`
- `src/renderer/voice/voice-capture.ts`
- `src/renderer/voice/live-audio.ts`
- `src/renderer/voice/agc.ts`
- `src/main/voice/stt-service.ts`
- `src/main/voice/tts-service.ts`
- `src/main/voice/jarvis-brain.ts`
- `src/main/voice/wake-engine.ts`
- `src/main/voice/echo-suppress.ts`
- `src/main/voice/wake-lock.ts`
- `src/main/voice/transcript-filter.ts`
- `docs/JARVIS-PORTING.md` (§5–§8: guardrails, subsystems, gemini-live hibernation, reimplementation guide)
- Live-transport lane: `gemini-live-transport.ts`, `gemini-live-provider.ts`, `openai-realtime.ts`, `factory.ts`, `live-transport-controller.ts`, `provider.ts`

**Overclock files cited (all under `/Applications/Overclock.app/Contents/Resources/sidecar/dist/`):**
- `GeminiLiveSession.js`
- `JarvisService.js`
- `JarvisWakeLock.js`
- `voiceSafeText.js`
- `jarvisLivePrompt.js`
- `handoffWakeMessage.js`
- `JarvisMemory.js`
- `harnessAssistant.js`

**Relevant nexus commits:** `e9953b9` (speed up live wake fallback / click min-listen 8000→2400), `732d358` (measure realtime tool latency cleanly), `c27d36b` (keep click wake listening after ack / ACK-before-capture reorder), `6c5ca68` (harden local STT fallback / Homebrew PATH), `e5996d0` (keep JARVIS operational on brain fallback / canned local reply).

**Overclock code: REACHABLE at `/Applications/Overclock.app/Contents/Resources/sidecar/dist` — code-verified** (two `barge-in`/support-file claims explicitly marked `inferred`; all others `code-verified` with exact `file.js:line`).

## Senior completeness addendum (2026-07-08)

Verdict: **6 missed behaviors found.** Exhaustive re-read of the sidecar voice surface (`GeminiLiveSession.js`, `JarvisService.js`, `jarvisLivePrompt.js`, `voiceSafeText.js`, `JarvisMemory.js`, `JarvisWakeLock.js`, `handoffWakeMessage.js`, `harnessAssistant.js`) diffed against the 10 gaps **and** both builder scopes. Several reference behaviors already listed in the "Reference (overclock)" section never became a numbered gap, and one whole narration/output subsystem was absent from both. Each row below cites a concrete `file.js:line` in the Overclock dist and was checked against the nexus source (which files exist / what they already cover) to avoid false positives.

False-positive checks that came back **already covered** (NOT listed as misses): persisted memory injection (Overclock `JarvisMemory.js:75` ↔ nexus `src/main/voice/jarvis-memory.ts`), cross-instance wake mutex (Overclock `JarvisWakeLock.js:46` ↔ nexus `src/main/voice/wake-lock.ts`), TTS brevity discipline (Overclock `jarvisLivePrompt.js:23` ↔ nexus `src/main/voice/jarvis-brain.ts:16,160`), fenced/inline-code + ANSI + TUI-glyph stripping on TTS output (Overclock `voiceSafeText.js:24-27` ↔ nexus `src/main/voice/speakable.ts:24-36`), reconnect backoff + `SETUP_TIMEOUT_MS`/`TURN_MAX_MS`/`SDK_PROGRESS_TIMEOUT_MS` watchdogs and the 4-tool coarse router (folded into Builder-2's "full watchdog set" + "function-calling port").

| Behavior | Overclock ref (file.js:line) | Why it matters for fluidity | Owning nexus lane | Effort |
|----------|------------------------------|-----------------------------|-------------------|--------|
| **`voiceSafeText` bare-`mcp__(...)` / JSON-blob / orphan-pointer stripping on TTS output.** nexus `speakable.ts:24-36` strips ANSI + fenced/inline code + box glyphs, but does NOT remove a bare `mcp__overclock__handoff_list({ids:["h-5t"]})` outside backticks, a bare `{"key":...}` JSON blob, or an orphaned `Mais detalhes:` pointer — a leaked handoff-wake technical line (`handoffWakeMessage.js:52`) would be spelled out char-by-char. | `voiceSafeText.js:14` (MCP_CALL_RE), `:16` (MCP_NAME_RE), `:18` (JSON_BLOB_RE, 3 passes at `:32`), `:30` (orphan `Mais detalhes:`/`Responda via:` strip) | Prevents the voice from reading tool-call syntax / JSON aloud — a jarring, non-human "spell-out" that instantly breaks the assistant illusion. Defense-in-depth beyond code-fence stripping. | Classic / Builder 1 (TTS output path — extend `speakable.ts`) | S |
| **Structure-aware menu compression before the blind 500/600-char narration caps.** Detects ≥3 ascending numbered option lines, emits `"Menu com N opções: 1. A; 2. B; …. Pergunta final: X"` so every option + the closing question survive the cap. No nexus equivalent. | `JarvisService.js:252` (`compressMenuForNarration`), applied `:1364`, `:1929` | A long choice-menu blind-cut mid-list makes the voice read only the first 2 options and swallow the question — the user can't answer what they didn't hear. Completeness is the requirement for a choice prompt. | Realtime / Builder 2 (narration layer in `JarvisService`) | M |
| **Screen-update coalescing (`SCREEN_UPDATE_DEBOUNCE_MS = 1500`).** A wizard/navigation burst emits N near-identical screen turns; only the LAST state within the window is narrated, and an identical final state is dropped entirely. | `GeminiLiveSession.js:36` (const), `:336` (`injectScreenUpdate`), `:342-357` (`flushScreenUpdate` + dedup) | Stops the voice from babbling through every transient screen during a fast nav/wizard burst — it speaks the settled state once. Directly felt as "it's not talking over itself." | Realtime / Builder 2 | S |
| **Serialized narration turn queue (one turn in flight; FIFO drain on `turnComplete`).** `routeTurn`→`sendQueue`→`drainSendQueue` gates on `turnBusy`; released only on `turnComplete`/`interrupted`. Concurrent narrations (delegated result + pane progress + screen update) never overlap. (The `TURN_MAX_MS` breaker arm at `:393` is Builder-2 watchdog scope; the FIFO ordering itself is a distinct fluidity mechanism not covered by any gap.) | `GeminiLiveSession.js:378` (`routeTurn`), `:382` (`drainSendQueue`/`turnBusy`), `:396` (`releaseTurn`), `:801,807` (release on interrupt/complete) | Without it, two async narrations hit the socket at once and the voice talks over itself — the single loudest "not fluid" tell. Serialization keeps narration a single, ordered voice. | Realtime / Builder 2 | M |
| **Deterministic pending-question routing + answer polling.** When a working pane narrates a question, the user's next FINAL non-UI utterance is routed straight back to that pane (model bypassed); the answer is polled and narrated. Carries its own timing/dedup constants. Adjacent to — but NOT identical with — the 4-tool "function-calling port"; must be ported explicitly. | `JarvisService.js:503-504` (`maybeRouteAnswerToPendingQuestion` on final user turn), `:709` (`QUESTION_POLL_MS=8000`), `:715` (`NARRATED_QUESTION_TTL_MS=3min`), `:733` (`ROUTED_ANSWER_DEDUP_MS=15000`), `:763` (`ANSWER_POLL_MS=1500`), `:764` (`ANSWER_POLL_MAX_MS=120000`) | Makes Q&A with a live pane feel like one continuous conversation — you answer the pane's question by just talking, no re-wake, no model detour, no "I didn't catch that." Big continuity lever beyond gap 4's dormancy. | Realtime / Builder 2 (extends the function-calling port) | L |
| **`NARRATION_ENVELOPE` wrap + host-composed `speakPayload` law-marks.** Injected narration is wrapped in a `"CONTEXTO INTERNO — NÃO leia nada disto em voz alta"` envelope so the model never reads internal directives/labels aloud; the final sentence is composed host-side (`FALE: …`) carrying only short law-marks instead of 250-700 chars of re-explained doctrine per narration. No nexus equivalent. | `GeminiLiveSession.js:30` (`NARRATION_ENVELOPE`), `:327` (`injectNarration`), `JarvisService.js:speakPayload` (`FALE(...)` composer, ~`:984` region) | Two-fold fluidity: (a) the model never accidentally reads a raw instruction/label out loud (illusion-breaking), and (b) far less rebilled instruction text per turn → cheaper, snappier narration. | Realtime / Builder 2 | S |

### Corrections to existing gap rows

No corrections needed. Spot-checked every Overclock `file.js:line` cited in the "Reference (overclock)" and "Prioritized gaps" sections against the installed dist — all resolve to the stated behavior:
- `GeminiLiveSession.js`: `:265` pushMic/pendingMic ✓, `:287` `endMicTurn`/`audioStreamEnd:true` ✓, `:292/:296` `sendMicChunk` `rate=16000` ✓, `:336` `SCREEN_UPDATE_DEBOUNCE_MS`/`injectScreenUpdate` ✓, `:393` `TURN_MAX_MS` breaker arm ✓, `:490` `SETUP_TIMEOUT_MS` watchdog ✓, `:695` `inputAudioTranscription:{}` ✓, `:702` `contextWindowCompression.slidingWindow` ✓, `:752-753` `audio_chunk`+`live_state:'speaking'` (item says `:750`, off by ≤3 — not worth a correction) , `:761` echo suppression (`isEcho`) ✓, `:769` `outputTranscription` ✓, `:794` `sc.interrupted` → `player.stop()` ✓, `:852` F-133 singleton orphan guard ✓.
- `JarvisService.js`: `:42` `SDK_PROGRESS_TIMEOUT_MS=30000` ✓, `:412` `LIVE_HISTORY_MAX=40` ✓, `:415` `RESUME_WINDOW_MS=5min` ✓, `:419` `LIVE_GRACE_MS=90s` ✓, `:429` `IDLE_TIMEOUT_MS=5min` ✓, `:970-985` immediate `delegar` ack via `pickAck` without awaiting `send()` ✓.

## Decisão aprovada (2026-07-08)

**Direção aprovada pelo usuário:** reativar o transporte realtime. A hibernação de 2026-07-06 (`transport === 'classic'` → `resolveRealtimeProviderIds` retorna `[]`, nenhum socket aberto) fica **formalmente revertida** — o caminho live/gemini-realtime volta a ser alvo de entrega, não um teto adormecido.

**Guardrail (condição obrigatória de release):** **nenhum código realtime vai a produção** sem que estejam no lugar, JUNTOS, (1) a **porta completa de function-calling** (as 4 tools de voz `delegar/consultar/ler/navegar` + o roteamento determinístico de resposta a pergunta pendente) e (2) o **conjunto completo de watchdogs** (`SETUP_TIMEOUT_MS`, `TURN_MAX_MS`, `SDK_PROGRESS_TIMEOUT_MS`, reconnect com backoff exponencial e o guard de sessão singleton F-133). Realtime sem esses dois pilares fica bloqueado — não faz merge, não faz ship.

**Pré-requisito (bloqueante, antes de qualquer trabalho realtime):** **WAKE-BROKEN-001 precisa estar resolvido primeiro.** Enquanto o wake estiver quebrado, a reativação do transporte realtime não começa — o wake é a porta de entrada de toda a experiência de voz e nenhum ganho de fluidez realtime importa se o assistente não acorda.

## Correção / notas de builder (2026-07-08 · sessão pane-73 · brief DRn8dxrW-1)

Rodada de paridade DEFINITIVA + correção h-27 (o incidente real foi stall de STT ~16s + fala marin 7,8s atrasada; NÃO houve dual-voice nem misfire de `encerrar`). Entregue em commits atômicos `fix/feat(voice)` (sem push):

- **ITEM 1 (costura de paridade):** wake/click agora ENGAJAM a sessão live (`beginListening`), o utterance streama ao socket (`shouldStreamToRealtime`) e a linha `jarvis.engageDecision` dispara em TODO wake (dedupe removido) nomeando transporte + provider + fonte das keys + brain provider/model. Classic segue como fallback. `2266349`, `ec191e5`. Verificado ao vivo: `transport=gemini-live engaged=gemini … brain=gemini:gemini-3.5-flash` (degraded=false).
- **ITEM 2 (um respondedor):** `TurnExecutionOwner` estendido do plano de ações p/ a FALA (`realtime-audio` claim) + driving test dos dois interleavings. `2266349`.
- **ITEM 7 (stall STT no wake):** orçamento 8s / cloud cap 6s / salto p/ whisper local + log `stt.stall`; relógio injetável testado. `6c5bd3a`.
- **ITEM 8 (voz-fantasma):** turn-token em `runJarvisTurn`; playback cancelado se o turno foi superado durante a síntese; log `jarvis.ghostReplyDiscarded`. `6b4ac95`.
- **ITEM 4 (brain):** `ensureFullBrainCascade` (append dos canônicos faltantes, sem reordenar o head) + `resolveActiveJarvisBrain` no log de engate. `e68dc7f`.
- **ITEM 5 (key Gemini):** GEMINI/OPENAI sempre expostas nas CREDENCIAIS + gate resolve. `8a6d64a`. A key AQ. fornecida NÃO foi armazenada (resource-gate bloqueia validar no host Gemini e escrever o key-store; prefixo AQ.≠AIza ⇒ provável inválida) — e já há uma GEMINI key válida `stored` com a qual o realtime engata. LEI DE SEGURANÇA respeitada (nunca ecoada).
- **ITEM 3 (`encerrar`):** guard de intenção de despedida (`isFarewellIntent`, allowlist) + log `encerrar.rejected`; testes honrar/rejeitar. `2a249b3`.

`tsc` limpo; suíte de voz verde; app dev religado com o código final e mantido vivo.

## Correção / notas de builder (2026-07-08 · sessão pane-74 · brief DRn8dxrW-2 · LOG-PROVEN FIX ROUND)

Rodada guiada por 4 defeitos PROVADOS em `voice.log:3483-3497` (dual-voice + JSON cru + auto-wake). Commits atômicos `fix(voice)` (sem push):

- **DEFECT 1 (dois motores respondem a mesma fala):** a posse era por-turno (`TurnExecutionOwner`/token) — cada re-wake abria turno novo que o Classic vencia enquanto o realtime respondia o anterior (`16:08:54 classicTranscript→brainReply "Certo."→marin` falando por cima). Fix: posse por **SESSÃO** — enquanto `isRealtimeLive()`, o caminho Classic STT→cérebro→TTS fica **OFF** num turno wake/click (fallback de degradação, não racer). Predicado puro `classicSuppressedByRealtimeOwner` (novo `realtime-ownership.ts` + 5 testes); trava nas 2 entradas do `finishAndProcess` (timeout realtime + direto-para-Classic). `reply` segue Classic-owned. **Prova ao vivo:** 3 wakes no run novo → cada `jarvis.classicSuppressed`, ZERO classicTranscript/brainReply.
- **DEFECT 2 (áudio realtime não suprime o wake):** `LiveAudioPlayer.play()` devolvia só 1 chunk enquanto a fila gapless tinha ~20s à frente → supressão lapsava no meio da fala. Fix: `play()` devolve o tempo até a fila **INTEIRA** drenar (`scheduledTailMs`, puro + 3 testes); `suppressWakeDetection` é monotônico (`Math.max`).
- **DEFECT 3 (vazamento de JSON no TTS):** `parseReply` no catch dumpava o texto cru (`{ "type": "message"`) como `say` quando o JSON estruturado/truncado do Gemini falhava o parse. Fix: `recoverSpokenText` recupera fala de formas estruturadas (`content[].text`, `choices[].message.content`, `text/output_text/message`) ou **silencia** — braçadeira NUNCA chega ao TTS. `parseReply` exportado + 7 testes.
- **DEFECT 4 (STT embaralha PT):** VERIFICADO já correto — wake/jarvis envia `translate:false, language:'pt'` (`voice-controller.ts:1421`) e o `stt-service` honra (`:136,:151-152`, endpoint transcribe sem `-tr`). O embaralho é Whisper errando PT acentuado com AEC off, não vazamento de translate. Sem código.

`tsc` verde; suíte de voz 389/389; suíte completa 1178 verdes + 3 falhas pré-existentes de ABI do better-sqlite3 (`orch/squad-store.test.ts`, fora de escopo). App dev religado limpo (1 instância: forge 79072/main 79125) e mantido vivo. Engage line verbatim: `transport=gemini-live engaged=gemini … brain=gemini:gemini-3.5-flash` (degraded=false).
