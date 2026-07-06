# Voice (Jarvis Mode)

> **Nota (2026-07-05):** o modo de roteamento **padrão hoje é `jarvis`** — o áudio
> é transcrito cru em PT-BR (`translate: false`) e vai para o cérebro LLM
> (`jarvis-brain.ts`), que decide fala + ação (`open_squad`, `new_mission`,
> `run_command`, `send_to_pane`, …). Configs antigas são migradas automaticamente
> para `jarvis` em `voice-config-store.ts`. O pipeline descrito abaixo
> (transcribe+translate → pane focado → resumo falado) é o modo **`focused-pane`**,
> mantido como alternativa. As cadeias de STT/TTS e providers valem para os dois.

Push-to-talk speech → transcribe+translate to English → inject into the focused
pane → speak a condensed summary back. Multi-provider, declarative, with a
keyless local fallback so it keeps working when cloud APIs are throttled.

## Jarvis Live

Jarvis Live is an optional continuous session mode layered on top of Jarvis
Classic. It does not replace the resilient STT/TTS fallback chain. Instead it
keeps a live session identity, reuses the short conversation context, broadcasts
`voice:live.*` state/transcript/tool/interruption events, and reopens listening
after each answer until the user goes silent.

Behavior:

- `voice:live.start` starts or reuses the session (`manual`, `wake`, `ptt`, or
  `reply` reason).
- `voice:live.state` reports `listening`, `thinking`, `speaking`,
  `interrupted`, `dormant`, or `error`.
- `voice:live.transcript` emits final user/assistant lines for the live window.
- `voice:live.tool.call` / `voice:live.tool.result` expose app actions such as
  `send_to_pane`, `open_squad`, and `run_command`.
- `voice:live.endTurn` closes the current exchange while keeping the session
  dormant for reuse.
- Barge-in calls `voice:live.interrupt`, cuts pending playback, and immediately
  allows a new turn.
- If the user does not answer after a Live reply, the silence gate ends the
  capture and the session moves to `dormant`; the next wake/PTT reuses it.

Config lives in `voice.jarvisLive`:

```json
{
  "jarvisLive": {
    "enabled": true,
    "graceReuseMs": 90000,
    "dormantAfterMs": 300000,
    "maxWindowTurns": 12
  }
}
```

The settings UI exposes this as **Jarvis Live**. For hands-free operation, enable
both **Hey Jarvis** and **Jarvis Live**; for a tighter workstation flow, leave
wake word off and use the PTT shortcut to enter the same live session.

## Jarvis Brain Providers

The Jarvis brain is separate from STT/TTS. It is the chat model that receives
the app context and returns the strict JSON reply `{say, expectReply, action}`.
The default chain is:

1. Gemini (`GEMINI_API_KEY`, `gemini-3.5-flash`)
2. OpenAI (`OPENAI_API_KEY`, `gpt-4o-mini`)
3. Groq (`GROQ_API_KEY`, `llama-3.3-70b-versatile`)

The settings UI exposes this as **Jarvis brain**. Selecting a provider promotes
it to the head of `voice.jarvisBrain` while keeping the rest as fallback. The
same chain is reused by the squad architect so "design squad" does not depend
on a hidden hardcoded provider.

## Pipeline

```
Hold Cmd+Shift+Space
  → getUserMedia 16 kHz mono + AudioWorklet PCM (renderer)
  → STT chain (main): Groq translate → OpenAI → whisper.cpp local   (PT → EN)
  → Jarvis brain (main): Gemini → OpenAI → Groq                  (JSON action)
  → inject text into the focused pane's PTY (same path as typing)
  → capture the agent's reply, condense to 1–3 sentences (speakMode: summary)
  → TTS chain (main): OpenAI tts-1 → Piper → macOS `say`
  → play in renderer (Web Audio) / `say` plays directly
```

- **Push-to-talk key:** `globalShortcut` handles keydown. True hold-to-talk needs
  the optional native `uiohook-napi` for keyup; without it the hotkey degrades to
  **toggle** mode (press to start, press again to stop). The HUD/button shows
  which mode is active.
- **VAD (Silero):** optional; a no-op unless `onnxruntime-node` is installed.

## Enabling providers (env vars, read in MAIN only)

Secrets never reach the renderer or shell panes — they are read from
`process.env` in the main process at request time.

| Provider | Env var | Notes |
|----------|---------|-------|
| Gemini (Jarvis brain default) | `GEMINI_API_KEY` | OpenAI-compatible chat completions, `gemini-3.5-flash` |
| OpenAI (Jarvis brain fallback + STT/TTS) | `OPENAI_API_KEY` | brain `gpt-4o-mini`, STT `whisper-1`, TTS `tts-1` |
| Groq (Jarvis brain fallback + STT default) | `GROQ_API_KEY` | brain `llama-3.3-70b-versatile`, STT `whisper-large-v3-turbo` |
| whisper.cpp (STT last resort) | — (keyless) | `brew install whisper-cpp` + a model |
| Piper (TTS fallback) | — (keyless) | optional local binary |
| macOS `say` (TTS last resort) | — (keyless) | always available; voice `Luciana` |

**With no keys at all:** TTS still works via macOS `say`; STT needs local
whisper.cpp (bin `whisper-cli`/`main` on PATH or in `~/.nexus/bin`, plus a model
at `~/.nexus/models/whisper/ggml-base.bin`). If neither a key nor a local binary
is present, the HUD shows a clear "set GROQ_API_KEY / install whisper.cpp"
message.

## Resilient fallback (free-tier Groq / rate limits)

The STT chain is **error-driven**, not just key-driven. A provider is skipped and
the next one tried automatically when it is:

- missing its API key,
- **throttled — HTTP 429**,
- **quota/billing — HTTP 402 / 403**,
- **auth — HTTP 401**,
- **server error — HTTP 5xx**, or
- unreachable (network error).

So a free-tier Groq account that regularly 429s transparently falls through to
OpenAI, and then to keyless local whisper.cpp. When this happens the HUD shows a
note like `groq throttled (429 rate limit) → openai` instead of failing silently.

## Changing the default provider (no rebuild)

Config lives at `~/.nexus/plugins/voice/nexus-voice.json` (a superset of a
legacy `audio-config.json`, which is auto-migrated on first run).
To make OpenAI or local the primary STT, either:

- **UI:** the voice button in the WorkspaceBar → *Voice · Jarvis Mode* → pick
  STT, TTS, **Jarvis brain**, speak mode, routing, and PTT key. "Test voice"
  speaks a line through the active TTS chain (works with zero keys via `say`).
- **Config:** reorder the `stt`/`tts` fallback chain, or set the head `provider`
  to `openai` / `local-whisper`. Reorder `jarvisBrain` or set its head provider
  to `gemini`, `openai`, or `groq`. One line, no recompile.

`voice.speakMode`: `summary` (default, 1–3 sentences) · `full` · `off` (dictation
only). `voice.routing`: `jarvis` (default) · `focused-pane` · `orchestrator` ·
`ask`.
