---
name: nexus-goal-governor
description: "Autonomous multi-wave execution engine for Nexus IDE terminal grid panes. Use when planning, executing, or managing multi-stage tasks or waves across terminal panes overnight without stalling or losing progress."
---

# Nexus Goal Governor & Autonomous Wave Engine

The **Goal Governor** is a built-in supervisor in the Electron Main process that ensures multi-wave roadmap execution in loose terminal panes runs autonomously to completion (e.g. overnight), transitioning wave by wave.

## Problem Solved

When orchestrating work in terminal panes (e.g., an orchestrator pane running Codex/Claude coordinating worker panes):
- Standard CLI agents finish a turn and go idle waiting for operator input.
- Without a governor, execution halts after Wave 1 (e.g., Onda 4 finishes, but nobody triggers Onda 5 or 6).
- Unmonitored machines may sleep during the night, suspending processes.

The Goal Governor solves this by:
1. Maintaining a durable state machine, persisted to disk. The goal moves `pending` -> `running` -> `evaluating_gate` -> `wave_transition` -> `completed`, and can also be `paused` or `blocked`; each wave is `pending`, `running`, `passed`, `failed` or `skipped`.
2. Keeping the machine awake during active waves (`preventSleep: true`).
3. Running verification gates (e.g. `npm test`, `npm run typecheck`) between waves.
4. Nudging the orchestrator terminal PTY with the instructions and tasks for the next wave once the current wave passes.
5. Halting safely via a Circuit Breaker if a gate fails 3 times consecutively (the default; preventing token burn): the goal becomes `blocked` with a `blockReason` until the operator resumes it or retries the gate.

---

## MCP Tools Reference

### 1. Register a Goal: `nexus_goal_register`

```json
{
  "title": "Overnight Production Migration",
  "waves": [
    {
      "name": "Onda 4: Integrador e Produção",
      "instructions": "Spawn Codex worker for RU-186 and RU-209. Verify SES integration and production smoke.",
      "tasks": [
        { "id": "RU-186", "title": "SES Sender" },
        { "id": "RU-209", "title": "Production Smoke Check" }
      ],
      "gate": {
        "type": "command",
        "command": "npm test"
      }
    },
    {
      "name": "Onda 5: Frontend e Mobile",
      "instructions": "Spawn Claude worker for RU-211 and RU-212. Verify UI components and mobile builds.",
      "tasks": [
        { "id": "RU-211", "title": "Mobile Smoke" },
        { "id": "RU-212", "title": "Mascot Assets" }
      ],
      "gate": {
        "type": "command",
        "command": "npm run typecheck"
      }
    }
  ],
  "preventSleep": true,
  "circuitBreakerMaxFailures": 3
}
```

A wave's gate is evaluated when every task of the wave is completed (a wave with no tasks needs `nexus_wave_advance`) or immediately on `nexus_wave_advance`. `gate.type` is one of:
- `command` / `test`: runs `command` in a shell. `cwd` is relative to the workspace root, `timeoutMs` defaults to 120000, and the gate passes on exit code 0 plus, when `expectedRegex` is set, a case-insensitive match in the output.
- `file_exists`: passes when the path in `command` exists.
- `manual_or_mcp`: never passes by itself; it waits for `nexus_wave_advance`.
- `all_tasks_completed`: the default. With no gate (or no `command`), the wave passes once its tasks are completed.

### 2. Check Status: `nexus_goal_status`
Returns the active goal, current wave index, task checklist, and gate evaluation results.

### 3. Bind Worker Panes: `nexus_goal_bind_pane`
Associates a newly spawned pane with a task in the current wave:
```json
{
  "paneId": "pane_3",
  "taskId": "RU-209"
}
```
When this worker pane finishes and exits, the Goal Governor automatically marks its task as completed.

### 4. Advance Wave: `nexus_wave_advance`
Evaluates the current wave's gate immediately; with `force: true` it skips the gate and advances:
```json
{
  "force": false,
  "summary": "Completed RU-186 and RU-209 successfully with green smoke test."
}
```

### 5. Control Goal: `nexus_goal_control`
Allows pausing, resuming, cancelling, or retrying failed gates. `action` is `pause`, `resume`, `cancel` or `retry_gate`; `resume` and `retry_gate` clear the failure count, and `cancel` leaves the goal `blocked`:
```json
{
  "goalId": "goal_123",
  "action": "pause",
  "reason": "Waiting for manual review of Onda 5 credentials"
}
```

### 6. Update a Task: `nexus_goal_task_update`
Sets one task's status (`pending`, `in_progress`, `completed` or `failed`) without waiting for its bound pane to exit. `goalId` defaults to the active goal:
```json
{
  "taskId": "RU-209",
  "status": "completed",
  "summary": "Production smoke green"
}
```
