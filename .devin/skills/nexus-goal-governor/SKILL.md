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
1. Maintaining a durable state machine (`pending` -> `running` -> `evaluating_gate` -> `passed` -> `wave_transition` -> `completed`).
2. Keeping the machine awake during active waves (`preventSleep: true`).
3. Running verification gates (e.g. `npm test`, `npm run typecheck`) between waves.
4. Nudging the orchestrator terminal PTY with the instructions and tasks for the next wave once the current wave passes.
5. Halting safely via a Circuit Breaker if a gate fails 3 times consecutively (preventing token burn).

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
Forces advance or evaluates gates immediately:
```json
{
  "force": false,
  "summary": "Completed RU-186 and RU-209 successfully with green smoke test."
}
```

### 5. Control Goal: `nexus_goal_control`
Allows pausing, resuming, cancelling, or retrying failed gates:
```json
{
  "goalId": "goal_123",
  "action": "pause",
  "reason": "Waiting for manual review of Onda 5 credentials"
}
```
