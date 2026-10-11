import fsp from 'node:fs/promises';
import type { PeriodicTaskContext } from '../observability/periodic-task';
/**
 * Autonomous Goal Governor & Wave Engine
 *
 * Supervises multi-wave execution in loose-pane grids.
 * Runs inside the Electron Main Process adaptive reconciler clock.
 *
 * Responsibilities:
 * 1. Backlog State Machine: Manages Waves (pending -> running -> evaluating_gate -> passed -> wave_transition).
 * 2. Gate Verification: Runs tests/commands or asserts task evidence before advancing waves.
 * 3. Anti-Sleep Assertion: Keeps machine awake during overnight runs via powerSaveBlocker & AgentAwakeService.
 * 4. PTY Nudge Injection: Wakes idle orchestrators with structured wave instructions when workers finish or gates pass.
 * 5. Circuit Breaker: Pauses goal on consecutive failures to prevent runaway token burn.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { powerSaveBlocker } from 'electron';
import type {
  GoalDefinition,
  GoalGate,
  GoalGateResult,
  GoalGovernorSnapshot,
  GoalStatus,
  GoalWave,
  RegisterGoalParams,
  TaskStatus,
} from '../../shared/goal-governor-types';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import { resolveRootForScope } from './workspace-path';
import { getSessionState, orchWriteSession } from '../pty/pty-manager';
import { findPane } from './pane-registry';
import { getAgentAwakeService } from '../agent-runtime/agent-runtime-bridge';

export const GOAL_GOVERNOR_RECONCILE_CADENCE_MS = 3_000;
const DEFAULT_GATE_TIMEOUT_MS = 120_000;
const DEFAULT_CIRCUIT_BREAKER_MAX = 3;
const NUDGE_COOLDOWN_MS = 25_000;
const ORCH_IDLE_STALL_NUDGE_MS = 45_000;

function notifyPet(
  kind:
    | 'goal-wave-started'
    | 'goal-wave-completed'
    | 'goal-gate-passed'
    | 'goal-finished',
  title: string,
): void {
  try {
    import('../pet/pet-window')
      .then((mod) => {
        mod.broadcastPetEvent({
          kind,
          title,
          at: Date.now(),
        });
      })
      .catch(() => {});
  } catch {
    // Ignore when running in tests or without pet window
  }
}

// Internal state
const goals = new Map<string, GoalDefinition>();
const gatesInFlight = new Set<string>(); // goalId
let powerBlockerId: number | null = null;
let customGateRunner: ((gate: GoalGate, cwd: string) => Promise<GoalGateResult>) | null = null;

export function setCustomGateRunnerForTesting(
  runner: ((gate: GoalGate, cwd: string) => Promise<GoalGateResult>) | null,
): void {
  customGateRunner = runner;
}

function generateGoalId(): string {
  return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function goalsDirForScope(scope: ProjectExecutionScope): string {
  try {
    const root = resolveRootForScope(scope);
    return path.join(root, '.nexus', 'goals');
  } catch {
    return '';
  }
}

const pendingGoalWrites = new Map<string, { directory: string; text: string }>();
const goalWriteFlights = new Map<string, Promise<void>>();
let goalWriteSequence = 0;

function persistGoalToDisk(goal: GoalDefinition): void {
  const directory = goalsDirForScope(goal.scope);
  if (!directory) return;
  pendingGoalWrites.set(goal.id, { directory, text: JSON.stringify(goal, null, 2) });
  if (goalWriteFlights.has(goal.id)) return;
  const flight = (async () => {
    while (pendingGoalWrites.has(goal.id)) {
      const snapshot = pendingGoalWrites.get(goal.id)!;
      pendingGoalWrites.delete(goal.id);
      const target = path.join(snapshot.directory, `${goal.id}.json`);
      const temporary = `${target}.tmp.${process.pid}.${++goalWriteSequence}`;
      try {
        await fsp.mkdir(snapshot.directory, { recursive: true });
        await fsp.writeFile(temporary, snapshot.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await fsp.rename(temporary, target);
      } catch { /* Preserve the existing in-memory fallback on readonly FS. */ }
      finally { await fsp.unlink(temporary).catch(() => undefined); }
    }
  })();
  goalWriteFlights.set(goal.id, flight);
  void flight.finally(() => { if (goalWriteFlights.get(goal.id) === flight) goalWriteFlights.delete(goal.id); });
}

function updateAwakeLock(): void {
  const hasActiveGoals = Array.from(goals.values()).some(
    (g) => (g.status === 'running' || g.status === 'evaluating_gate' || g.status === 'wave_transition') && g.preventSleep,
  );

  if (hasActiveGoals) {
    if (powerBlockerId === null) {
      try {
        powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      } catch {
        // Ignored in headless/test environments
      }
    }
    try {
      getAgentAwakeService().setStatuses([
        {
          state: 'working',
          receivedAt: Date.now(),
          observedInCurrentRuntime: true,
        },
      ]);
    } catch {
      // Ignored if awake service unavailable
    }
  } else {
    if (powerBlockerId !== null) {
      try {
        powerSaveBlocker.stop(powerBlockerId);
      } catch {
        // Ignored
      }
      powerBlockerId = null;
    }
  }
}

export function registerGoal(params: RegisterGoalParams): GoalDefinition {
  const id = generateGoalId();
  const now = Date.now();

  const waves: GoalWave[] = params.waves.map((w, index) => ({
    id: w.id || `wave_${index + 1}`,
    name: w.name,
    instructions: w.instructions,
    tasks: (w.tasks ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      status: 'pending' as TaskStatus,
      updatedAt: now,
    })),
    gate: w.gate,
    status: (index === 0 ? 'running' : 'pending') as GoalWave['status'],
    workerPaneIds: [],
    startedAt: index === 0 ? now : undefined,
  }));

  const goal: GoalDefinition = {
    id,
    title: params.title,
    scope: params.scope,
    orchestratorSessionId: params.orchestratorSessionId,
    orchestratorPaneId: params.orchestratorPaneId,
    status: 'running',
    currentWaveIndex: 0,
    waves,
    preventSleep: params.preventSleep ?? true,
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    circuitBreakerMaxFailures: params.circuitBreakerMaxFailures ?? DEFAULT_CIRCUIT_BREAKER_MAX,
  };

  goals.set(id, goal);
  persistGoalToDisk(goal);
  updateAwakeLock();

  // Initial wave kickoff nudge if orchestrator is idle
  const firstWave = waves[0];
  if (firstWave) {
    const taskList = firstWave.tasks.length > 0
      ? `\nTasks:\n${firstWave.tasks.map((t) => `- [ ] ${t.id}: ${t.title}`).join('\n')}`
      : '';
    const initialNudge =
      `[NEXUS GOAL GOVERNOR] Goal registered: "${goal.title}".\n` +
      `Starting Wave 1/${waves.length}: "${firstWave.name}".\n` +
      `Instructions: ${firstWave.instructions}${taskList}\n` +
      `Proceed with spawning workers or executing tasks for this wave.`;
    nudgeOrchestrator(goal, initialNudge, now);
    notifyPet(
      'goal-wave-started',
      `Iniciando Meta /goal: ${firstWave.name}`,
    );
  }

  return goal;
}

export function getGoal(id: string): GoalDefinition | null {
  return goals.get(id) ?? null;
}

export function getActiveGoalForScope(scope?: ProjectExecutionScope): GoalDefinition | null {
  for (const goal of goals.values()) {
    if (goal.status === 'running' || goal.status === 'evaluating_gate' || goal.status === 'wave_transition') {
      if (!scope || goal.scope.rootRealPath === scope.rootRealPath) {
        return goal;
      }
    }
  }
  return null;
}

export function listGoals(scope?: ProjectExecutionScope): GoalDefinition[] {
  const all = Array.from(goals.values());
  if (!scope) return all;
  return all.filter((g) => g.scope.rootRealPath === scope.rootRealPath);
}

export function bindWorkerPaneToGoal(
  goalId: string,
  paneId: string,
  taskId?: string,
): { ok: boolean; error?: string } {
  const goal = goals.get(goalId);
  if (!goal) return { ok: false, error: `goal not found: ${goalId}` };

  const wave = goal.waves[goal.currentWaveIndex];
  if (!wave) return { ok: false, error: 'no active wave' };

  if (!wave.workerPaneIds.includes(paneId)) {
    wave.workerPaneIds.push(paneId);
  }

  if (taskId) {
    const task = wave.tasks.find((t) => t.id === taskId);
    if (task) {
      task.assignedPaneId = paneId;
      task.status = 'in_progress';
      task.updatedAt = Date.now();
    }
  }

  goal.updatedAt = Date.now();
  persistGoalToDisk(goal);
  return { ok: true };
}

export function updateGoalTask(
  goalId: string,
  taskId: string,
  status: TaskStatus,
  summary?: string,
): { ok: boolean; error?: string } {
  const goal = goals.get(goalId);
  if (!goal) return { ok: false, error: `goal not found: ${goalId}` };

  for (const wave of goal.waves) {
    const task = wave.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = status;
      if (summary !== undefined) task.summary = summary;
      task.updatedAt = Date.now();
      goal.updatedAt = Date.now();
      persistGoalToDisk(goal);
      return { ok: true };
    }
  }

  return { ok: false, error: `task ${taskId} not found in goal ${goalId}` };
}

export async function advanceWave(
  goalId: string,
  options: { force?: boolean; summary?: string } = {},
): Promise<{ ok: boolean; currentWaveIndex: number; status: GoalStatus; error?: string }> {
  const goal = goals.get(goalId);
  if (!goal) return { ok: false, currentWaveIndex: -1, status: 'blocked', error: `goal not found: ${goalId}` };

  const currentWave = goal.waves[goal.currentWaveIndex];
  if (!currentWave) {
    goal.status = 'completed';
    goal.updatedAt = Date.now();
    persistGoalToDisk(goal);
    updateAwakeLock();
    return { ok: true, currentWaveIndex: goal.currentWaveIndex, status: goal.status };
  }

  if (options.force) {
    currentWave.status = 'passed';
    currentWave.completedAt = Date.now();
    goal.consecutiveFailures = 0;
    goal.currentWaveIndex++;

    if (goal.currentWaveIndex >= goal.waves.length) {
      goal.status = 'completed';
      goal.updatedAt = Date.now();
      persistGoalToDisk(goal);
      updateAwakeLock();
      nudgeOrchestrator(
        goal,
        `[NEXUS GOAL GOVERNOR] 🎉 ALL WAVES COMPLETED! Goal "${goal.title}" finished successfully.${
          options.summary ? `\nSummary: ${options.summary}` : ''
        }`,
        Date.now(),
      );
    } else {
      const nextWave = goal.waves[goal.currentWaveIndex];
      nextWave.status = 'running';
      nextWave.startedAt = Date.now();
      goal.status = 'running';
      goal.updatedAt = Date.now();
      persistGoalToDisk(goal);
      updateAwakeLock();

      const taskList = nextWave.tasks.length > 0
        ? `\nTasks:\n${nextWave.tasks.map((t) => `- [ ] ${t.id}: ${t.title}`).join('\n')}`
        : '';
      nudgeOrchestrator(
        goal,
        `[NEXUS GOAL GOVERNOR] ✅ Wave "${currentWave.name}" marked complete.\n` +
        `Now starting Wave ${goal.currentWaveIndex + 1}/${goal.waves.length}: "${nextWave.name}".\n` +
        `Instructions: ${nextWave.instructions}${taskList}`,
        Date.now(),
      );
    }
    return { ok: true, currentWaveIndex: goal.currentWaveIndex, status: goal.status };
  }

  // Trigger immediate gate evaluation
  goal.status = 'evaluating_gate';
  currentWave.status = 'running';
  goal.updatedAt = Date.now();
  persistGoalToDisk(goal);
  await runWaveGateEvaluation(goal, currentWave, Date.now());

  return { ok: true, currentWaveIndex: goal.currentWaveIndex, status: goal.status };
}

export function controlGoal(
  goalId: string,
  action: 'pause' | 'resume' | 'cancel' | 'retry_gate',
  reason?: string,
): { ok: boolean; goal?: GoalDefinition; error?: string } {
  const goal = goals.get(goalId);
  if (!goal) return { ok: false, error: `goal not found: ${goalId}` };

  const now = Date.now();
  switch (action) {
    case 'pause':
      goal.status = 'paused';
      if (reason) goal.blockReason = reason;
      break;
    case 'resume':
      if (goal.status === 'paused' || goal.status === 'blocked') {
        goal.status = 'running';
        goal.consecutiveFailures = 0;
        delete goal.blockReason;
      }
      break;
    case 'cancel':
      goal.status = 'blocked';
      goal.blockReason = reason || 'cancelled by operator';
      break;
    case 'retry_gate':
      goal.status = 'evaluating_gate';
      goal.consecutiveFailures = 0;
      delete goal.blockReason;
      break;
  }

  goal.updatedAt = now;
  persistGoalToDisk(goal);
  updateAwakeLock();
  return { ok: true, goal };
}

export function getGoalGovernorSnapshot(): GoalGovernorSnapshot {
  const active = getActiveGoalForScope();
  return {
    activeGoalId: active?.id ?? null,
    goals: Array.from(goals.values()),
    isAwakeLocked: powerBlockerId !== null,
  };
}

/**
 * Executes the gate check for a wave (command, test, file check, or tasks check).
 */
async function executeGateCheck(
  gate: GoalGate,
  scope: ProjectExecutionScope,
  attempt: number,
): Promise<GoalGateResult> {
  const now = Date.now();
  let root = '';
  try {
    root = resolveRootForScope(scope);
  } catch {
    return {
      checkedAt: now,
      passed: false,
      output: 'Workspace root path not accessible',
      attempt,
    };
  }

  const cwd = gate.cwd ? path.resolve(root, gate.cwd) : root;

  if (customGateRunner) {
    return customGateRunner(gate, cwd);
  }

  if (gate.type === 'file_exists') {
    const targetPath = path.resolve(cwd, gate.command ?? '');
    const exists = fs.existsSync(targetPath);
    return {
      checkedAt: now,
      passed: exists,
      output: exists ? `File exists: ${targetPath}` : `File not found: ${targetPath}`,
      attempt,
    };
  }

  if (gate.type === 'manual_or_mcp') {
    return {
      checkedAt: now,
      passed: false,
      output: 'Awaiting explicit advance via nexus_wave_advance',
      attempt,
    };
  }

  const command = gate.command?.trim();
  if (!command) {
    return {
      checkedAt: now,
      passed: true,
      output: 'No gate command specified, automatically passed',
      attempt,
    };
  }

  return new Promise<GoalGateResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    // F-1214: own process group so the timeout reaches the hung grandchild
    // (`npm test` → node), not only the shell that launched it.
    const ownGroup = process.platform !== 'win32';
    const proc = spawn(command, {
      cwd,
      shell: true,
      detached: ownGroup,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (ownGroup && proc.pid) process.kill(-proc.pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve({
        checkedAt: Date.now(),
        passed: false,
        output: `Gate timed out after ${gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS}ms\n${stdout}\n${stderr}`,
        exitCode: 124,
        attempt,
      });
    }, gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS);

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 500_000) stdout = stdout.slice(-200_000);
    });

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 500_000) stderr = stderr.slice(-200_000);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        checkedAt: Date.now(),
        passed: false,
        output: `Gate execution error: ${err.message}`,
        exitCode: -1,
        attempt,
      });
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const combined = `${stdout}\n${stderr}`.trim();
      let passed = code === 0;

      if (passed && gate.expectedRegex) {
        try {
          const reg = new RegExp(gate.expectedRegex, 'i');
          passed = reg.test(combined);
        } catch {
          passed = false;
        }
      }

      resolve({
        checkedAt: Date.now(),
        passed,
        output: combined.slice(-10_000),
        exitCode: code,
        attempt,
      });
    });
  });
}

/**
 * Runs gate evaluation for a wave, updates status, and advances or trips circuit breaker.
 */
async function runWaveGateEvaluation(
  goal: GoalDefinition,
  wave: GoalWave,
  now: number,
): Promise<void> {
  if (gatesInFlight.has(goal.id)) return;
  gatesInFlight.add(goal.id);

  try {
    const attempt = goal.consecutiveFailures + 1;
    let result: GoalGateResult;

    if (wave.gate) {
      result = await executeGateCheck(wave.gate, goal.scope, attempt);
    } else {
      // Default: pass if all tasks completed or no tasks
      const allDone = wave.tasks.length === 0 || wave.tasks.every((t) => t.status === 'completed');
      result = {
        checkedAt: now,
        passed: allDone,
        output: allDone ? 'All wave tasks completed.' : 'Unfinished wave tasks remain.',
        attempt,
      };
    }

    wave.gateResult = result;
    goal.updatedAt = Date.now();

    if (result.passed) {
      wave.status = 'passed';
      wave.completedAt = Date.now();
      goal.consecutiveFailures = 0;
      goal.currentWaveIndex++;
      notifyPet('goal-gate-passed', `Gate aprovado: Onda "${wave.name}"`);
      notifyPet('goal-wave-completed', `Onda "${wave.name}" concluída!`);

      if (goal.currentWaveIndex >= goal.waves.length) {
        goal.status = 'completed';
        persistGoalToDisk(goal);
        updateAwakeLock();
        notifyPet('goal-finished', `Meta /goal "${goal.title}" concluída!`);
        nudgeOrchestrator(
          goal,
          `[NEXUS GOAL GOVERNOR] 🎉 ALL WAVES COMPLETED! Goal "${goal.title}" finished successfully.`,
          Date.now(),
          true,
        );
      } else {
        const nextWave = goal.waves[goal.currentWaveIndex];
        nextWave.status = 'running';
        nextWave.startedAt = Date.now();
        goal.status = 'running';
        persistGoalToDisk(goal);
        updateAwakeLock();
        notifyPet(
          'goal-wave-started',
          `Iniciando Onda ${goal.currentWaveIndex + 1}: ${nextWave.name}`,
        );

        const taskList = nextWave.tasks.length > 0
          ? `\nTasks:\n${nextWave.tasks.map((t) => `- [ ] ${t.id}: ${t.title}`).join('\n')}`
          : '';
        nudgeOrchestrator(
          goal,
          `[NEXUS GOAL GOVERNOR] ✅ Wave "${wave.name}" passed all gates!\n` +
          `Now starting Wave ${goal.currentWaveIndex + 1}/${goal.waves.length}: "${nextWave.name}".\n` +
          `Instructions: ${nextWave.instructions}${taskList}`,
          Date.now(),
          true,
        );
      }
    } else {
      goal.consecutiveFailures++;
      if (goal.consecutiveFailures >= goal.circuitBreakerMaxFailures) {
        goal.status = 'blocked';
        goal.blockReason = `Gate check failed ${goal.consecutiveFailures} consecutive times (Circuit breaker tripped).`;
        wave.status = 'failed';
        persistGoalToDisk(goal);
        updateAwakeLock();

        nudgeOrchestrator(
          goal,
          `[NEXUS GOAL GOVERNOR] ⛔ Circuit breaker tripped for Goal "${goal.title}".\n` +
          `Wave "${wave.name}" gate check failed ${goal.consecutiveFailures} times.\n` +
          `Execution paused overnight to prevent token burn. Operator intervention needed.\n` +
          `Gate output:\n${result.output.slice(-1_500)}`,
          Date.now(),
          true,
        );
      } else {
        wave.status = 'running';
        goal.status = 'running';
        persistGoalToDisk(goal);

        nudgeOrchestrator(
          goal,
          `[NEXUS GOAL GOVERNOR] ⚠️ Gate check failed for Wave "${wave.name}" (attempt ${goal.consecutiveFailures}/${goal.circuitBreakerMaxFailures}):\n` +
          `${result.output.slice(-1_000)}\n` +
          `Please fix errors or run nexus_wave_advance with force:true when verified.`,
          Date.now(),
        );
      }
    }
  } finally {
    gatesInFlight.delete(goal.id);
  }
}

/**
 * Injects a prompt / notification directly into the orchestrator pane's PTY when idle.
 */
function nudgeOrchestrator(
  goal: GoalDefinition,
  message: string,
  now: number,
  force = false,
): boolean {
  if (!force && goal.lastNudgedAt && now - goal.lastNudgedAt < NUDGE_COOLDOWN_MS) {
    return false;
  }

  const sessionId = goal.orchestratorSessionId;
  if (!sessionId) return false;

  const state = getSessionState(sessionId);
  // Only write when orchestrator is idle (not busy running an existing command or typing)
  if (state !== 'idle') {
    return false;
  }

  try {
    // Send bracketed paste followed by carriage return to prompt the orchestrator
    const payload = `\x1b[200~${message}\x1b[201~\r`;
    const written = orchWriteSession(sessionId, payload, { markInputBusy: false });
    if (written) {
      goal.lastNudgedAt = now;
      goal.lastNudgeMessage = message;
      return true;
    }
  } catch (err) {
    console.warn(`[goal-governor] Failed to nudge orchestrator session ${sessionId}:`, err);
  }
  return false;
}

/**
 * Adaptive Clock Reconciler Participant
 * Called every ~3 seconds by OrchestrationReconciler.
 */
export async function reconcileGoalGovernor(now: number, context?: PeriodicTaskContext): Promise<void> {
  updateAwakeLock();

  goalsPass: for (const goal of [...goals.values()]) {
    await context?.checkpoint();
    if (goals.get(goal.id) !== goal) continue;
    if (goal.status !== 'running' && goal.status !== 'evaluating_gate') {
      continue;
    }

    if (goal.currentWaveIndex >= goal.waves.length) {
      goal.status = 'completed';
      goal.updatedAt = now;
      persistGoalToDisk(goal);
      updateAwakeLock();
      nudgeOrchestrator(
        goal,
        `[NEXUS GOAL GOVERNOR] 🎉 ALL WAVES COMPLETED! Goal "${goal.title}" finished successfully.`,
        now,
      );
      continue;
    }

    const currentWave = goal.waves[goal.currentWaveIndex];
    if (!currentWave) continue;

    // 1. Check bound worker panes for exit or task completion
    for (const paneId of [...currentWave.workerPaneIds]) {
      await context?.checkpoint();
      if (goals.get(goal.id) !== goal || goal.waves[goal.currentWaveIndex] !== currentWave ||
        goal.status !== 'running') continue goalsPass;
      const pane = findPane(paneId);
      if (pane && pane.state === 'exited') {
        // Worker exited — mark any in-progress tasks assigned to this pane as completed
        for (const task of [...currentWave.tasks]) {
          await context?.checkpoint();
          if (goals.get(goal.id) !== goal || goal.waves[goal.currentWaveIndex] !== currentWave ||
            goal.status !== 'running' || findPane(paneId)?.sessionId !== pane.sessionId ||
            findPane(paneId)?.state !== 'exited') continue goalsPass;
          if (task.assignedPaneId === paneId && task.status === 'in_progress') {
            task.status = 'completed';
            task.updatedAt = now;
            goal.updatedAt = now;
          }
        }
      }
    }

    persistGoalToDisk(goal);
    if (context) await context.wait(goalWriteFlights.get(goal.id) ?? Promise.resolve());
    else await goalWriteFlights.get(goal.id);
    if (goals.get(goal.id) !== goal || goal.waves[goal.currentWaveIndex] !== currentWave ||
      (goal.status !== 'running' && goal.status !== 'evaluating_gate')) continue;

    // 2. Evaluate if current wave is ready for gate evaluation
    const allTasksCompleted =
      currentWave.tasks.length > 0 && currentWave.tasks.every((t) => t.status === 'completed');

    if (goal.status === 'evaluating_gate' || (allTasksCompleted && currentWave.status === 'running')) {
      goal.status = 'evaluating_gate';
      await runWaveGateEvaluation(goal, currentWave, now);
      continue;
    }

    // 3. Check for orchestrator stall: if orchestrator has been idle and no nudge was sent recently
    const orchState = getSessionState(goal.orchestratorSessionId);
    if (orchState === 'idle') {
      const timeSinceNudge = now - (goal.lastNudgedAt ?? 0);
      if (timeSinceNudge >= ORCH_IDLE_STALL_NUDGE_MS) {
        const remaining = currentWave.tasks.filter((t) => t.status !== 'completed');
        const statusSummary = remaining.length > 0
          ? `Remaining tasks:\n${remaining.map((t) => `- [ ] ${t.id}: ${t.title}`).join('\n')}`
          : 'All tasks reported done. Run nexus_wave_advance to trigger gate evaluation.';
        nudgeOrchestrator(
          goal,
          `[NEXUS GOAL GOVERNOR] Wave "${currentWave.name}" is in progress.\n${statusSummary}`,
          now,
        );
      }
    }
  }
}

export async function shutdownGoalGovernor(): Promise<void> {
  await Promise.allSettled([...goalWriteFlights.values()]);
  // Release power blocker
  if (powerBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerBlockerId);
    } catch {
      // ignore
    }
    powerBlockerId = null;
  }
  gatesInFlight.clear();
}

/** Clear in-memory goals (primarily for tests). */
export function clearGoalsForTesting(): void {
  goals.clear();
  gatesInFlight.clear();
  if (powerBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerBlockerId);
    } catch {
      // ignore
    }
    powerBlockerId = null;
  }
  customGateRunner = null;
}
