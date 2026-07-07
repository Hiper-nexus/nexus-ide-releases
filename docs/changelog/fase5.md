# Fase 5 - Jarvis Vision

## 2026-07-07

- Added local Jarvis Vision capture, AX tree extraction, OCR, and IPC wiring.
- Added a vision context orchestrator that combines AX, screenshot metadata, and local OCR text.
- Kept raw screenshots local by default; `allowCloudImage` must be true before `imageBase64` is exposed for LLM vision/cloud flows.
- Added graceful degradation for unavailable AX, denied screen recording permission, and OCR failures.
- Added a compact `VisionIndicator` in the workspace bar for recent capture feedback.
- Added unit coverage for PNG validation, OCR fixture text, AX jsdom extraction, VisionIndicator mount/events, and permission-denied degradation.
