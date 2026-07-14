# Phase 0 — Warp / BridgeMind learnings → Nexus (diagnosis)

**Date:** 2026-07-13  
**Branch:** `fix/claude-family-zero-click`  
**Product version:** 0.15.4  
**Mode:** clean-room inspiration only (no AGPL Warp code; no BridgeMind assets/text)

## 1. Initial state

| Signal | Value |
|--------|--------|
| Worktree | Dirty with intent-first mission runtime WIP (must preserve) |
| Diff size | ~19 tracked files, +1299 / −77 lines (orch intent authority) |
| Untracked | mission prompt queue modules, training assets, local `.context` |
| Tests | ~582 `*.test.ts(x)` files |
| Scripts | package, smoke, rebuild, doctor, release verify |
| Graphify | 5709 nodes · 13881 edges · 246 communities (2026-07-09) |
| Import cycles | None detected |
| Design ref | `~/.design-references/linear.md` present (near-black + `#5e6ad2`) |
| License | MIT product; deps mostly MIT/Apache/BSD |

### God nodes (high coupling — do not rewrite)

1. `NexusApi` · `registerOrchIpc` · orchestration graph  
2. Voice realtime (`LiveTransportController`, `useVoiceController`, Gemini Live)  
3. Terminal: `pty-manager`, `terminal-host`, `terminal-output-scheduler`  
4. Persistence: project runtime manager + scoped stores  

### Strengths to extend (not replace)

- PTY in `utilityProcess`, env allowlist, session ownership + output ACK  
- Terminal scheduler: foreground priority, backpressure, ANSI-safe chunks  
- MCP effect policy, zod boundaries, durable mission budgets/reservations  
- Multi-CLI, accounts, handoffs, workspace path-scope  

### Gaps vs Warp / BridgeSpace UX ideas

| Capability | Nexus today | Gap |
|------------|-------------|-----|
| Semantic command blocks | Raw PTY stream only | No CommandBlock / OSC 133 |
| Mission event journal w/ cursor+ACK | `event_ledger` (context/workflow hash chain) + drive receipts | No consumer cursor / delivery ACK for mission UI agents |
| Unified search mixer | Separate file search / palette / settings | No multi-source mixer with cancel/generation |
| Typed feature flags | Ad-hoc booleans | No channel/kill-switch registry |
| Shell command history + redaction | Partial audit redaction | No searchable command history store |
| Progressive onboarding | Basic onboarding + LaunchScreen | No layout/agent distribution wizard |
| Real editor | FilesPanel textarea-ish | No CodeMirror, MD read mode |
| MCP Hub sync | MCP server + dispatch | No multi-source hub, drift, OAuth client hub |
| Skills catalog UX | skill-mirror | No catalog/lock UI |
| BridgeMemory | `memory_entries` + Jarvis facts | No `.nexus-memory/` MD + wikilinks |

## 2. Files planned for change (wave 1–2)

**New (domain contracts + infra):**

- `src/shared/feature-flags.ts`  
- `src/shared/command-block.ts`  
- `src/shared/mission-events.ts`  
- `src/shared/search-mixer-types.ts`  
- `src/main/feature-flags/feature-flag-registry.ts`  
- `src/main/terminal/command-block-store.ts`  
- `src/main/terminal/shell-integration-osc133.ts`  
- `src/main/terminal/command-redaction.ts`  
- `src/main/orch/mission-event-journal.ts`  
- `src/main/search/search-mixer.ts`  
- Tests colocated `*.test.ts`  
- Docs: this file + later domain docs  

**Modified:**

- `src/main/runtime/project-runtime-schema.ts` — migration `014-mission-events-command-blocks`  
- Possibly `src/main/persistence/schema-migrations.ts` only if global tables needed (prefer project runtime)  
- Wire points later: `pty-manager`, terminal host, orch-ipc, UI (subsequent waves)

**Do not touch in wave 1:** existing dirty intent-first files except when additive wiring is unavoidable.

## 3. Dependencies

| Need | Decision |
|------|----------|
| Zod | Already present `^4.4.3` — use for all external input |
| better-sqlite3 | Already present — project runtime migrations |
| CodeMirror 6 (phase 5) | **Not installed yet** — evaluate license (MIT), size, before add |
| ripgrep | Prefer system `rg` + existing file search; no new dep for mixer core |
| MCP OAuth/SSE client (phase 6) | Evaluate `@modelcontextprotocol/sdk` if not already embedded |

No new npm packages in wave 1–2.

## 4. Risks

| Risk | Mitigation |
|------|------------|
| Break intent-first WIP | Additive modules only; no rewrite of mission-intent |
| Migration checksum / history | Append-only migration id 014; never edit past SQL |
| Secret leakage in command history | Redact before write; denylist; tests with secret fixtures |
| Terminal perf regression | OSC parse off hot path when disabled; flag kill switch |
| Dual journals (`event_ledger` vs `mission_events`) | Document ownership: ledger = integrity hash chain; mission_events = delivery/replay UI |
| AGPL contamination | Clean-room only; no Warp source copy |

## 5. Execution order

1. **Wave 0** — this diagnosis + baseline metrics  
2. **Wave 1** — feature flags, CommandBlock, mission_events journal, SearchMixer contracts + unit tests  
3. **Wave 2** — OSC 133 parser, command history persist, redaction, search source  
4. **Wave 3** — onboarding/launcher shell (UI, Linear tokens)  
5. **Wave 4+** — contextual panel, editor, MCP hub, skills, memory, autonomy profiles  

Each wave ends with checkpoint report (summary, files, tests, metrics, rollback).

## 6. Baseline metrics (pre-implementation)

| Metric | Baseline method | Baseline value |
|--------|-----------------|----------------|
| First terminal | Manual / smoke: launch → shell pane ready | *TBD instrumented* — target &lt; 30s |
| Local search p95 | `file_search` / palette | *TBD* — target &lt; 50ms |
| Async first partial | N/A (mixer not present) | N/A |
| Editor open | FilesPanel open file | *TBD* (textarea) |
| Typing latency | Subjective / future perf probe | *TBD* |
| Memory 1/4/8/12 panes | `perf_snapshot` IPC | *TBD capture* |
| Terminal backlog max | scheduler constants in `terminal-output-scheduler` | Existing hard caps |
| Mission events lost after replay | N/A (new journal) | 0 target |
| Secrets in history | N/A | 0 target |
| Crash-free sessions | Existing crash reporting | *no change expected wave 1* |

Instrumentation hooks to add with flags:

- `feature.terminal.commandBlocks`  
- `feature.mission.eventJournal`  
- `feature.search.mixer`  

## 7. Non-regression checklist

- [ ] PTY isolation / ownership / env allowlist  
- [ ] Output ACK + scheduler backpressure  
- [ ] MCP effect policy + `effectMayHaveCommitted`  
- [ ] Mission budgets / durable reservations / step receipts  
- [ ] Workspace path traversal protection  
- [ ] Intent-first mission authority WIP  
- [ ] Audit redaction depth/size limits  
- [ ] No secrets in logs/tests  
- [ ] `tsc --noEmit` / unit tests green for touched modules  
- [ ] Migrations only additive; reversible strategy documented  

## 8. Rollback strategy (wave 1)

1. Flip feature flags kill switches to off (fail-closed → new paths unused).  
2. Revert migration only on **dev** DBs (drop new tables) — production: leave empty tables (harmless).  
3. Git: reverse only new files + migration 014; never `reset --hard` dirty WIP.  

## 9. Graphify note

Full graph rebuild deferred (large corpus, expensive). Used existing `graphify-out/GRAPH_REPORT.md` for god nodes and cycle check. Re-run `--update` after wave 3+ surface changes.
