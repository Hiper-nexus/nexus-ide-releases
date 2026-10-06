# Routing cost policy implementation plan

> **For agentic workers:** use the authorized shared checkout and focused Node 22 checks; coordinator owns commits, typecheck scheduling and release metadata.

**Goal:** route ordinary implementation to an eligible economic model, retain frontier judgment and proven-finding correction, and prevent automatic Astra selection. UI choices remain configurable pending the operator's answer; no new global UI whitelist.

**Design:** a small pure routing-policy helper derives implementation/review intent from the existing task and accepts Main-owned reviewed-finding evidence. Apply the economic preference to the already validated same-tier candidates, after existing scoring; retain measured specialty ordering, real quality scoring within the economic same-tier pool, outcome evidence, circuits, explicit model choices and UI lanes. Keep Astra eligible when explicitly requested; suppress its entire model line from automatic general/judge lanes, evaluated candidates and implicit fallback. Preserve the existing operator-authorized visual lane and explicit model requests.

**Scope:** `task-router.ts`, a co-located `routing-cost-policy.ts` helper, `tools-domain.ts` for actual Main-owned verdict-ledger wiring and focused tests. New fields belong only to `RouteContext`, never MCP input arguments. No changes to seals, permissions, memory, watchdog, graph UI, metadata or native-heavy work.

1. Write route regressions from the CLI update, Kimi fix, graph UI and independent review requests; observe failures before implementation.
2. Implement bounded cost-purpose policy with no invented capability or performance scores; preserve existing quality/outcome evidence and same-tier effort.
3. Enforce Astra automatic exclusion by model line, including catalog-only candidates and fallback; preserve explicit requests and the existing visual policy.
4. Run affected routing suites with `/opt/homebrew/opt/node@22/bin/node node_modules/vitest/vitest.mjs run …`; inspect regressions and diff. Coordinator schedules final typecheck and independent review.

**Limits:** fixtures prove routing behavior, not model quality. Verified-finding escalation requires Main-owned evidence; a task merely naming a finding is not evidence. No duplicate visual-routing API/settings is introduced. Proof requires a frontier rejection at the current clean HEAD identifying the exact finding id/path; a dirty reviewed tree or current tree cannot prove an unchanged diff. Only candidate correction tasks perform the async git read.
