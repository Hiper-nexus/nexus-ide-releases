---
name: bridgememory
description: Read and write durable, cross-conversation context in the user's BridgeMemory hub via the bridgememory-mcp tools. Use when the user asks you to remember something, when you make a decision worth keeping, or before starting work in an unfamiliar repo.
---

# BridgeMemory

You have access to a **BridgeMemory hub** — a folder of connected markdown notes the user maintains in BridgeSpace. Each note is a `.md` file in `.bridgememory/`, connected to others via `[[Wikilink]]` syntax.

The user opens these notes in the BridgeSpace UI. Anything you write here, they can read, edit, and visualize as a graph.

## Tools

All tools are exposed by the `bridgememory-mcp` server. They auto-discover the hub by walking up from the working directory.

| Tool | When to use |
|---|---|
| `hub_status` | First call when you're unsure if BridgeMemory is set up here. Cheap. |
| `list_memories` | Discover what's already remembered. Always call before deciding to create something — the user may already have a note on the topic. |
| `read_memory` | Pull the full body of a memory by title, filename, or absolute path. |
| `search_memories` | Substring search across titles + bodies when you don't know the exact title. |
| `find_backlinks` | Before deleting/renaming a memory, see who points at it. |
| `create_memory` | Write a NEW durable note. See "When to write" below — be selective. |
| `append_to_memory` | Add a paragraph to an existing memory. Preferred over `update_memory` for incremental edits. |
| `update_memory` | Replace a body wholesale. Use rarely — `append_to_memory` is safer. |
| `suggest_connections` | After writing, find existing notes that share keywords and might be worth linking. |
| `list_orphans` | Audit notes with no incoming or outgoing links — candidates for cleanup or new wikilinks. |
| `init_hub` | Create `.bridgememory/` in a directory. Only when the user explicitly asks. |
| `delete_memory` | Permanent. Only when the user explicitly asks to forget. |

## When to write a memory

Write a memory when the fact is **durable across conversations** and **non-obvious from reading the code**:

- Decisions and the reason behind them ("we chose russh over thrussh because of CVE-2025-54804")
- Project state and ongoing initiatives ("auth middleware rewrite is driven by legal/compliance, not tech debt")
- Cross-system references ("pipeline bugs are tracked in Linear project INGEST")
- Hard-won fix recipes that aren't captured in commits
- User preferences for how to approach work in this repo

**Do NOT** write memories for:

- Information already in code, README, or `git log`
- Ephemeral task state ("currently fixing the login bug")
- Summaries of the current conversation
- Generic best practices

If unsure: would this be useful to a *future* you starting a fresh conversation in two weeks? If no, skip it.

## How to write a memory

1. **Search first.** Call `search_memories` (or `list_memories`) before creating. The user may already have a note on this topic — append to it instead of duplicating.
2. **Pick a stable title.** Title becomes the H1 *and* the filename slug, and other notes will `[[link]]` to it. "Auth Architecture" is good; "Notes from Tuesday" is bad.
3. **Self-contained body.** A reader two months from now should understand it without conversation context. State the fact, then a `**Why:**` line, then a `**How to apply:**` line for guidance-style notes.
4. **Add wikilinks.** Use `[[Other Title]]` when referencing a concept that probably has (or should have) its own memory. Use `[[Other Title|alias text]]` when the natural sentence wants different wording.
5. **Suggest connections after.** Call `suggest_connections` on the memory you just wrote. Add wikilinks for any high-score suggestions that genuinely belong.

## Hub discovery

The MCP server discovers the hub by walking up from `cwd` looking for `.bridgememory/`. Pass `cwd: <absolute-path>` to any tool to override. The `.bridgememory` marker may be a normal directory or an in-root directory link/junction, such as `.bridgememory -> BridgeMemory`; links resolving outside the hub root are intentionally ignored.

If `hub_status` returns `hub: null`, ask the user before calling `init_hub` — never create a hub silently.

## Examples

**User:** "Remember that we always use russh 0.46 because of CVE-2025-54804."

```
list_memories                                    # check for an existing pinned-deps or security note
→ no match
create_memory(
  title: "russh 0.46 pin",
  body: "# russh 0.46 pin\n\nbridgespace-tauri is pinned at russh 0.46.0.\n\n**Why:** CVE-2025-54804. Upgrade is a tracked refresh, not a drive-by bump.\n\n**How to apply:** Block PRs that bump the russh major/minor without a linked refresh ticket. See [[SSH Architecture]].\n"
)
```

**User:** "What did we decide about auth?"

```
search_memories(query: "auth")
→ hit: "Auth Architecture"
read_memory(identifier: "Auth Architecture")
→ return the body
```

**User:** "Forget the russh note."

```
find_backlinks(target: "russh 0.46 pin")        # warn user if anything links to it
delete_memory(identifier: "russh 0.46 pin")
```
