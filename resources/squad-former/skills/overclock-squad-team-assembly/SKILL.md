---
name: overclock-squad-team-assembly
description: Use when you have a squad_spec and catalog candidates — maps them into a complete SquadPreset JSON ready for install and persist.
---

# SF Team Assembly

You take a `squad_spec` (from the orchestrator’s SDD design phase (Step 2)) and `candidates` (from scout panes via `handoff_list`) and produce a complete `SquadPreset` JSON. This is the squad the user will see in the Overclock UI.

## SquadPreset Shape (canonical)

```typescript
interface SquadPreset {
  id: string;                        // "<goal-slug>-<YYYY-MM-DD>"
  name: string;                      // Human name, e.g. "Research Squad"
  agents: AgentSlot[];
  createdAt: number;                 // Unix ms — Date.now()
  orchestratorInstructions: string;  // System prompt addendum for the squad's orchestrator pane
  imageProvider?: string;            // 'openai-image' (gpt-image) | 'google-image' (nano-banana),
                                     // both via overclock_image_generate (API key in Settings).
                                     // SET when the squad GENERATES images. Omit otherwise.
  videoProvider?: string;            // 'seedance' — set only when the squad generates video. Omit otherwise.
  audioProvider?: string;            // 'elevenlabs' — set only when the squad generates speech/voiceover. Omit otherwise.
}

interface AgentSlot {
  id: string;        // kebab-case role id, e.g. "orchestrator", "researcher-1", "synthesizer"
  agentName: string; // "overclock-orchestrator" for pilot; catalog agent base name for workers
  category: string;  // "orchestrator" | "scout" | "executor" | "reviewer"
  cli: string;       // an ENABLED CLI on this machine — never assume claude
  model: string;     // proposed from that CLI's provider model list (pane_list_providers) — never invented
  effort: string;    // "high" | "medium" | "low"
  allowedSkills?: string[]; // skills bound to THIS member — omit when none
}
```

## Role Mapping

`overclock-orchestrator` is the **only canonical `agentName`**. Worker slots reference catalog agent base names — installed agents resolve immediately; marketplace candidates (`installed: false`) resolve after `overclock-squad-marketplace-install` runs `overclock_catalog_install` for them.

| Functional role | `agentName` | `effort` | Count |
|----------------|-------------|----------|-------|
| Orchestrator | `overclock-orchestrator` (always) | `high` | 1 |
| Scout / lookup | catalog agent, e.g. `search-specialist` | `low` | 1–3 |
| Executor / builder | catalog agent, e.g. `code-reviewer` | `medium` | 0–2 |
| Reviewer / verifier | catalog agent, e.g. `research-synthesizer` | `medium` | 0–1 |

**CLI/model rule (MANDATORY):** discover what this machine actually runs before composing —
call `mcp__overclock__pane_list_providers` and use only ENABLED CLIs. Default every member's
`cli` to the CLI YOU are running on (the user chose it by launching you there); offer the
other enabled CLIs as alternatives at the preview gate. NEVER hardcode claude.
`model`: PROPOSE one per member from that CLI's provider model list (the same tool returns
them) — stronger model for the orchestrator, mid/cheap for workers. Never invent a name.

**Skill binding (MANDATORY):** every chosen skill goes into the `allowedSkills` of the
SPECIFIC member(s) that will use it — designer skills on the designer, QA skills on the
reviewer. NEVER present or save skills as a flat squad-level list. A member with bound
skills can load ONLY those; a member with none bound is unrestricted.

**Skill × CLI compatibility:** `overclock_skill_list` returns each skill's `clis` (where it
is installed). Binding a skill to a member of a DIFFERENT CLI is allowed — the Overclock
runtime mirrors the skill into that CLI's skill dir automatically at spawn. When that
happens, SAY SO at the preview gate (e.g. "frontend-design (claude → mirrored to codex)")
so the user knows the cross-CLI mapping.

Always include exactly 1 orchestrator. Workers are populated from `candidates.agents`, picking the best match per functional role by `suggested_role` and `relevance_score`.

## Assembly Rules

1. For each role in `squad_spec.roles_needed`, pick the best matching agent from `candidates.agents` by `suggested_role` and `relevance_score`. Prefer `installed: true` candidates on ties.
2. **Bind skills per member via `allowedSkills`** — for each member (orchestrator included), set `allowedSkills` to the skill names from `candidates.skills` that this role effectively needs. A populated list is a hard gate at runtime: the member can load ONLY those skills. Member with no skill bound: **omit the field entirely** (omitted/empty = unrestricted). Never list skills as prose in `orchestratorInstructions`.
3. Generate `id` as `<goal-slug>-<YYYY-MM-DD>`.
4. Populate `orchestratorInstructions` from the **`orchestrator_playbook`** produced in the
   design phase (Step 2): take that role-abstract playbook and FINALIZE it — swap each
   abstract role for the chosen `agentName` + bound skills, keep goal/method/step-order/
   gates/topology. The template below is the fallback shape when no playbook was drafted.
5. Build the install manifest from candidates with `installed: false` ONLY — installed candidates need no install step. Use their `slug` from the marketplace search.
6. **Media resources → render members + preset providers.** Each capability the user turned ON in
   `squad_spec.media` becomes BOTH a preset provider field AND a **render member (AgentSlot) in the
   roster** — a real, visible worker, not just a flag. Add one member per enabled resource:
   - `media.image` → `imageProvider` + member `id: "render-image"`, `category: "executor"`
   - `media.video` → `videoProvider` + member `id: "render-video"`, `category: "executor"`
   - `media.audio` → `audioProvider` + member `id: "render-audio"`, `category: "executor"`
   A render member's `cli` is forced by the provider (natives below); keyed providers can run on any
   enabled CLI. Name them in `orchestratorInstructions` (e.g. "render-image: gera os PNGs via …").
   If one agent naturally does both its role and the render (small squads), you MAY fold the render
   duty into an existing member instead of a separate slot — but the provider field is ALWAYS set.

   Provider map: `media.image` → `imageProvider` (`openai-image` for gpt-image, `google-image` for
   nano-banana); `media.video` → `videoProvider` (`seedance`); `media.audio` → `audioProvider`
   (`elevenlabs`).
   For `openai-image`/`google-image`/`seedance`/`elevenlabs`: the formed squad's
   `overclock_image_generate` / `overclock_video_generate` / `overclock_audio_generate` inherits
   the provider and the API key lives in Settings → API Keys — `orchestratorInstructions` MUST tell
   the render agent to call the matching tool (one call per slot, `outPath`), mirroring Absurd Landing.
   The render agent uses ONLY the provider/model the user enabled in Settings; on quota/rate-limit it
   retries the SAME provider (max 2) then surfaces the gap — it never switches engines silently.
   Omit any media provider the squad doesn't use.

## orchestratorInstructions Template

```
You are orchestrating the <squad name> squad.

Goal: <squad_spec.goal>
Domain: <squad_spec.domain>
Deliverable: <squad_spec.deliverable>

## Team
- orchestrator (you): overclock-orchestrator
- <id>: <agentName> — <what it does>
[repeat per worker]

## Workflow
1. [Concrete step 1]
2. [Concrete step 2]
...

## Constraints
<from squad_spec.constraints>
Gated: <true|false>
```

Skills are NOT enumerated here — the binding lives in each member's `allowedSkills` and the runtime injects what each member may load.

## Output Format

Concrete example — a research squad with per-member skill binding:

```json
{
  "preset": {
    "id": "deep-research-squad-2026-06-08",
    "name": "Deep Research Squad",
    "agents": [
      {
        "id": "orchestrator",
        "agentName": "overclock-orchestrator",
        "category": "orchestrator",
        "cli": "<an enabled CLI — e.g. the one you run on>",
        "effort": "high",
        "allowedSkills": ["dispatching-parallel-agents"]
      },
      {
        "id": "researcher-1",
        "agentName": "search-specialist",
        "category": "scout",
        "cli": "<an enabled CLI>",
        "effort": "low",
        "allowedSkills": ["deep-research"]
      },
      {
        "id": "synthesizer",
        "agentName": "research-synthesizer",
        "category": "executor",
        "cli": "<an enabled CLI>",
        "effort": "medium"
      }
    ],
    "createdAt": 1749340800000,
    "orchestratorInstructions": "You are orchestrating the Deep Research Squad.\n\nGoal: Produce a cited research report on a given topic.\nDomain: Open web research\nDeliverable: Structured Markdown report with sources\n\n## Team\n- orchestrator (you): overclock-orchestrator\n- researcher-1: search-specialist — parallel web search across sources\n- synthesizer: research-synthesizer — merges findings into final report\n\n## Workflow\n1. Dispatch researcher-1 in parallel across topic slices.\n2. Collect findings via handoff_list.\n3. Delegate synthesis to synthesizer.\n4. Return report to user.\n\n## Constraints\nGated: true"
  },
  "skills_to_install": [
    { "kind": "skill", "slug": "ai-research/deep-research" }
  ],
  "agents_to_install": [
    { "kind": "agent", "slug": "deep-research-team/research-synthesizer" }
  ]
}
```

> In this example `search-specialist` and `dispatching-parallel-agents` were `installed: true` (no install entry); `research-synthesizer` and `deep-research` came from the marketplace (`installed: false`) and therefore appear in the manifest. `synthesizer` has no skill bound, so `allowedSkills` is omitted — it stays unrestricted.

`skills_to_install` and `agents_to_install` form the install manifest consumed by `overclock-squad-marketplace-install`.

## Quality Check Before Emitting

- [ ] Exactly 1 orchestrator with `agentName: "overclock-orchestrator"`?
- [ ] No worker uses `"overclock-scout"`, `"overclock-executor"`, or `"overclock-reviewer"` — those don't exist?
- [ ] All worker `agentName` values are real catalog agent names from `candidates.agents`?
- [ ] `allowedSkills` per member contains only skill names from `candidates.skills` bound to that role — and the field is OMITTED (not `[]`) for members with no skill?
- [ ] `orchestratorInstructions` names every agent by `id` and does NOT enumerate skills as prose?
- [ ] Install manifest contains ONLY `installed: false` candidates?
- [ ] `id` is globally unique (includes date)?
- [ ] `createdAt` is a number (Unix ms, `Date.now()`) — not an ISO string?
