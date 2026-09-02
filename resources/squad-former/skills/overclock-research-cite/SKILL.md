---
name: overclock-research-cite
description: "Use when a research worker must emit a sourced handoff — enforces mandatory [TITLE](URL) inline citations inside `answer` and a non-empty sources[] artifact field. Bound to the search-specialist role. Triggers: research with citations, sourced research, cite sources, inline citations, sources[] artifact."
---

# overclock-research-cite — Inline-Citation Contract

You are producing a **sourced research handoff**. Every factual claim must be backed by an inline citation and declared in `sources[]`.

## Citation format (mandatory)

Inline citations use this exact format, embedded inside the prose where the claim appears:

```
[TITLE](URL)
```

**Right:**
```
Overclock uses a handoff-driven orchestration model [Overclock Architecture](https://overclock.sh/docs/architecture) 
that eliminates polling between workers.
```

**Wrong — no inline citation:**
```
Overclock uses a handoff-driven orchestration model. This eliminates polling.
(Sources: ...)
```

**Wrong — citation at end instead of inline:**
```
Overclock eliminates polling between workers.¹

¹ Overclock Architecture — https://overclock.sh/docs/architecture
```

Every sentence making a factual claim that is not common knowledge must contain at least one inline `[TITLE](URL)` citation.

## sources[] artifact field

Your handoff `artifacts.sources` **must be non-empty**. Each entry:

```json
{ "title": "Human-readable title", "url": "https://..." }
```

Every inline citation in `answer` must have a matching entry in `sources[]`. Extra entries are allowed (background material); missing entries are not.

**Right:**
```json
{
  "answer": "Overclock caps swarm width at spawn time [Overclock Width Cap](https://overclock.sh/docs/width-cap).",
  "sources": [
    { "title": "Overclock Width Cap", "url": "https://overclock.sh/docs/width-cap" }
  ]
}
```

**Wrong — empty sources:**
```json
{
  "answer": "Overclock caps swarm width at spawn time.",
  "sources": []
}
```

**Wrong — sources omitted:**
```json
{
  "answer": "Overclock caps swarm width at spawn time."
}
```

## Language matching

Write `answer` in the same language as the research question. If the question is in pt-BR, write in pt-BR (including citation prose); URLs remain as-is.

## Handoff

When research is complete, call:

```
mcp__overclock__handoff_submit({
  summary: "<one-sentence answer>",
  status: "done",
  artifacts: {
    answer: "<full prose with inline citations>",
    sources: [
      { "title": "...", "url": "..." },
      ...
    ]
  }
})
```

The orchestrator validates `artifacts` against the RESEARCH_CITE_SCHEMA. An empty `sources[]` or a missing `sources` key causes a schema validation failure and a re-prompt — save yourself the round-trip by citing correctly the first time.

## Failure mode

If you cannot find **any** credible source for a claim, do not fabricate one. Either:
- Remove the unsourced claim from `answer`, or
- Submit `status: "blocked"` with `summary` explaining what you could not verify.

Never invent a title or URL.
