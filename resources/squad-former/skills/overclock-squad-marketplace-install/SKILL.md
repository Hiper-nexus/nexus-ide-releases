---
name: overclock-squad-marketplace-install
description: Use when you have a completed SquadPreset and an install manifest — installs each marketplace component (source aitmpl) via overclock_catalog_install, then persists the squad via overclock_squad_save.
---

# SF Marketplace Install

You execute the install manifest produced by `overclock-squad-team-assembly`: one `overclock_catalog_install` call per component, then one `overclock_squad_save` call to persist the full preset.

## Install Manifest Shape

Receive from `overclock-squad-team-assembly`:

```json
{
  "preset": { /* full SquadPreset with allowedSkills per member — see overclock-squad-team-assembly */ },
  "skills_to_install": [
    { "kind": "skill", "slug": "ai-research/deep-research" }
  ],
  "agents_to_install": [
    { "kind": "agent", "slug": "deep-research-team/research-synthesizer" }
  ]
}
```

The manifest contains **only marketplace candidates** (`installed: false` in the `overclock-squad-catalog-search` shortlist). Candidates already installed (`installed: true`) never appear here — they need no install step. If a manifest entry references something already on disk, the tool skips it (`skipped: true`).

## Install Procedure

### Step 1 — Install each component

Call `mcp__overclock__overclock_catalog_install` for each item in `skills_to_install` and `agents_to_install`:

```
mcp__overclock__overclock_catalog_install({
  kind: "skill",            // or "agent"
  slug: "<category/name>",  // marketplace slug, e.g. "ai-research/deep-research"
  source: "aitmpl"
})
```

**Handling responses:**
- `{ ok: true, installed: { name, path } }` → log success, continue
- `{ ok: true, skipped: true }` → already installed, skip silently
- `{ ok: false, error: "..." }` → log the error, continue with remaining installs (don't abort the whole batch)

**Order:** Install skills before agents. Skills have no inter-dependencies; install in any order.

### Step 2 — Persist the squad

After all component installs complete (even with partial failures), call:

```
mcp__overclock__overclock_squad_save(preset)
```

Where `preset` is the full `SquadPreset` object from `overclock-squad-team-assembly` — **including each member's `allowedSkills`**. Do not strip or rewrite the field: a populated list is the runtime hard gate for that member; an omitted field means unrestricted. The saved preset is the single source of truth for skill binding.

**Response:**
- `{ ok: true }` → squad is now live in the Overclock UI
- `{ ok: false, error: "..." }` → report error to orchestrator; do NOT retry automatically

### Step 3 — Emit install report

Return a structured summary to the orchestrator:

```json
{
  "install_report": {
    "installed": [
      { "kind": "skill", "slug": "ai-research/deep-research", "path": "~/.claude/skills/deep-research/SKILL.md" }
    ],
    "skipped": [],
    "failed": [],
    "squad_saved": true,
    "squad_id": "deep-research-squad-2026-06-08",
    "squad_name": "Deep Research Squad",
    "allowed_skills_bound": {
      "orchestrator": ["dispatching-parallel-agents"],
      "researcher-1": ["deep-research"]
    }
  }
}
```

`allowed_skills_bound` mirrors the `allowedSkills` per member as persisted — members without the field are omitted.

## Safety Rules

- **Never overwrite** — `skip-if-exists` is enforced by the MCP tool (`skipped: true`). Do not pass a flag to force overwrite.
- **Only install manifest slugs** — do not accept arbitrary slugs not present in the install manifest. The manifest was validated by `overclock-squad-team-assembly` and contains only `installed: false` marketplace candidates.
- **Do not write directly to `~/.claude/`** — all writes go through `overclock_catalog_install`. Never use Bash `cp`, `echo`, or `Write` to place files in the user's `.claude` directory.
- **Preserve `allowedSkills`** — pass the preset to `overclock_squad_save` exactly as assembled. Never add skills a member wasn't bound to, never drop a member's list.
- **Partial success is acceptable** — a failed skill install should not block squad persistence. Report failures and continue. But if a member's bound skill failed to install, flag it in the report so the orchestrator can warn the user.

## Downstream

After `overclock_squad_save` returns `{ ok: true }`, the squad is immediately visible in the Overclock UI. Report back to the orchestrator with the install report so it can surface a clean summary to the user.
