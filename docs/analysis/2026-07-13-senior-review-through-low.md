# Senior code review — product wave (through LOW remediations)

**Scope:** commits `b994d98..520a5ad` + unstaged containment/flag hardening  
**Mode:** clean-room senior review (local) + fixes through LOW  
**Date:** 2026-07-13

## Findings (before → after)

| Sev | Finding | Status |
|-----|---------|--------|
| HIGH | `editorOpen` lexical path + symlink read leak | Fixed earlier (resolveScopedPath) |
| HIGH | `scanSkillsDirectory` followed SKILL.md / skill-dir symlinks → outside content | **Fixed:** lstat + realpath under catalog root |
| HIGH | Skills/MCP IPC scanned `$HOME/.claude/skills` (cross-project leak) | **Fixed:** workspace-scoped dirs only |
| MED | `skillsDirs` threw if optional subdirs missing | **Fixed:** `tryResolveSubdirUnderRoot` |
| MED | Memory/MCP/search/autonomy IPC missing flag gates | **Fixed:** `requireFlag` on handlers |
| MED | Shallow search walk could surface symlink paths | **Fixed:** skip symlinks + `isInsidePath` |
| MED | Skills search used `process.cwd()` when no projectRoot | **Fixed:** fail-closed empty |
| MED | Skills lock write not atomic in IPC | Fixed earlier (`writeSkillsLock`) |
| MED | Autonomy accepted client `scope` / `inIsolatedWorktree` | Fixed earlier (main-derived) |
| LOW | Shallow provider source labeled `workspaces` | **Fixed:** `files` |
| LOW | Mission search hits unlabeled as memory notes | **Fixed:** subtitle `memory:mission` |
| LOW | `resolveSubdirUnderRoot` weak on symlink ancestors | **Hardened:** reject symlink ancestor outside root |

## Residual (accepted / next)

| Sev | Item | Why not blocking |
|-----|------|------------------|
| LOW | CodeMirror not installed | Documented EDITOR.md; model path only |
| LOW | OAuth MCP transports incomplete | Config plane only; effect policy intact |
| LOW | E2E/packaged smoke | Env; unit gates pass |

## Validation

- `vitest` targeted security/product suite — see `{SCRATCH}/senior-review-fixes.log`
- `tsc --noEmit` — see `{SCRATCH}/typecheck.log`

## Rollback

Feature kill switches / flag overrides; no destructive git on WIP branches.
