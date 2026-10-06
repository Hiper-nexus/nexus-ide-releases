# Mission graph presentation implementation plan

> **For agentic workers:** Execute the approved bounded renderer change task by task; tests before implementation. No commit or deployment in this task.

**Goal:** Let the operator present and record the existing mission graph across the entire screen, choose horizontal or vertical flow, and fit the whole graph or zoom details with visible controls.

**Architecture:** Preserve the physical racks, operational state, pink cabling and vertical coordinates. Horizontal geometry places the coordinator at the left and dependency/delegation layers toward the right, while feedback edges remain feedback. Reuse the cable router with transposed geometric coordinates, never rotated text. Presentation uses the browser Fullscreen API and the established overlay layer as fallback; exit restores focus without changing mission execution.

**Tech stack:** Existing React renderer, native Fullscreen API, ResizeObserver, existing CSS tokens and Vitest/jsdom.

**Spec:** Operator request approved on 2026-10-05: keep the current graph's look; add visibly labeled full-screen presentation for videos, horizontal layout alongside vertical, and fit-to-screen controls.

## Constraints

- Renderer graph only; no Main/shared authority changes or new dependencies.
- Vertical remains default and preserves existing coordinates and behavior.
- Controls: Tela inteira / Sair da tela inteira, Vertical / Horizontal, Ajustar à tela, accessible zoom controls.
- Escape and external fullscreen exit restore focus; graph remains live and session-ended cards retain their click guard.
- Use DESIGN.md tokens, existing icon language and portal layer; no simulated operational activity.

## Tasks

- [x] Add failing geometry/cabling and presentation interaction tests.
- [x] Add horizontal DAG layering with bounded columns and port routing on left/right faces.
- [x] Add sticky presentation toolbar, zoom/fit viewport and accessible fullscreen/fallback lifecycle.
- [x] Preserve cards and cabling styling; add only presentation layout styles.
- [x] Run focused graph/cabling and board regression tests; review the changed renderer surface.

Validation: focused graph/cabling/card/board + production snapshot integration passed; complete typecheck and renderer sink audit passed. Chrome inspection uses an explicitly labeled synthetic QA fixture of the actual renderer/CSS, never production demo data. Horizontal 20-agent and native full-screen captures at 1920×1080 show the full team; vertical preserves its original scrollable rack arrangement.

Fit scale is independent from the manual reading floor: fit permits down to 5% for a complete overview; manual zoom is 60–150%. Small overview text is accompanied by an explicit invitation to zoom details.
