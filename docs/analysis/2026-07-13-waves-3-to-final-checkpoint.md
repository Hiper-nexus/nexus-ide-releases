# Checkpoint — Waves 3 → final

## 1. Summary
Completed vertical slices for waves 3–12 on top of existing product-wave foundations: App-wired ModeLauncher + ContextualPanel + ProgressiveOnboarding (open-without-AI), editor secure model path with CM deferred, SearchMixer IPC, MCP hub, skills, memory, agents/autonomy, security containment, docs, and verification pack in SCRATCH.

## 2. Key files
- Shell: `LaunchScreen.tsx`, `ProgressiveOnboarding.tsx`, `ModeLauncher.tsx`, `ContextualPanel.tsx`, `progressive-launch.ts`, `App.tsx`
- Editor: `editor-document.ts`, `product-wave-ipc` editorOpen/Apply
- Search: `search-mixer-*`, `ripgrep-fallback.ts`
- MCP/Skills/Memory/Autonomy/Agents as under `src/main/*`
- Docs: SECURITY, OPERATIONS, MCP-HUB, SKILLS, MEMORY, EDITOR, EDITOR-CODEMIRROR-EVAL, TERMINAL-BLOCKS, MISSION-EVENTS

## 3. Tests
- Wave vitest pack: **112 passed** (`{SCRATCH}/vitest.log`)
- Per-wave logs wave3–wave9-10, security-containment
- typecheck EXIT 0

## 4. Metrics
See `{SCRATCH}/metrics.md`

## 5. Risks / residual
CM install deferred; OAuth MCP deferred; packaged smoke path incomplete; E2E BLOQUEADO

## 6. Gaps
See `{SCRATCH}/checklist.txt` PARCIAL/BLOQUEADO next actions

## 7. Migrations
014 mission_events + command_blocks (prior)

## 8. Flags
Product flags defaultEnabled true; kill switches available

## 9. Rollback
Flag kill switch / overrides; MCP `.bak`; leave empty tables

## 10. Next
CM install after size review; OAuth MCP; wire worktree provider for Autonomous; Playwright E2E; re-package for smoke
