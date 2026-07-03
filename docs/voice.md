# Voice (Jarvis Mode)

Push-to-talk speech → transcribe+translate to English → inject into the focused
pane → speak a condensed summary back. Multi-provider, declarative, with a
keyless local fallback so it keeps working when cloud APIs are throttled.

## Pipeline

```
Hold Cmd+Shift+Space
  → getUserMedia 16 kHz mono + AudioWorklet PCM (renderer)
  → STT chain (main): Groq translate → OpenAI → whisper.cpp local   (PT → EN)
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
| Groq (STT default) | `GROQ_API_KEY` | `whisper-large-v3-turbo`, `task=translate` |
| OpenAI (STT fallback + TTS default) | `OPENAI_API_KEY` | `whisper-1` / `tts-1` |
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

Config lives at `~/.nexus/plugins/voice/nexus-voice.json` (a superset of the
Overclock ClockVoice `audio-config.json`, which is auto-migrated on first run).
To make OpenAI or local the primary STT, either:

- **UI:** the voice button in the WorkspaceBar → *Voice · Jarvis Mode* → pick the
  STT/TTS provider, speak mode, routing, and PTT key. "Test voice" speaks a line
  through the active TTS chain (works with zero keys via `say`).
- **Config:** reorder the `stt`/`tts` fallback chain, or set the head `provider`
  to `openai` / `local-whisper`. One line, no recompile.

`voice.speakMode`: `summary` (default, 1–3 sentences) · `full` · `off` (dictation
only). `voice.routing`: `focused-pane` (default) · `orchestrator` · `ask`.
