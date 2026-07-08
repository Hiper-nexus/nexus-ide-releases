# JARVIS Voice Stack — Live-Behavior Forensics

**Scope:** READ-ONLY. Running dev Electron instance, branch `voice/wake-parity-builder1`.
**Log analyzed:** `~/.nexus/logs/voice.log` (3302 lines, mtime `Jul 8 11:52` local).
**Run under investigation:** the process that started `Wed Jul 8 11:45:17 2026` local time.

> **Timezone reconciliation (read first — the whole report depends on it):**
> `voice.log` timestamps are **UTC (`...Z`)**. The machine/local zone is `-0300`.
> - `ps lstart` → process start `11:45:17` local = **`14:45:17Z`** in the log.
> - Commit `05ae131` → `2026-07-08 11:29:23 -0300` = **`14:29:23Z`**.
> The user's "launched ~14:44 / 14:45 today" and the "14:42 pattern" are the **UTC** clock, i.e. the log clock. So "post-14:45 turns" = the block starting at log line 3237 (`14:45:21.630Z`). The last log line is `14:52:27.646Z`.

---

## A. TRANSPORT VERDICT — **Still CLASSIC. Realtime never engaged this run.** (and it is NOT a stale-binary problem)

### A.1 The running binary INCLUDES the activation commit (stale-binary hypothesis REJECTED)
- Process start: `Wed Jul 8 11:45:17 2026` local = **`14:45:17Z`** (`ps -eo pid,lstart,command` → `electron-forge start`, pid 38776/38822).
- Commit `05ae131 feat(voice): activate the realtime audio + action bridge`: **`14:29:23Z`** (`git log -1 05ae131`).
- The process started **~16 minutes AFTER** the activation commit. `electron-forge start` compiles from the working tree at launch, so the running bundle was built from source that already contained `05ae131` (plus the builder's uncommitted edits). **The running code is post-activation.** The "process predates the flag-flip" theory is disproven.

### A.2 The config asks for realtime (`gemini-live`), enabled
`~/.nexus/plugins/voice/nexus-voice.json` (mtime `Jul 8 11:39`):
```
transport: gemini-live
enabled:   true
liveModel: gemini-2.5-flash-native-audio-preview-12-2025
```
Default is also `gemini-live` (`src/shared/voice-config.ts:116,138,279`). So the config is NOT the problem — realtime is requested.

### A.3 …yet every post-14:45 turn is CLASSIC
Turn-owning realtime events (`jarvis.realtimeTranscript` / `jarvis.realtimeOwns` / `jarvis.liveProviderAnswer`) that are emitted **into voice.log** when realtime owns a turn:
- Whole file: **6** occurrences — **all on Jul 7** (`20:07:28Z`–`21:00:49Z`, lines 547–781). Example proving realtime *did* work the day before:
  ```
  547: 2026-07-07T20:07:28.757Z jarvis.realtimeTranscript: abrir um novo workspace. {"reason":"wake"}
  557: 2026-07-07T20:08:03.775Z jarvis.realtimeOwns: conversation {"transcript":"Pues no patrón."}
  ```
- **Jul 8: 0** occurrences.
- Every Jul 8 post-14:45 turn is `jarvis.classicTranscript` + `jarvis.brainReply` (lines 3288–3302). e.g.
  ```
  3288: 2026-07-08T14:51:00.823Z jarvis.classicTranscript: Oi, não. Bom dia... {"reason":"wake"}
  3289: 2026-07-08T14:51:01.488Z jarvis.brainReply: Bom dia, patrão. Impersonar é... {"expectReply":true}
  ```
**Verdict: this run ran entirely on the Classic path.**

### A.4 WHY realtime did not engage — runtime degradation, most probably a missing `GEMINI_API_KEY`
The engage gate (`src/renderer/voice/voice-controller.ts:209-213`):
```
209 function canAttemptRealtime(info) {
210   if (!info?.jarvisLive.enabled || info.jarvisLive.transport === 'classic') return false;
211   if (info.jarvisLive.transport === 'gemini-live') return hasCredential(info, 'GEMINI_API_KEY');
212   return hasCredential(info, 'OPENAI_API_KEY') || hasCredential(info, 'GEMINI_API_KEY');
213 }
```
With `transport === 'gemini-live'`, line 211 requires **`GEMINI_API_KEY` specifically** — an `OPENAI_API_KEY` does NOT satisfy it. The config-store comment documents exactly this failure mode (`src/main/voice/voice-config-store.ts:63-71`): *"A degradação para o Classic acontece em runtime (sem key / setup falho / reconexão esgotada), não por coerção da config."*

Corroborating evidence that OPENAI is present but GEMINI likely is not:
- OPENAI is live this run: `3237: 14:45:21.630Z tts.provider: openai (marin) {"fallback":false}` (repeated) — so OpenAI TTS/brain keys resolved.
- Earlier same day OPENAI was *absent* and keys were clearly being juggled: `1317: 2026-07-08T11:16:55Z [WARN] tts.fallback: ... openai needs OPENAI_API_KEY ... → macos-say`. There is also a `nexus-voice.json.bak-pre-groq` backup (Jul 7 13:22) — key set was being reshuffled between Jul 7 (realtime worked) and this run.
- The exact user-facing string for this state exists: `src/renderer/components/VoiceSettings.tsx:368` → *"Realtime indisponível; verifique GEMINI_API_KEY."*

**Confidence & the one thing I could NOT confirm from logs:** Keys are read in main from `process.env` / stored keychain (`voice-config-store.ts` header comment), **not** from any file on disk — I found no `.env*` with keys and the shell env has none, so I cannot *directly* read the running process's `GEMINI_API_KEY`. Also note: **realtime socket-level logs never land in voice.log even on Jul 7 when it worked** (grep for `live.open|socket|wss|realtimeReady` on Jul 7 → empty), so the *absence* of socket/error lines on Jul 8 is **not** independent proof of anything. What IS dispositive is that the turn-ownership events (`realtimeTranscript`/`realtimeOwns`), which DO log, are 0 on Jul 8.

**To settle definitively (one command):** inspect the running main process env — `ps eww 38822 | tr ' ' '\n' | grep -E 'GEMINI_API_KEY|OPENAI_API_KEY'` — or read the main-process terminal/stdout for the realtime connect/degrade line. If `GEMINI_API_KEY` is unset there, A.4 is fully proven. If it IS set, the fallback shifts to "socket never reached `realtimeReady`" (`voice-controller.ts:198`), which would only be visible in main-process stdout, not voice.log.

---

## B. SELF-TALK ROOT CAUSE (release-defining)

### B.0 The full self-talk cascade, verbatim (lines 3287–3302)
```
3287: 14:50:45.210Z wake.detected: "Hey Jarvis"
3288: 14:51:00.823Z classicTranscript: "Oi, não. Bom dia. O que é impersonar, Clavis? Impersonar é acessar o..." {reason:"wake"}
3289: 14:51:01.488Z brainReply:  "Bom dia, patrão. Impersonar é acessar o sistema..."          {action:none, expectReply:true}
3290: 14:51:02.040Z wake.detected: "Hey Jarvis"                        ← self-trigger during speech
3291: 14:51:03.303Z tts.provider: openai (marin)                        ← she starts speaking (~23s of audio)
3292: 14:51:26.724Z classicTranscript: "o javis"                       {reason:"reply"}   ← STT of her own tail
3293: 14:51:27.848Z brainReply:  "Ah, bom dia, patrão! Estou aqui..."   {expectReply:true}
3294: 14:51:28.072Z wake.detected: "Hey Jarvis"
3295: 14:51:29.557Z tts.provider: openai (marin)
3296: 14:51:49.272Z classicTranscript: "Ooooooooh!"                     {reason:"reply"}   ← THE "ooooooh"
3297: 14:51:49.814Z brainReply:  "Que animação, patrão! O que está acontecendo?" {expectReply:true}
3298: 14:51:50.612Z wake.detected: "Hey Jarvis"
3299: 14:51:51.037Z tts.provider: openai (marin)
3300: 14:52:08.948Z wake.detected: "Hey Jarvis"
3301: 14:52:24.467Z classicTranscript: "Um instante. Pois não, patrão." {reason:"wake"}
3302: 14:52:27.646Z brainReply (empty) {latencyMs:3182, expectReply:false}
```

### B.1 WINNER: **(c) reply-loop continuity re-opening the mic into her own TTS tail — captures that do NOT self-terminate.** Enabled by full-duplex `echoCancellation:false` + a text-only echo guard that can't match garbled feedback.

Evidence chain:
1. **The mic hardware runs with AEC OFF.** Every `mic.device` line this run: `"echoCancellation":false ... "noiseSuppression":false ... "autoGainControl":false` (e.g. line 3283 `14:49:25Z`; also 14:49:08, 14:49:13). This is deliberate — `docs/JARVIS-PORTING.md:683`: *"`echoCancellation: false, // APM off: KWS precisa do sinal cru`"*. So speaker audio bleeds straight back into the mic.
2. **Every conversational reply sets `expectReply:true`** (3289, 3293, 3297). That drives `shouldReopenJarvisListening()` → reopen the mic with `reason:"reply"` (`src/renderer/voice/jarvis-reply-loop.ts:60-`, `voice-controller.ts:171,1095`). The two garbage captures are BOTH `reason:"reply"` (3292, 3296) — i.e. produced by the auto-reopen, not by a user press.
3. **The three safety "travas" the reply-loop's own header (`jarvis-reply-loop.ts:6-11`) says make reopen safe ALL FAILED here:**
   - *"echo-guard descarta o eco do próprio TTS ANTES de virar turno"* — the guard (`voice-echo-guard` / `discardSpokenEchoIfNeeded`, `voice-controller.ts:1247,1415`; main-side `echoSuppressor.isEcho`, `voice-ipc.ts:187`) is **text-normalized comparison** against `recentSpoken`. The captured text `"o javis"` and `"Ooooooooh!"` are garbled STT of the acoustic tail, **not** a normalized match of what she said → guard misses → becomes a turn. **Proof it never fired:** `grep 'stt.echoDiscarded' (Jul 8) → 0 hits.**
   - *"capturas vazias se auto-encerram"* — `"Ooooooooh!"` is non-empty and is **not** a `isConfusionReply` string (`jarvis-reply-loop.ts:49-56`), so the confusion-reopen cap (`MAX_CONFUSION_REPLY_REOPENS=1`) never trips and the loop is not self-terminated.
   - *"a supressão de wake cobre a janela do TTS"* — it does not: the suppression is a **fixed 1200 ms** (`voice-controller.ts:245 wakeMic.suppressWakeDetection(1_200)`) while the TTS turns are ~20 s long (3291→3292 is 23 s). Hence wake self-fires mid-speech at 3290/3294/3298/3300.
4. Net loop: reply(expectReply:true) → mic reopens → captures TTS tail/noise → guard misses garbled text → real brain answers it → new reply(expectReply:true) → … Bounded only by `MAX_AUTO_REPLY_LOOPS = 10` (`jarvis-reply-loop.ts:14`), i.e. up to ten self-turns of "bem maluca" before it stops. That matches the observed 3-4 self-turns before the user intervened.

### B.2 Secondary vector present but not dominant: **(b) Classic wake contamination.**
`wake.detected` fires repeatedly on her own TTS (3290, 3294, 3298, 3300) because the 1200 ms wake-suppression lapses during the ~20 s replies. Two transcripts are `reason:"wake"` (3288, 3301). This is the "14:42 pattern" repeating and it is real — but the *garbage* self-talk captures ("o javis", "Ooooooooh!") are `reason:"reply"`, so the **reply-loop is the primary engine**; wake contamination is the co-conspirator that also keeps re-arming turns.

### B.3 Vector (a) full-duplex acoustic feedback on the LIVE path — **N/A THIS RUN, but a loaded gun for when realtime turns on.**
This run never engaged realtime (§A), so (a) did not occur here. **However**, the KEY PORTING QUESTION is answered and the risk is real: the input-side echo guard was ported **only to the Classic transcript path**, NOT the live socket. `echoSuppressor.isEcho()` gates only the batch `transcribe` handler (`voice-ipc.ts:187`; `JARVIS-PORTING.md:876,899`). The live mic input `liveTransport.micIn(raw)` (`voice-ipc.ts:397`) streams **raw PCM to the socket with no `isEcho` / `recentSpokenNorm` check** — the Overclock reference had input-side suppression at `GeminiLiveSession.js:~761`. So once `gemini-live` engages with `echoCancellation:false`, the speaker audio will re-enter the mic, stream to Gemini, and she will answer herself with **no input guard at all**. Fix C4 pre-empts this.

### B.4 The "ooooooh" explained
Line `3296: 14:51:49.272Z classicTranscript: "Ooooooooh!" {reason:"reply"}`. It is **garbage STT of her own TTS tail / breath / room noise**, captured by the reply-loop's auto-reopened mic (§B.1) with `echoCancellation:false`. It is NOT a TTS artifact and NOT realtime audio-chunk noise (no realtime this run). The brain then earnestly answered it: `3297: brainReply "Que animação, patrão! O que está acontecendo?"`.

---

## C. "STILL DUMB" — she is on the **real brain**, not the canned fallback; "dumb" = Classic batch latency + the self-talk chaos

Per-turn responding path:

| Line | Transcript | Reply | Path | Evidence |
|---|---|---|---|---|
| 3288/3289 | "…impersonar…" (reason:wake) | "Bom dia, patrão. Impersonar é acessar o sistema como se fosse outro usuário…" | **Real provider** (groq/openai chain) | Coherent, context-specific, `latencyMs:664`. Not a canned string. |
| 3292/3293 | "o javis" (reason:reply) | "Ah, bom dia, patrão! Estou aqui…" | **Real provider** | `latencyMs:1127` |
| 3296/3297 | "Ooooooooh!" (reason:reply) | "Que animação, patrão!…" | **Real provider** | `latencyMs:543` |
| 3301/3302 | "Um instante. Pois não, patrão." (reason:wake) | *(empty say, expectReply:false)* | brain returned empty / noise-gated | `latencyMs:3182` — slow; likely provider round-trip or noise-gate |

**The canned local fallback did NOT fire.** `localBrainFallbackReply` (`src/main/voice/jarvis-brain.ts:388-411`) emits fixed strings: *"tive uma falha rápida no cérebro online, mas continuo operando."* or *"estou aqui e continuo operando localmente."*. **Grep for those + `stt.echoDiscarded` across the Jul 8 run → 0 hits.** So every reply above came from the online provider chain (Gemini→OpenAI→Groq, `jarvis-brain.ts:511,569-580`), not the canned path.

**Therefore "still dumb/slow" is NOT a keyless/failing brain.** It is:
1. **Classic transport latency** — batch STT→brain→TTS per turn (§A). Realtime full-duplex (which would feel snappy) is off. Latencies 0.5–3.2 s stack per turn.
2. **The self-talk (§B)** makes her *sound* incoherent/"maluca" — she's answering her own garbage, so from the user's chair she looks dumb even though each individual reply is a real, on-topic completion.
3. The `3182 ms` empty reply (3302) is the only "hang" symptom; it is a single slow/empty provider round-trip, not the fallback.

---

## D. FIX LIST (ordered, surgical — for the punch-list builder; DO NOT implement from this report)

Ordered by what unblocks the most.

1. **Restore realtime activation (unblocks "dumb/slow" + is the intended product).** Confirm/repair `GEMINI_API_KEY` for the running instance (main-process env / stored key). Gate: `src/renderer/voice/voice-controller.ts:211` requires it when `transport==='gemini-live'`.
   - **Also add a boot log line** for the realtime engage decision (currently silent — voice.log shows no reason for the degrade). Suggest logging in `canAttemptRealtime` / at socket connect in `src/main/voice/live-transport-controller.ts` so "degraded to Classic because X" is visible. This is the single biggest observability gap found.
   - *(Product decision alternative: if a reliable `GEMINI_API_KEY` isn't available, flip default `transport` to `'openai-realtime'` — `src/shared/voice-config.ts:116` — since `OPENAI_API_KEY` is present and line 212 would then satisfy the gate.)*

2. **Kill the self-talk loop on the Classic path (release-defining).** Two coupled changes:
   - **2a. Tie wake-suppression to actual TTS duration, not a fixed 1200 ms.** `src/renderer/voice/voice-controller.ts:245` (`wakeMic.suppressWakeDetection(1_200)`). Extend suppression to `playback end + tail margin` so `wake.detected` cannot fire mid-reply (stops 3290/3294/3298/3300). Suppressor plumbing exists at `wake-mic.ts:164` and `voice-controller.ts:150`.
   - **2b. Do not reopen the mic (`reason:"reply"`) until TTS playback has fully drained + a short tail-guard.** `src/renderer/voice/jarvis-reply-loop.ts` (`shouldReopenJarvisListening`, `REPLY_LISTEN_DELAY_MS=700` at line 13) — 700 ms is far shorter than the TTS tail; gate reopen on playback-complete instead of a flat delay. This stops the `reason:"reply"` captures (3292, 3296) that produced "o javis"/"Ooooooooh!".

3. **Make the echo/noise guard catch garbled acoustic feedback, not just verbatim echoes.** The current guard is exact/normalized-text match and let `"o javis"` / `"Ooooooooh!"` through.
   - Add a **noise/garbage gate BEFORE the brain call on the Classic reply path** (reuse `isLikelyNoiseTranscript`, currently only reachable inside `src/main/voice/jarvis-brain.ts:394` via `localBrainFallbackReply`) so single-token/interjection captures like `"Ooooooooh!"` are dropped before hitting the provider.
   - Loosen `echoSuppressor.isEcho` (`src/main/voice/echo-suppress.ts`, used at `voice-ipc.ts:187`) toward fuzzy/substring/temporal matching against `recentSpoken` so a partial STT of her own tail during the TTS window is discarded.

4. **Add input-side echo suppression to the LIVE socket path BEFORE realtime ships (pre-empts §B.3).** `liveTransport.micIn(raw)` (`src/main/voice/voice-ipc.ts:397` → `src/main/voice/live-transport-controller.ts`) streams raw PCM with no echo guard; the Classic guard at `voice-ipc.ts:187` does not cover it. Port the Overclock `GeminiLiveSession.js:~761` `isEcho` vs `recentSpokenNorm` input check onto the live path (gate/duck mic frames while TTS is active, or drop frames matching recent spoken audio). Without this, fixing #1 will surface the full-duplex self-talk loop on the live path.

5. **(Lower) Bound/observe the empty 3.18 s reply.** `3302` returned empty with `latencyMs:3182`. Confirm the provider-chain deadline vs the local-fallback budget (`jarvis-brain.ts:458-459,574-580`) so a slow/empty turn logs a reason rather than silent dead air.

---

### Evidence index (commands run — all read-only)
- `ps -eo pid,lstart,command | grep -i electron` → process start `Wed Jul 8 11:45:17 2026` (=`14:45:17Z`).
- `git log -1 --format=... 05ae131` → `2026-07-08 11:29:23 -0300` (=`14:29:23Z`).
- `~/.nexus/logs/voice.log` lines 547, 557, 3237, 3283, 3287–3302 (quoted above).
- `~/.nexus/plugins/voice/nexus-voice.json` → `transport: gemini-live, enabled: true`.
- Code: `voice-controller.ts:209-213,245`; `jarvis-reply-loop.ts:6-14,49-56`; `voice-ipc.ts:187,397`; `jarvis-brain.ts:388-411`; `voice-config-store.ts:63-71`; `voice-config.ts:116`; `VoiceSettings.tsx:368`; `JARVIS-PORTING.md:683,876,899`.
- `grep 'stt.echoDiscarded' / 'continuo operando' (Jul 8)` → 0 hits (canned fallback + echo-discard never fired).
- `grep 'realtimeTranscript|realtimeOwns|liveProviderAnswer'` → 6 total, all Jul 7, **0 on Jul 8**.
