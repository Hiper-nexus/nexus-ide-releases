# Checkpoint — Wave 0–2 foundations (2026-07-13)

## 1. Summary implemented

- Phase 0 diagnosis document with risks, order, non-regression list.
- Typed feature-flag registry (channel, kill switch, overrides, fail-closed).
- CommandBlock model + redaction + OSC 133 scanner + tracker + SQLite store.
- Mission event journal (append, dedupe, replay, cursor, ACK, projection).
- SearchMixer core (debounce, generation, cancel, stable ranking).
- Project runtime migration **014** (`mission_events`, `mission_event_cursors`, `command_blocks`).
- Optional shell integration snippets (zsh/bash/fish).
- Tracker wired in `main` bootstrap (no-op when flag off).
- Docs: TERMINAL-BLOCKS, MISSION-EVENTS, SEARCH-MIXER, ARCHITECTURE pointer, CHANGELOG Unreleased.

## 2. Files touched (this wave)

**New:**  
`src/shared/feature-flags.ts`, `feature-flags.test.ts`, `command-block.ts`, `command-block.test.ts`, `mission-events.ts`, `search-mixer-types.ts`  
`src/main/feature-flags/*`  
`src/main/terminal/*` (scanner, redaction, store, tracker, id)  
`src/main/orch/mission-event-journal.ts` + test  
`src/main/search/search-mixer.ts` + test  
`resources/shell-integration/nexus-osc133.{zsh,bash,fish}`  
`docs/analysis/2026-07-13-warp-bridgemind-phase0-diagnosis.md`  
`docs/TERMINAL-BLOCKS.md`, `docs/MISSION-EVENTS.md`, `docs/SEARCH-MIXER.md`  
`docs/analysis/2026-07-13-wave1-checkpoint.md`

**Modified:**  
`src/main/runtime/project-runtime-schema.ts` (migration 014)  
`src/main/main.ts` (ensureCommandBlockTracking)  
`docs/ARCHITECTURE.md`  
`CHANGELOG.md`

**Preserved:** all prior dirty intent-first worktree changes (not reset/overwritten).

## 3. Tests run

```
npx vitest run [9 wave test files]
→ 35 passed
npx vitest run … + project-runtime-manager.test.ts
→ 49 passed (earlier full set)
tsc --noEmit → only pre-existing error in mission-intent.test.ts (WIP on branch)
```

## 4. Metrics vs baseline

| Metric | Baseline | Now |
|--------|----------|-----|
| First terminal | uninstrumented | unchanged (flag off) |
| Mission events lost after replay | N/A | 0 in unit tests |
| Secret in command history | N/A | blocked by redaction tests |
| CommandBlock recognition | N/A | tracker tests cover OSC path |
| Search local p95 | N/A | mixer unit only |

## 5. Remaining risks

- Tracker not yet bound to pane/workspace meta on spawn (lazy `unknown` meta).
- Journal not yet wired into mission driver / MCP dispatch (flag off).
- SearchMixer has no live providers registered in IPC/UI.
- Shell integration not auto-injected into PTY env yet.
- Baseline perf numbers still TBD instrumentation.

## 6. Not implemented (explicit)

| Item | Status | Why |
|------|--------|-----|
| Full progressive onboarding UI | BLOQUEADO wave | Depends on flags + design pass (Linear) |
| Launcher modes shell | BLOQUEADO | Same |
| Contextual panel Browser/Editor/Git | BLOQUEADO | Later wave |
| CodeMirror editor | BLOQUEADO | Needs dep evaluation (license/size) |
| MCP Hub / OAuth / drift | BLOQUEADO | Large surface; contracts first |
| Skills catalog + lock | BLOQUEADO | Later |
| `.nexus-memory/` wikilinks | BLOQUEADO | Later; memory_entries exists |
| Autonomy profiles | BLOQUEADO | Later |
| Terminal re-exec / worktree actions UI | PARCIAL | Redaction+model ready; IPC/UI pending |
| E2E / packaged smoke for new flags | BLOQUEADO | Flags default off; smoke later |
| Promote flags to dogfood/stable | BLOQUEADO | Need dogfood evidence |

## 7. Migrations

- `014-mission-events-command-blocks` (appVersion `0.15.5` label in registry) — additive CREATE TABLE + indexes + immutability trigger for event core columns.

## 8. Feature flags

All learning-wave flags **defaultEnabled: false**. Kill switch available. Override file path optional via registry options.

## 9. Rollback

1. Leave flags off (default).  
2. Kill switch any flag if needed.  
3. Revert new files + migration 014 registration only on **dev** DBs if required; production: empty tables are safe.  
4. Never `git reset --hard` (preserves intent-first WIP).

## 10. Next checkpoint

1. Bind CommandBlockTracker meta on session spawn; persist via CommandBlockStore when project scope known.  
2. Emit mission_events from driver lifecycle when `feature.mission.eventJournal` on.  
3. Register SearchMixer providers (missions, commands, settings) + IPC.  
4. Progressive onboarding / launcher shell (Linear tokens).  
5. Capture real baseline metrics via `perf_snapshot`.
