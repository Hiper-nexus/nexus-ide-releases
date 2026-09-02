---
name: overclock-squad-catalog-search
description: Use when you have a squad_spec and need to find matching agents and skills — searches the installed Overclock catalog first (overclock_agent_list / overclock_skill_list), then the Overclock marketplace (overclock_marketplace_search) only for capability gaps, returns a shortlist with installed flags.
---

# SF Catalog Search

You find the best-matching agents and skills for a given `squad_spec` using **exclusively the two Overclock sources**, in this order:

1. **Installed catalog** — what the user already has in `~/.claude` (zero network). Tools: `mcp__overclock__overclock_agent_list` and `mcp__overclock__overclock_skill_list`.
2. **Overclock marketplace** — ONLY for capabilities that nothing installed covers. Tool: `mcp__overclock__overclock_marketplace_search`.

Never query GitHub, raw.githubusercontent.com, or any external catalog API directly. All external access goes through the curated Overclock marketplace.

## Search Strategy (2 phases)

### Phase 1 — Installed Catalog (always, zero network)

1. Call `mcp__overclock__overclock_agent_list({})` → installed agents with `name`, `cli`, `description`.
2. Call `mcp__overclock__overclock_skill_list({})` → installed skills with `name`, `description`.
3. Match each item's name + description against `squad_spec.goal` keywords, `squad_spec.domain`, `squad_spec.tags`, and `squad_spec.roles_needed`. Score with the table below.
4. Every match from this phase is marked `"installed": true`.

Prefer installed items whenever they cover a capability — they're what the user curated, they need no install step, and they're the same inventory the SquadModal picker shows.

### Phase 2 — Marketplace Gap Fill (only for uncovered capabilities)

For each capability in `squad_spec` that **no installed agent or skill covers** (no Phase 1 candidate with score ≥ 0.5 for that role/capability):

1. Call `mcp__overclock__overclock_marketplace_search({ q: "<capability keywords>", kind: "agent" | "skill" })`.
2. Results carry `slug`, `kind`, `category`, `name`, `description`, `tags`, `downloads`. Score them with the same table.
3. Every match from this phase is marked `"installed": false` and keeps its `slug` — `overclock-squad-marketplace-install` needs it to install.

Run one focused query per gap. Do not re-search capabilities Phase 1 already covered.

## Scoring

| Factor | Weight |
|--------|--------|
| Goal keyword match | 0.4 |
| Domain/tech match | 0.3 |
| Role match (orchestrator/scout/executor/reviewer) | 0.2 |
| Model tier fit (haiku/sonnet/opus) | 0.1 |

Return candidates with score ≥ 0.5. When an installed candidate and a marketplace candidate tie for the same capability, keep the installed one.

## Output Format

Every candidate carries `installed: true | false`. Marketplace candidates also carry `slug` (install handle).

```json
{
  "candidates": {
    "agents": [
      {
        "name": "search-specialist",
        "description": "One-line description from the catalog",
        "relevance_score": 0.82,
        "suggested_role": "scout",
        "installed": true
      },
      {
        "name": "research-synthesizer",
        "slug": "deep-research-team/research-synthesizer",
        "category": "deep-research-team",
        "description": "One-line description from the marketplace",
        "relevance_score": 0.74,
        "suggested_role": "executor",
        "installed": false
      }
    ],
    "skills": [
      {
        "name": "dispatching-parallel-agents",
        "description": "One-line description",
        "relevance_score": 0.76,
        "suggested_role": "orchestrator-skill",
        "installed": true
      }
    ]
  },
  "sources_used": ["installed", "marketplace"],
  "uncovered_capabilities": [],
  "low_confidence_reason": null
}
```

- `sources_used`: `["installed"]` when Phase 1 covered everything (best case — squad assembles with zero installs); add `"marketplace"` only when Phase 2 ran.
- `uncovered_capabilities`: capabilities neither source could fill — the orchestrator decides how to degrade.

## Failure Handling

- `overclock_marketplace_search` returns `{ ok: false }` (offline, endpoint error) → return Phase 1 candidates only, set `"low_confidence_reason": "marketplace unavailable"` and list the gaps in `uncovered_capabilities`.
- Empty installed catalog → go straight to Phase 2 for every capability.

## Handoff

When done, call `mcp__overclock__handoff_submit({ summary: "...", status: "done", artifacts: <candidates JSON> })`. The Squad Former orchestrator collects this via `handoff_list` and proceeds to squad assembly.
