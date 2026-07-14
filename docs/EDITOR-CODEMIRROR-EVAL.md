# CodeMirror 6 dependency evaluation (formal)

**Date:** 2026-07-13  
**Decision:** **DEFER install** — ship secure non-CM editor model path (`editor-document.ts` + FilesPanel/ProductPanelBodies) until size/security sign-off.

| Criterion | Finding |
|-----------|---------|
| License | MIT (`@codemirror/*`, `@lezer/*`) — OK for Nexus MIT |
| Size | Multi-package: core + view + state + language + language-data ≈ hundreds of KB min+gzip; acceptable for desktop IDE if tree-shaken |
| Security | No network; runs in renderer under existing CSP; must not enable `eval` |
| Need | Syntax highlight, multi-select, undo/redo — desirable; current model already enforces dirty/hash/limits/containment |
| Risk | Bundle growth + Electron rebuild surface; must not regress FilesPanel security |

**Ship criteria met without CM:**
- Open/save with content hash + dirty
- Binary / oversized explain path
- Markdown read vs explicit edit-source mode
- Workspace-bound open/apply via `resolveScopedPath`

**Next action for CM:** install `@codemirror/view` + `@codemirror/state` + language packs behind `feature.editor.codemirror` after design-bar size budget review; swap renderer only.
