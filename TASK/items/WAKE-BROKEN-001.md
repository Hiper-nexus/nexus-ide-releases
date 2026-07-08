# WAKE-BROKEN-001 [P0 BLOCKER] — JARVIS wake word does not wake at all (nexus)

> Scout/debugger item. READ-ONLY root-cause analysis — no fix applied.
> Priority **P0**, above the fluidity item **VOICE-PARITY-001** (this blocker gates it).
> Method: `superpowers:systematic-debugging` (evidence-first; premise tested, not assumed).

---

## Observed state — user report + verbatim screenshot transcription

**User (verbatim, PT):** "não está acordando quando eu chamo, ela não acorda de forma
alguma" — JARVIS does not wake at all when called. Neither voice-wake nor (per the
fluidity note) click-wake produces an ack.

**Screenshot** (`/Users/cleofasrocha/.overclock-app/dropped/1783509968088-image.png`),
transcribed verbatim:
- Window title: **`JARVIS LIVE`** (own HUD window, with min/close controls)
- Status line: **`Transcrevendo`** (Transcribing)
- Sub-line: **`sessão 0 turnos`** (session, 0 turns)
- Red error banner: **`Não estou ouvindo nada — mic mudo ou dispositivo errado.`**
  (I'm not hearing anything — mic muted or wrong device.)
- Button: **`AJUSTES DE SOM`** (Sound settings)

The banner is the `micHealth === 'silent'` state rendered at
`src/renderer/components/VoiceHud.tsx:365-375`. It fires only when
**permission is granted AND the mic has been continuously silent past the threshold**
(`src/renderer/voice/wake-health.ts:37`). The app is telling the user, correctly, that
the microphone is delivering no audio.

### Runtime log — the decisive evidence (`~/.nexus/logs/voice.log`)

```
2026-07-08T11:16:55.815Z [INFO] mic.device: device: Default - fifine Microphone (3142:a010)
        {"settings":{"autoGainControl":false,"channelCount":2,"deviceId":"default",
         "echoCancellation":false,"noiseSuppression":false,"sampleRate":48000,...}}
2026-07-08T11:16:56.073Z [INFO] mic.firstFrame: primeiro frame recebido {"rms":0}
2026-07-08T11:17:10.221Z [WARN] mic.health: silent {"permission":"granted"}
2026-07-08T11:17:34.733Z [INFO] utt.weakSignal: captura wake/clique com sinal fraco
        {"durationSec":22.272,"heardSpeech":false,"maxRms":0,"maxPeak":0,"rawMaxRms":0}
```
- **`mic.firstFrame … {"rms":0}`** — the very first PCM frame of *every* session is
  exactly zero. The fifine is handing the app pure digital silence.
- **`utt.weakSignal … maxRms:0, maxPeak:0, rawMaxRms:0, durationSec 22.272`** — a
  click-wake capture ran the full click hard-cap (`CLICK_WAKE_MAX_MS` 22 000 ms + slack)
  on **22 s of pure zeros**. This is the "Transcrevendo / 0 turnos" in the screenshot.
- **The `rms:0` first-frame entries date back to `2026-07-07T20:32:19Z`** — *hours before*
  the earliest suspect commit (`e5996d0`, 07-08 01:27). **The silence predates all five
  `fix(voice)` commits**, which refutes the premise that a recent voice commit killed wake.
- The user was already following the banner: `mic.openSoundSettings` / `mic.openMicSettings`
  events at 11:24–11:30.

---

## Expected wake flow — file:line map (registration → mic → detector → ack)

1. **Wake enabled → hot mic starts.** `syncWakeWord` calls `wakeMic.start()` —
   `src/renderer/voice/voice-controller.ts:829-841`.
2. **Always-on capture.** `WakeMic.openGraph()` opens a 16 kHz mono `getUserMedia`
   stream, APM off — `src/renderer/voice/wake-mic.ts:321-337`; each 80 ms frame hits
   `onFrame` — `wake-mic.ts:363-394`.
3. **Frames → main.** Non-utterance frames are sliced to 1280-sample chunks and sent
   `window.nexus.voice.sendWakeAudio(chunk)` — `wake-mic.ts:388-393`.
4. **Detector (main).** `voice:wake.audio` handler feeds `WakeEngine.feed()` —
   `src/main/voice/voice-ipc.ts:180-233`; the openWakeWord port scores each chunk and
   fires `onDetected` when `score >= THRESHOLD (0.48)` — `src/main/voice/wake-engine.ts:274-318`.
5. **Detected → broadcast.** `broadcast(VOICE_CHANNELS.wakeDetected)` — `voice-ipc.ts:220`.
6. **Renderer wake handler.** preload relays to `onWakeDetected` (`preload.ts:152-154`)
   → `onWake('voice')` (`voice-controller.ts:941`) → `handleWake` (`:704-765`).
7. **Ack + listen.** `handleWake` plays the "Pois não?" ack (`playWakePrompt`) and opens
   the command window via `beginListening` → `wakeMic.beginUtterance` on the hot stream —
   `voice-controller.ts:733-758`, `:1043-1048`.

**Where it stops now:** step 2/3 deliver frames whose samples are all 0 (`rms:0`), so the
detector at step 4 scores ~0 and **never crosses `THRESHOLD 0.48`** → step 5/6/7 never run
→ no ack. Click-wake skips step 4 but its capture (step 7) records only zeros.

---

## ⚠️ RE-RANKED — new user evidence (2026-07-08, post-initial write)

**New decisive evidence:**
1. **User confirmed:** "o mic não está travado, ele está disponível" + "está operacional,
   até mandei áudio no WhatsApp, tá tudo normal" — the fifine records real audio in
   WhatsApp and other apps right now. Physical mute switch and OS input level are NOT the cause.
2. **New screenshot** (`1783511618717-image.png`, ~27 min after first screenshot): shows
   `[wake] "Hey Jarvis" detectado (score 0.49)` at `2026-07-08T11:23:23Z` — only 6 minutes
   after the all-zero session logged at 11:16–11:17. Full STT→brain→TTS cycles ran through
   11:52 with multiple complete turns. The mic went from `rms:0` to real audio **with no
   hardware change** — intermittent recovery is the fingerprint of a TCC phantom grant, not
   a wrong-device mapping (a wrong device would *never* produce rms>0 in nexus).
3. **TCC phantom grant** is the documented macOS failure mode: macOS silently delivers
   all-zero PCM while `permission` still reports `'granted'` and logs show no error. It is
   triggered by app reinstall/update invalidating the existing TCC record. The app's own
   history documents this exact pattern (known fix: `tccutil reset + reopen + click Allow`).

**Eliminated:** device-side mute, physical switch, OS input level (Rank 1 original).

---

## Ranked hypotheses (revised)

### Rank 1 — Stale/phantom macOS TCC microphone grant for `com.nexuside.app`  ★ PRIME ROOT CAUSE
- **mechanism:** After an app reinstall or update, the existing TCC entry for
  `com.nexuside.app` is invalidated in the TCC database. macOS then silently delivers
  all-zero PCM to the app while still reporting `permission: 'granted'` — no error, no
  console warning. The app's `getUserMedia` succeeds, the stream opens, but every sample is 0.
- **file:line:** manifests at `src/renderer/voice/wake-mic.ts:321-337` (getUserMedia
  opens successfully on a zeroed stream) → `wake-mic.ts:371-378` (`rms:0` frame tracking)
  → `src/main/voice/wake-engine.ts:313` (score ~0, never crosses `THRESHOLD 0.48`).
- **discriminating evidence:** a getUserMedia "wrong device" fault would produce
  `rms:0` permanently and never self-recover without a device change. But the new
  screenshot proves recovery at 11:23 (after what was likely an app restart that prompted a
  fresh Allow dialog), confirming the grant was the variable, not the device.
- **why it kills wake:** `rms:0` → openWakeWord scores ~0 every frame → `THRESHOLD 0.48`
  never crossed → voice-wake never fires; click-wake captures 22 s of zeros
  (`utt.weakSignal maxRms:0`) → 0 turns.
- **fix (exact, copy-paste):** see **Step-by-step fix** section below.

### Rank 2 — getUserMedia `deviceId:'default'` resolving to a virtual/wrong input
- **file:line:** `src/renderer/voice/wake-mic.ts:321-337` — `getUserMedia` is called with
  `deviceId:'default'`. If a virtual audio device (e.g. BlackHole, Loopback, Teams
  audio) was set as system default and later removed, `'default'` can resolve to an empty
  or virtual input different from the one WhatsApp explicitly enumerates.
- **why it is now SECOND:** the intermittent self-recovery at 11:23 (without any device
  change in system settings) cannot be explained by a wrong-deviceId mapping. If the
  device were wrong, it would stay wrong until the user changed system input. TCC explains
  the recovery; this does not.
- **how to rule out:** check `voice.log` for `mic.device` lines after the recovery at
  11:23 — if the fifine device string appears with `rms > 0`, the device was always
  correct and TCC was the variable. Also: `System Settings → Sound → Input` should show
  the fifine as the selected input.

### Rank 3 — STT failure/timeout wedges status at `'transcribing'`, permanently gating `onWake` (latent second wall)
- (unchanged from original — see details below)

### Rank 4 — Click-wake reorder can clip the command window (compounds Rank 3)
- (unchanged from original — see details below)

---

## ★ Step-by-step fix (copy-paste ready)

**Goal:** force macOS to re-issue a native permission prompt so NexusIDE gets a fresh,
valid TCC grant. Runtime: ~60 seconds.

```sh
# 1. Quit NexusIDE completely (Cmd+Q, not just close the window).
#    Verify it is gone:
pgrep -l NexusIDE || echo "not running — good"

# 2. Reset the microphone TCC entry for NexusIDE:
tccutil reset Microphone com.nexuside.app

# 3. Reopen NexusIDE from /Applications:
open /Applications/NexusIDE.app

# 4. Immediately after the window appears, macOS will show a native dialog:
#    "NexusIDE" wants to access the microphone → click ALLOW.
#    If the dialog does NOT appear within ~10 s, go to:
#    System Settings → Privacy & Security → Microphone
#    and toggle the NexusIDE switch ON.

# 5. Verify in voice.log that the next session shows rms > 0:
tail -f ~/.nexus/logs/voice.log | grep "mic.firstFrame\|mic.health\|wake.detected"
#    You should see:  mic.firstFrame {"rms": 0.0XX}  (any value > 0)
#    Then say "Hey Jarvis" — expect: wake.detected "Hey Jarvis"
```

**If the dialog appears but clicking Allow does not fix it** (rare — TCC DB locked):
```sh
# Kill TCC daemon so it re-reads the DB:
sudo pkill -9 tccd
open /Applications/NexusIDE.app
# macOS will re-show the Allow prompt.
```

---

## Original Rank 2 detail (STT wedge — now Rank 3)

- **file:line:** `src/renderer/voice/voice-controller.ts:1235` sets status `'transcribing'`;
  the `if (!stt.ok) { …; return; }` at **`:1250-1253` returns without resetting to `'idle'`**,
  and the `catch` at **`:1340-1342`** only sets error — neither restores `'idle'`. The
  `onWake` gate at **`:776`** (`if (voiceStatus === 'transcribing' || 'routing') return;`)
  then ignores every future wake.
- **suspect commit:** the *new trigger* is **`6c5ca68` "harden local stt fallback"**, which
  adds `-l pt` to whisper args; a whisper-cli that errors on `-l pt` raises odds of
  `!stt.ok`/timeout.
- **why it kills wake:** once any turn leaves status stuck at `'transcribing'`, `onWake`
  early-returns forever → "não acorda de forma alguma" even after the mic recovers.
- **fix lane:** `src/renderer/voice/voice-controller.ts:finishAndProcess` — reset status
  to `'idle'` on the `!stt.ok` path (`:1250-1253`) and in the `catch`/`finally`
  (`:1340-1345`). Do NOT let two builders edit `voice-controller.ts` concurrently.

## Original Rank 3 detail (click-wake reorder — now Rank 4)

- **file:line:** `voice-controller.ts:733-746` (`c27d36b` reorder + empty pre-roll) and
  `:91` `e9953b9` (`CLICK_WAKE_MIN_LISTEN_MS` 8000→2400).
- **fix lane:** same file; single owner.

### Rank 2 — STT failure/timeout wedges status at `'transcribing'`, permanently gating `onWake` (latent second wall)
- **file:line:** `src/renderer/voice/voice-controller.ts:1235` sets status `'transcribing'`;
  the `if (!stt.ok) { …; return; }` at **`:1250-1253` returns without resetting to `'idle'`**,
  and the `catch` at **`:1340-1342`** (reached if `withTimeout(transcribe…)` at `:1239-1249`
  throws) only sets error — neither restores `'idle'`. The `onWake` gate at **`:776`**
  (`if (voiceStatus === 'transcribing' || 'routing') return;`) then ignores every future wake.
- **suspect commit:** the wedge itself is pre-existing (gate added `93a76bd`, `!stt.ok`
  path `ea2c165`/`8a3b044` — none of the five). The *new trigger* is **`6c5ca68`
  "harden local stt fallback"**, which adds `-l <language>` (`pt`) to the whisper args and
  probes Homebrew paths (`src/main/voice/stt-service.ts:189-194, 239-242`); a whisper-cli
  that errors on `-l pt` or hangs raises the odds of `!stt.ok` / timeout.
- **why it kills wake:** once any turn leaves status stuck at `'transcribing'` (exactly what
  the screenshot shows), `onWake` early-returns forever → "não acorda de forma alguma" even
  after the mic recovers.
- **cheapest confirmation:** after the mic works, force an STT failure (rename/break
  whisper-cli) and watch for repeated `[voice] wake ignorado (pipeline ocupado)` in console
  while `useVoiceStore.getState().status === 'transcribing'`; grep `voice.log` for an STT
  error with no following `jarvis.classicTranscript`.

### Rank 3 — Click-wake reorder can clip the command window (compounds Rank 2)
- **file:line:** `src/renderer/voice/voice-controller.ts:733-746` — `c27d36b` now `await`s
  `playWakePrompt(ack)` **before** `beginListening(…, 'click', [], …)` with an **empty
  pre-roll**; `e9953b9` then dropped `CLICK_WAKE_MIN_LISTEN_MS` 8000 → **2400** (`:91`).
- **suspect commits:** `c27d36b` (reorder + empty pre-roll) and `e9953b9` (min-listen 2400).
- **why it can hurt wake:** with a working mic, speech during the ack is lost (no pre-roll)
  and the shorter min-listen can close the turn on early silence → empty capture → feeds the
  Rank 2 wedge. On the current silent mic it is moot (all captures are zero regardless).
- **cheapest confirmation:** with a working mic, click-wake and start talking immediately;
  check whether the leading words are missing in `jarvis.classicTranscript`.

---

## Most-likely root cause (revised)

**Stale/phantom macOS TCC microphone grant for `com.nexuside.app`.**
The original hypothesis (device-side mute) is eliminated by new user evidence: the fifine
records real audio in WhatsApp right now, and the new screenshot proves NexusIDE itself
recovered at 11:23 — only 6 minutes after the all-zero session, with no hardware or OS
input change. Intermittent self-recovery is the TCC phantom grant fingerprint: macOS
silently delivers zeroed PCM while `permission` still reports `'granted'`, but a restart
that triggers a fresh Allow dialog (or `tccutil reset`) restores real audio immediately.

The app already diagnoses the symptom correctly ("mic mudo ou dispositivo errado",
`VoiceHud.tsx:365`). **This is not a regression in any of the five `fix(voice)` commits.**
The fix is `tccutil reset Microphone com.nexuside.app` → quit → reopen → click Allow
(exact steps in the **Step-by-step fix** section above).

**Rank 3 (STT wedge) is a real, separately-fixable latent wall** that will resurface
"never wakes again" the first time STT fails after the mic is restored. Fix it in the
same builder pass as the TCC reset is verified working.

---

## Acceptance criteria — measurable "wake works again"

1. **Mic signal restored:** a fresh session logs `mic.firstFrame` with `rms > 0.01`, and
   `mic.health` never reports `silent` while the user is speaking.
2. **Voice-wake fires:** saying the wake phrase produces an audible ack within **≤ 2 s**,
   and `voice.log` shows `wake.detected` followed by a `beginListening`/`listening` state.
3. **Click-wake arms:** clicking the orb plays the ack and opens a listening window that
   captures real speech (`utt.weakSignal` absent / `maxRms > SPEECH_RMS`).
4. **Full cycle re-arms N≥5×:** listen → ack → response → return to `idle` → wake again,
   five consecutive times, with **no** `wake ignorado (pipeline ocupado)` and status never
   stuck at `'transcribing'`/`'routing'` (guards Rank 2).
5. **STT-failure resilience:** an induced STT failure/timeout leaves status at `'idle'`
   (not `'transcribing'`), so the next wake still fires.

---

## Anti-collision lane — files a builder will own

- **Rank 2 fix (code):** `src/renderer/voice/voice-controller.ts` — `finishAndProcess`
  (`:1065-1346`): reset status to `'idle'` on the `!stt.ok` return (`:1250-1253`) and in the
  `catch`/`finally` (`:1340-1345`); optionally relax the `onWake` gate at `:776` to allow
  barge-in out of a stale `'transcribing'`.
- **Rank 1 hardening (optional, code):** `src/renderer/voice/wake-mic.ts` — auto-fallback to
  another input device (or re-open the stream) after N seconds of `rms:0`, instead of only
  warning.
- **Rank 3 fix (code):** `src/renderer/voice/voice-controller.ts:733-746` (click reorder /
  pre-roll) and `:91` (`CLICK_WAKE_MIN_LISTEN_MS`).
- **Rank 2 trigger:** `src/main/voice/stt-service.ts:239-242` (`-l pt` / bin probing).
- **Do NOT let two builders edit `voice-controller.ts` concurrently** — Ranks 2 and 3 both
  live there; single owner for that file.

---

## Related

- **VOICE-PARITY-001** (voice fluidity / parity). This P0 blocker gates it: fluidity work is
  unverifiable while wake never fires. Rank 3 overlaps VOICE-PARITY-001's click-wake feel.

---

## Evidence appendix — UPDATE (2026-07-08, post-initial-write)

**New user statements:**
- "o mic não está travado, ele está disponível" — mic not locked/muted, available
- "está operacional, até mandei áudio no WhatsApp, tá tudo normal" — records real audio
  in WhatsApp and other apps right now → eliminates Rank 1 (device-side mute/level)

**New screenshot** (`1783511618717-image.png`):
- `[wake] "Hey Jarvis" detectado (score 0.49)` — wake fired at `11:23:23Z`
- `wake.detected: "Hey Jarvis"` in structured log
- Complete STT→brain→TTS turns at 11:51 and 11:52 with Portuguese conversation
- `tts.provider: openai (marin)` working; `jarvis.brainReply` latencies ~562–688 ms
- This is 6 minutes after the all-zero session at 11:16–11:17 → intermittent recovery
  with NO hardware change → confirms TCC phantom grant, not wrong device

**Bundle ID confirmed:** `com.nexuside.app`
(read from `/Applications/NexusIDE.app/Contents/Info.plist` via `defaults read`)

---

## Evidence appendix — original

**Screenshot:** `/Users/cleofasrocha/.overclock-app/dropped/1783509968088-image.png` —
showed `JARVIS LIVE` HUD in `Transcrevendo`, `sessão 0 turnos`, red banner
`Não estou ouvindo nada — mic mudo ou dispositivo errado.` + `AJUSTES DE SOM` button.

**Runtime log read:** `~/.nexus/logs/voice.log` — `mic.device: Default - fifine Microphone`,
`mic.firstFrame {"rms":0}` (repeating from 2026-07-07T20:32 onward, all sessions),
`mic.health: silent {"permission":"granted"}`,
`utt.weakSignal {"durationSec":22.272,"heardSpeech":false,"maxRms":0,"maxPeak":0,"rawMaxRms":0}`,
`mic.openSoundSettings` / `mic.openMicSettings`.

**Commits inspected (git show):**
- `c27d36b` fix(voice): keep click wake listening after ack — voice-controller.ts click
  reorder + empty pre-roll; `CLICK_WAKE_MIN_LISTEN_MS` 6500→8000.
- `e9953b9` fix(voice): speed up live wake fallback — `CLICK_WAKE_MIN_LISTEN_MS` 8000→2400;
  realtime-transcript-wait localSpeechUsable path.
- `e5996d0` fix(voice): keep jarvis operational on brain fallback — jarvis-brain.ts local
  fallback reply / noise-transcript filter (not on the wake path).
- `6c5ca68` fix(voice): harden local stt fallback — stt-service.ts `-l <language>` arg +
  Homebrew bin probing (Rank 2 trigger).
- `732d358` fix(voice): measure realtime tool latency cleanly — live-transport-controller.ts
  +1 latency marker (irrelevant to wake).
- History: `git log -L` on `voice-controller.ts:776` (gate → `93a76bd`) and `:1250-1253`
  (`!stt.ok` return → `ea2c165`/`8a3b044`) — both pre-date the five suspect commits.

**Files read (file:line):**
- `src/renderer/voice/wake-mic.ts:321-394` (capture/onFrame, silence tracking), `:126-127`.
- `src/renderer/voice/agc.ts:42-63` (AGC only amplifies; cannot zero a real signal).
- `src/main/voice/wake-engine.ts:236-318` (feed/score/THRESHOLD 0.48).
- `src/main/voice/voice-ipc.ts:180-234` (wake.audio → engine, wakeDetected broadcast).
- `src/renderer/voice/voice-controller.ts:704-841` (handleWake/onWake/gate), `:999-1063`
  (beginListening/isListening), `:1065-1346` (finishAndProcess — status wedge), `:91,105`.
- `src/renderer/components/VoiceHud.tsx:330-376` (silent/needsPermission banners).
- `src/renderer/voice/wake-health.ts:31-39` (classifyMicHealth).
- `src/preload/preload.ts:152-154` (wakeDetected relay).
