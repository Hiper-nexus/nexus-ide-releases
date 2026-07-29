---
name: dembrandt
description: >
  Use automatically on UI, UX, landing, brand, frontend, or design-system work
  when DESIGN.md is missing, outdated, or the goal cites a live URL / visual
  reference (inspirado em, parecido com, mockup, brand). Extracts real design
  tokens from a public URL via nexus_design_system_extract into a ContextDraft
  — never invents a palette when a measurable reference exists. Pair with
  impeccable for craft and critique. Do not wait for the user to name Dembrandt.
  Only orchestrator / user sessions may call nexus_design_system_extract.
---

# Dembrandt — live design-system extraction

You measure what a live site actually renders, then feed that contract into
Nexus context authority. Impeccable builds and critiques; Dembrandt supplies
the measured brief.

## Who calls extract

**Only the orchestrator (or a user session)** may call
`nexus_design_system_extract`. Workers / executors / reviewers cannot propose
context drafts — if you are a worker, consume the applied DESIGN.md /
`.context/docs/design-system.md` and continue with impeccable. Do not retry
extract as a worker.

## Autonomous mandate (orchestrator — do not wait to be asked)

On UI / landing / brand / frontend missions:

1. Check for `DESIGN.md` at the workspace root **or**
   `.context/docs/design-system.md`.
2. If either is missing **or** the goal cites a public URL / visual reference
   ("inspirado em", "parecido com", "como stripe.com", mockup, brand site),
   call `nexus_design_system_extract` **before inventing colors, type, or
   spacing**.
3. Prefer extract over guesswork. Prefer an existing local DESIGN.md over
   re-extracting the same URL every turn.
4. Extraction creates a **proposed ContextDraft** (default target
   `.context/docs/design-system.md`). It does **not** write the final file.
   Follow the normal draft review → apply flow. Never call
   `nexus_design_system_publish` unless the user explicitly asks.
5. After a usable design contract exists, continue with **impeccable** for
   craft, hierarchy, a11y, and anti-AI-slop checks.

## Tool contract

```
nexus_design_system_extract
  url: string (required) — public http(s) reference
  paths?: string[] — extra paths to merge (e.g. /pricing)
  darkMode?: boolean
  mobile?: boolean
  wcag?: boolean
  targetPath?: string — default .context/docs/design-system.md
  missionId?: string
```

## Hard rules

- **Do not** copy third-party logos, wordmarks, or trademarks into the product.
  Adapt measured tokens (palette, type scale, spacing, radius, motion) to the
  project identity.
- **Do not** extract private-network / localhost URLs through this tool; those
  are blocked by policy.
- **Do not** treat raw extraction as trusted brand law until the draft is
  reviewed and applied.
- When building the Nexus IDE itself, obey the workspace `DESIGN.md` (sci-fi
  operational, Inter + VT323). Do not restyle Nexus chrome from a random URL.

## After extract

- Read the draft / applied design-system doc.
- Implement with Impeccable craft rules.
- Finish UI with hover/focus/empty/error states and a short UX critique.
- Reject generic AI looks: purple gradients, glassmorphism defaults, emoji
  sparkles as icons, identical card grids.
