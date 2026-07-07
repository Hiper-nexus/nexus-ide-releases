# Fase 4 Changelog

## 2026-07-07

- Registered the Jarvis MCP IPC bridge in the main process and exposed typed
  renderer methods for invoking, confirming, and clearing MCP tool sessions.
- Added workspace-bound path and cwd resolution for Jarvis file, editor,
  terminal, and git tools.
- Switched git tool execution from shell interpolation to `execFile` argument
  arrays.
- Added `nexus_file_close` as a safe no-op tool for complete file workflows.
- Persisted Jarvis MCP audit entries as JSONL with timestamp, tool, redacted
  args, result, duration, and `user_authorized`.
- Tightened permission hashing for nested args so user authorization stays
  scoped to the exact requested action.
- Added regression coverage for destructive command confirmation, force-push
  confirmation, audit persistence, scoped permissions, workspace path escape,
  cwd escape, and git argument injection.
- Kept the realtime voice action bridge disabled for v1.0.0. Voice-to-MCP
  execution remains deferred to F4.x/F6.2 so the existing F3 blocker fix stays
  in place until a complete confirmation/audit integration lands.
