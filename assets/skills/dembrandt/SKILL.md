---
name: dembrandt
description: >
  Use on UI, UX, landing, brand, frontend, or design-system work when DESIGN.md
  is missing/outdated or the goal cites a visual reference. Walk the source
  ladder — existing contract, then the keyless local-catalog and getdesign
  sources, then designmd.ai when a key exists; live MCP extraction is
  fail-closed until Nexus has a per-request redirect/subresource route guard.
  Pair with impeccable for craft and critique. Only orchestrator/user sessions
  may call extract.
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

## Orchestrator flow

On UI / landing / brand / frontend missions:

1. Check for `DESIGN.md` at the workspace root **or**
   `.context/docs/design-system.md`.
2. Never start UI work without a contract — without one the output is the
   model's default styling. Walk this ladder in order and stop at the first
   source that answers:
   1. **The existing workspace contract** (step 1). If it exists, it rules.
   2. **`local-catalog`** — `nexus_design_system_local_list` then
      `nexus_design_system_local_import` with `source: "local-catalog"`. Plain
      `.md` files in the local design-reference folder. Offline, instant, **no
      key of any kind**.
   3. **`getdesign`** — the same two tools with `source: "getdesign"`. The open
      `getdesign` CLI catalog. **Still no key**; costs one sandboxed CLI run.
   4. **designmd.ai** — `nexus_design_system_search/get/import`, and only when
      `external:designmd-api-key` is in the vault. Its `/raw` body endpoint
      answers **401** without that secret, MIT license or not, so a missing key
      means step 4 is unavailable, not that the mission is blocked.
3. For another public URL, `nexus_design_system_extract` may be attempted once.
   If it returns `NETWORK_GUARD_UNAVAILABLE`, **do not retry and do not block
   the mission**. Go back to the ladder in step 2 and state the limitation
   instead of inventing measured tokens.
4. Extraction creates a **proposed ContextDraft** (default target
   `.context/docs/design-system.md`). It does **not** write the final file.
   Follow the normal draft review → apply flow. Never call
   `nexus_design_system_publish` unless the user explicitly asks.
5. After a usable design contract exists, continue with **impeccable** for
   craft, hierarchy, a11y, and anti-AI-slop checks.

## Manual CLI

Dembrandt's pinned raw CLI remains available for an explicit operator-run
workflow:

```bash
npx -y dembrandt@0.25.1 https://example.com --design-md
```

This manual command is not the MCP security boundary. Version 0.25.1 can follow
redirects and subresources without a per-request interception hook. Never claim
that a DNS/URL preflight makes the raw CLI safe for autonomous use.

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

```
nexus_design_system_local_list          # no key, no network required
  source?: "local-catalog" | "getdesign"   — default local-catalog

nexus_design_system_local_import        # no key; proposes a ContextDraft
  kitId: string (required) — an id from the list above
  source?: "local-catalog" | "getdesign"   — default local-catalog
  targetPath?: string — default .context/docs/design-system.md
  missionId?: string
  force?: boolean — required to propose over an existing contract
```

## Hard rules

- **Do not** copy third-party logos, wordmarks, or trademarks into the product.
  Adapt measured tokens (palette, type scale, spacing, radius, motion) to the
  project identity.
- **Do not** extract private-network / localhost URLs through this tool; those
  are blocked by policy.
- **Do not** bypass `NETWORK_GUARD_UNAVAILABLE` with a preflight or by silently
  launching the raw CLI from an autonomous mission.
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
