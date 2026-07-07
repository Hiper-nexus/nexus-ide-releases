# Fase 3 - Jarvis Realtime OpenAI

## Added

- OpenAI Realtime is the primary Jarvis Live transport, with Gemini Live as the realtime fallback and Classic as the failure fallback.
- Jarvis Live transcripts are persisted as JSONL under the NexusIDE application support transcript directory.
- Realtime latency metrics now cover audio-to-transcript, transcript-to-action, transcript-to-audio, and roundtrip timing.
- Voice settings can smoke-test the configured realtime provider and render the persisted transcript tail.

## Changed

- Jarvis Live start now waits for the realtime socket setup before the renderer begins streaming microphone frames.
- Realtime prompts and Jarvis brain instructions are written in English while preserving Brazilian Portuguese spoken output.
- The renderer voice controller uses the realtime path when `REALTIME_ACTION_BRIDGE_ENABLED` is true and the live transport is ready, avoiding the batch STT/brain/TTS path for realtime turns.

## Tests

- Added and updated unit coverage for OpenAI Realtime session setup, Gemini fallback adaptation, transcript persistence, and latency metrics.
