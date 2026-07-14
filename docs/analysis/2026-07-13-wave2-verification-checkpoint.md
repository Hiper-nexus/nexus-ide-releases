# Checkpoint — Wave A–C foundations + verification pack

## 1. Summary

Closed skeptic gaps: production CommandBlock → SQLite persist, mission driver journal emit, SearchMixer ripgrep fallback, terminal actions through `writeSession`, retention/size budget, MCP hub/skills/memory/autonomy/editor foundations, progressive onboarding + launcher + contextual panel components, required docs, full `{SCRATCH}` evidence.

## 2. Files (delta this session)

See git status; major new dirs: `src/main/terminal/*`, `src/main/search/*`, `src/main/mcp-hub/*`, `src/main/skills/*`, `src/main/memory/*`, `src/main/autonomy/*`, `src/main/editor/*`, `src/main/agents/*`, `src/renderer/components/{ProgressiveOnboarding,ModeLauncher,ContextualPanel}.tsx`, docs SECURITY/OPERATIONS/MCP-HUB/SKILLS/MEMORY/EDITOR.

## 3. Tests

- `vitest` targeted pack: **90 passed** (`{SCRATCH}/vitest.log` EXIT:0)
- All gating logs EXIT:0 (command-block, mission-events, search-mixer, flags, terminal-*, mcp, skills, memory, editor, autonomy, agents, security, mission-regression)
- `tsc --noEmit`: **EXIT:0** (fixed mission-intent.test typing)

## 4. Metrics

See `{SCRATCH}/metrics.md`.

## 5. Risks

- Progressive onboarding/panel not default-wired in App.tsx (flag components ready).
- CodeMirror not installed (formal eval in EDITOR.md).
- MCP OAuth/SSE full clients deferred.
- E2E/packaged smoke: honest env fallback.

## 6. Gaps (honest)

Recorded in `{SCRATCH}/checklist.txt` as PARCIAL/BLOQUEADO with next actions.

## 7. Migrations

`014-mission-events-command-blocks`.

## 8. Flags

All learning-wave flags default **off**; dogfood via overrides file.

## 9. Rollback

Kill switches + flag off; MCP `.bak`; leave empty SQLite tables.

## 10. Next

Wire UI components into App behind flags; CM size review; MCP OAuth; E2E.
