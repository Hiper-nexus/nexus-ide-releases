# Production confidence checklist — packaged smoke + multi-window

**Date:** 2026-07-13  
**Goal:** Highest-ROI path to call the product wave **dogfood-ready with release evidence**, without claiming production-ready until these pass.

## What is already automated

| Gate | Command / location | Covers |
|------|--------------------|--------|
| Unit intent + product security | `vitest` targeted suites | gates, budgets, Navalha arm, symlink FS |
| Multi-workspace isolation | `src/main/orch/multi-workspace-isolation.test.ts` | SearchMixer per root, pane recovery scope |
| Packaged functional smoke | `npm run smoke:package` → `scripts/smoke-packaged-app.mjs` | Boot + IPC + MCP + **intent-arm** + **product-flags** + **search-mixer** |

### Functional smoke probes (packaged `.app`)

Closed set in `src/shared/smoke-types.ts`. New probes (2026-07-13):

1. `intent-first-settings` — `orchGet.intentFirstMissionRuntimeV1 !== false`
2. `intent-arm` — `armMission` → `awaiting_goal`, no `orchestratorSessionId`, 0 mission panes, status not `running`
3. `product-flags` — `product.flagsList` exposes known flags with `definition.killSwitch`
4. `search-mixer-ipc` — `product.searchQuery` returns bounded envelope

Existing probes still required: workspace, adapters, settings, MCP loopback, write-guard, etc.

## Manual / CI package smoke (binário)

Run after `npm run package` (or `postpackage` already invokes smoke):

```bash
npm run package
# or explicit:
node scripts/smoke-packaged-app.mjs --app out/NexusIDE-darwin-arm64/NexusIDE.app
```

**Pass criteria:** process exit 0, log contains `functional-ready`, no `functional-failed`.

## Multi-window manual (until Playwright exists)

No Playwright in tree. Until E2E harness lands, run **binary** checks:

| # | Check | Pass |
|---|--------|------|
| M1 | Open workspace A in window 1, workspace B in window 2 | Both usable |
| M2 | Search in A while B searches | No cross-cancel; results stay scoped |
| M3 | Arm Navalha/squad in A only | A shows awaiting_goal; B missions list unchanged for that mission id |
| M4 | Kill switch / override off `feature.search.mixer` | Search IPC fails closed or empty; no crash |
| M5 | Packaged smoke still green after flag force-on dogfood | exit 0 |

## Explicitly not production blockers (product backlog)

- CodeMirror 6 install (flag delivers secure non-CM path)
- MCP Hub real OAuth/SSE transports
- Autonomy profiles wired into effect gate
- Agent lifecycle reap killing real sessions/panes

## Rollback

- Feature kill switches / overrides
- `intentFirstMissionRuntimeV1: false` restores legacy kickoff only (not recommended for dogfood)

## Next automation upgrade

1. Wire Playwright (or Spectron successor) for M1–M4 against packaged binary.  
2. Promote this checklist into CI job `smoke:package` on release tags.  
3. Keep multi-workspace unit tests as merge gate regardless of E2E.
