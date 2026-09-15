import type { ProjectExecutionScope } from './project-identity-types';

export type GoalStatus =
  | 'pending'
  | 'running'
  | 'evaluating_gate'
  | 'wave_transition'
  | 'paused'
  | 'completed'
  | 'blocked';

export type WaveStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

export type GoalGateType =
  | 'command'
  | 'test'
  | 'file_exists'
  | 'all_tasks_completed'
  | 'manual_or_mcp';

export interface GoalGate {
  readonly type: GoalGateType;
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly expectedRegex?: string;
}

export interface GoalTask {
  readonly id: string;
  title: string;
  status: TaskStatus;
  assignedPaneId?: string;
  assignedSessionId?: string;
  summary?: string;
  updatedAt?: number;
}

export interface GoalGateResult {
  readonly checkedAt: number;
  readonly passed: boolean;
  readonly output: string;
  readonly exitCode?: number | null;
  readonly attempt: number;
}

export interface GoalWave {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly tasks: GoalTask[];
  readonly gate?: GoalGate;
  status: WaveStatus;
  readonly workerPaneIds: string[];
  startedAt?: number;
  completedAt?: number;
  gateResult?: GoalGateResult;
}

export interface GoalDefinition {
  readonly id: string;
  readonly title: string;
  readonly scope: ProjectExecutionScope;
  orchestratorSessionId: string;
  orchestratorPaneId?: string;
  status: GoalStatus;
  currentWaveIndex: number;
  readonly waves: GoalWave[];
  preventSleep: boolean;
  readonly createdAt: number;
  updatedAt: number;
  consecutiveFailures: number;
  readonly circuitBreakerMaxFailures: number;
  blockReason?: string;
  lastNudgedAt?: number;
  lastNudgeMessage?: string;
}

export interface RegisterGoalParams {
  readonly title: string;
  readonly scope: ProjectExecutionScope;
  readonly orchestratorSessionId: string;
  readonly orchestratorPaneId?: string;
  readonly waves: ReadonlyArray<{
    readonly id?: string;
    readonly name: string;
    readonly instructions: string;
    readonly tasks?: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
    }>;
    readonly gate?: GoalGate;
  }>;
  readonly preventSleep?: boolean;
  readonly circuitBreakerMaxFailures?: number;
}

export interface GoalGovernorSnapshot {
  readonly activeGoalId: string | null;
  readonly goals: ReadonlyArray<GoalDefinition>;
  readonly isAwakeLocked: boolean;
}
