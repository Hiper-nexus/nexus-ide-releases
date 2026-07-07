# Fase 3 - Jarvis Realtime OpenAI

## Added

- OpenAI Realtime is the primary Jarvis Live transport, with Gemini Live as the realtime fallback and Classic as the failure fallback.
- Jarvis Live transcripts are persisted as JSONL under the NexusIDE application support transcript directory.
- Realtime latency metrics now cover audio-to-transcript, transcript-to-action, transcript-to-audio, and roundtrip timing.
- Voice settings can smoke-test the configured realtime provider and render the persisted transcript tail.

## Changed

- Jarvis Live start now waits for the realtime socket setup before the renderer begins streaming microphone frames.
- Realtime prompts and Jarvis brain instructions are written in English while preserving Brazilian Portuguese spoken output.
- `REALTIME_ACTION_BRIDGE_ENABLED` remains false by default in Phase 3. Nexus actions continue through the batch STT/brain/action path until Phase 4 wires realtime tools.

## Post-review fixes

- Restored the `main` wake mic hot-zone implementation: Chromium APM remains off (`echoCancellation:false`, `noiseSuppression:false`, `autoGainControl:false`) and device/settings/first-frame RMS instrumentation is back.
- Restored `0.10.6` package metadata, release notes and changelog content from `main`.
- OpenAI Realtime now uses manual PTT turn control (`turn_detection:null`) and notifies the live controller when the socket closes after setup.
- Live controller marks `realtimeReady:false`, closes the stale provider and schedules reconnect after post-setup disconnects.
- OpenAI pending audio is stored at the original sample rate and resampled only once when flushed.
- Persisted transcripts now write final lines only, cap text length, rotate by date/size and prune expired JSONL files.
- Gemini Live reconnect timers are cancelled on teardown/new connect and guarded by a connection generation token.

## Deferred debt

- MEDIUM-9: realtime metrics still use wall-clock `Date.now`; move durations to a monotonic clock and independent turn ids.
- MEDIUM-10: release-failure test coverage still needs broader failure-mode contracts.
- LOW-11: realtime smoke-test UI copy still mentions only `OPENAI_API_KEY`; make it provider-aware with sanitized main-process diagnostics.

## Tests

- Added and updated unit coverage for OpenAI Realtime session setup/manual turns/disconnects, Gemini fallback and stale reconnect timers, transcript persistence/rotation, wake mic constraints and latency metrics.
