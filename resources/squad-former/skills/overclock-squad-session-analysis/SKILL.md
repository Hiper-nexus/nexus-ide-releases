---
name: overclock-squad-session-analysis
description: Use at Squad Former startup — reads recent CLI transcripts and git context to infer what the user has been building, giving the orchestrator pre-loaded context before elicitation begins.
---

# SF Session Analysis

You build a `session_context` brief from the user's recent activity. This brief pre-populates squad elicitation so the orchestrator doesn't ask for what can already be inferred.

## Inputs to Read (in priority order)

### 1. Claude Code transcripts (`~/.claude/projects/`)

```bash
# Most recently active project transcripts
ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -5
```

Skim the tail of the 2–3 most recent files. Extract:
- Project names and directories the user worked in
- Technologies/frameworks mentioned
- Tasks completed or in-progress
- Any squad or agent usage

If the directory doesn't exist, skip to step 2.

### 2. Overclock pane transcripts (`~/.overclock/sessions/` or `.overclock-app/`)

Look for recent `.json` or `.jsonl` transcript files. Read the last 2–3 files. Extract:
- What the user asked for
- What was built or deployed
- Any tool calls that reveal stack (Supabase, GitHub, Docker, etc.)

### 3. Current git context (working directory)

```bash
git -C "$PWD" log --oneline -10 2>/dev/null
git -C "$PWD" diff --stat HEAD 2>/dev/null
```

Infer active project and recent work from commit messages.

## Output Format

Return a structured `session_context` object — do not emit raw logs.

```json
{
  "session_context": {
    "active_projects": [
      {
        "name": "project-name",
        "path": "/path/to/project",
        "tech_stack": ["Next.js", "Supabase", "TypeScript"],
        "last_activity": "2026-06-08",
        "description": "One-line description of what user is building here"
      }
    ],
    "recent_tasks": [
      "Deployed the marketing site to staging",
      "Fixed a date-parsing bug in the orders API"
    ],
    "inferred_patterns": [
      "User prefers Docker over managed infra",
      "Uses Postgres for persistence"
    ],
    "tools_in_use": ["Bash", "WebFetch", "mcp__github"],
    "likely_next_need": "Free-form guess at what squad they might want based on trajectory"
  },
  "confidence": 0.75,
  "sources_read": ["~/.claude/projects transcripts", "git log"],
  "gaps": ["No transcript files found — context from git only"]
}
```

## Behavior Rules

- **Never block** — if transcripts are unavailable, proceed with git context and mark `sources_read` accordingly.
- **Filter before read** — Bash does the heavy lifting OUTSIDE your context: `ls -t` to rank by
  recency, `grep -l <keywords>` to find WHICH files matter, `tail` to skim only the end. Never
  cat whole transcripts into your context.
- **Slicing rule (large histories)** — after filtering, count what's left:
  - **≤ 10 relevant files** → handle it yourself (grep + tail, summarize).
  - **> 10 relevant files** → do NOT grind through them. Return early via handoff_submit with
    `{ "too_broad": true, "total_files": N, "slices": [ ["fileA","fileB",...], ... ] }` splitting
    the list into batches of ~10 — the orchestrator invokes one researcher per slice in parallel
    and merges the summaries.
- **Compress ruthlessly** — emit summaries, not raw log lines. The orchestrator needs a brief, not a dump.
- **Infer, don't fabricate** — mark uncertain inferences with a `?` suffix in `inferred_patterns`.
- **Size limit** — `session_context` must fit in ~500 tokens. Cut the oldest data if needed.
- If you find evidence the user recently ran another Squad Former session, note `"likely_next_need": "refine prior squad: <name>"`.

## Downstream Use

This output is passed to the orchestrator’s SDD design phase (Step 2) so the orchestrator can say "I see you've been working on X — is this squad for that?" instead of starting cold.
