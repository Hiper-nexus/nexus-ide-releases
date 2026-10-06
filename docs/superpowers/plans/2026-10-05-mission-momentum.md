# Mission momentum implementation plan

**Approved scope:** The operator requested the orchestration upgrade in the same release: ready work must not wait behind idle helpers, handoffs, spawn failures or a long local gate.

**Design:** Extend the existing Main supervisor's 15-second reconciliation. A mechanical readiness projection uses only registered current tasks, declared dependency completion, dispatch states and the actual worker slot budget. After 30 seconds with ready backlog and a vacant slot, send one visible supervisor handoff instructing the Maestro to fill authorized slots. The supervisor never invents tasks or spawns a pane itself. Unknown authority, read-only leader, zero slots or unproven dependency means no directive.

**Limits:** Preserve approved dispatch/intent authority, execution workspace, sealed tasks/roster, freeAgentChoice and native subagent policy. Step/token counters remain ledgers under the existing policy. No new Jev/Clef judgment: semantics stay with those classifiers, vacancy arithmetic stays in Main. Expensive local validation commands remain sequential. Ordinary reminders stay at most hourly; a changed registered backlog after real completion/requeue can refresh at most once a minute. Persisted supervisor receipts prevent restart spam.

- [x] Write failing watchdog/readiness tests, including idle helpers, dependency barriers and invalid metadata.
- [x] Add readiness and short vacancy settlement to the existing watchdog.
- [x] Integrate trusted current task/dispatch snapshots into the supervisor loop, with durable reminder cooldowns.
- [x] Exercise the actual supervisor with real registered tasks, idle worker panes and restart/repeated scans.
- [x] Run focused Node 22 watchdog/supervisor tests; no full suite, typecheck, commit or deployment in this task.

Validation: Node 22.23.2 ran seven focused suites with 123 tests passing; diff check passed. The urgent Main freeze was independently fixed as F-953 (output-reader leading-LF loop), with its own off-thread red/green reproduction and peer review. This momentum change only emits advisory directives; the consolidated typecheck/build/release remains with the coordinator.
