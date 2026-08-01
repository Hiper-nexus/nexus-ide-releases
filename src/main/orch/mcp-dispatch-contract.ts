import type { ProjectExecutionScope } from '../../shared/types';
import type { AuditSource } from '../jarvis/audit-log';
import type { PermissionScope } from '../jarvis/permissions';
import type { AgentGateContext } from './gate';
import type {
  GuidedPrevcMcpFenceResolver,
} from './guided-prevc-mcp-fence';

/**
 * Sources allowed to execute a live tool dispatch. PTY stream is a current
 * Main-observed transport; legacy OMP stdio remains audit-read compatibility.
 */
export type McpDispatchSource = Exclude<
  AuditSource,
  'omp-rpc-stdio'
>;

export function normalizeDispatchSessionId(
  source: McpDispatchSource,
  ctx: AgentGateContext,
): string {
  if (source === 'ipc-renderer') return 'jarvis-renderer';
  if (source === 'jarvis-voice') return 'jarvis-voice';
  return ctx.sessionId ?? `http:${ctx.token.slice(0, 16)}`;
}

export interface ToolDispatchResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
  denied?: boolean;
  requiredConfirmation?: boolean;
  confirmationReason?: string;
  userAuthorized?: boolean;
  /** True when a failed dispatch started a high-impact handler. Never retry blindly. */
  effectMayHaveCommitted?: boolean;
}

export interface McpConfirmationRequest {
  source: McpDispatchSource;
  sessionId: string;
  workspaceId: string;
  projectId: string;
  checkoutId: string;
  missionId?: string;
  contextRevision?: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  agentLabel: string;
}

export type McpConfirmationHandler = (
  request: McpConfirmationRequest,
) => Promise<boolean>;

export interface IntentGateMissionResolver {
  (
    scope: ProjectExecutionScope,
    missionId: string,
  ): {
    mission: import('../../shared/orch-types').Mission;
    taskCount: number;
    workerPaneCount: number;
  } | null;
}

export interface CommittedPhysicalHandoffReplayCandidate {
  readonly missionId: string;
  readonly sessionId: string;
  readonly workerIncarnationId?: string;
  readonly rawPayloadSha256: string;
  readonly handoffStatus: "success" | "partial" | "blocked" | "failed";
  readonly missionStatus: "blocked" | "done";
}

export type CommittedPhysicalHandoffReplayCandidateResolver = (
  scope: ProjectExecutionScope,
  candidate: CommittedPhysicalHandoffReplayCandidate,
) => boolean;

export interface CommittedFanoutConsolidationReplayCandidate {
  readonly missionId: string;
  readonly sessionId: string;
  readonly finalOutput: string;
}

export type CommittedFanoutConsolidationReplayCandidateResolver = (
  scope: ProjectExecutionScope,
  candidate: CommittedFanoutConsolidationReplayCandidate,
) => boolean;

export type MissionBudgetReserver = (
  scope: ProjectExecutionScope,
  missionId: string,
  toolName: string,
  expectedIntentVersion: number,
) => void;

export interface WorkflowEffectAuthority {
  /** Frozen PREVC revision bound to this invocation, when one exists. */
  readonly contextRevision: string | undefined;
  assertExecutionEffectAllowed(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): void;
}

export type WorkflowAuthorityResolver = (
  scope: ProjectExecutionScope,
  missionId: string,
) => WorkflowEffectAuthority;

export interface McpDispatchOptions {
  /** Physical source override for the authenticated ACP bridge boundary. */
  source?: McpDispatchSource;
  confirm?: McpConfirmationHandler;
  /** Renderer/voice seam: revalidate the exact native caller after awaits. */
  assertCurrentCaller?: () => boolean;
  /** Aborted when the native caller disappears while a handler is running. */
  callerSignal?: AbortSignal;
  /** Internal seam for isolated dispatch tests; production uses PREVC. */
  resolveWorkflowAuthority?: WorkflowAuthorityResolver;
  /** Internal seam for intent-gate tests; production resolves scoped stores. */
  resolveMissionForIntentGate?: IntentGateMissionResolver;
  /**
   * Internal seam for terminal lost-response replay tests. Returning true is
   * only an admission hint; the handoff store must still re-prove the exact
   * physical receipt, durable audit, payload and dispatch in one transaction.
   */
  resolveCommittedPhysicalHandoffReplayCandidate?: CommittedPhysicalHandoffReplayCandidateResolver;
  /** Exact, read-only admission hint for a lost fan-out completion response. */
  resolveCommittedFanoutConsolidationReplayCandidate?: CommittedFanoutConsolidationReplayCandidateResolver;
  /** Internal seam; production reserves synchronously in the scoped store. */
  reserveMissionBudget?: MissionBudgetReserver;
  /**
   * Internal dispatch-test seam. Production compiles the exact guided PREVC
   * fence from scoped stores/workflow on every authority checkpoint.
   */
  resolveGuidedPrevcMcpFence?: GuidedPrevcMcpFenceResolver;
}

export function permissionScopeForTool(
  sessionId: string,
  projectScope: ProjectExecutionScope,
  toolName: string,
  args: Record<string, unknown>,
): PermissionScope {
  return {
    sessionId,
    workspaceId: projectScope.rootRealPath,
    projectId: projectScope.projectId,
    checkoutId: projectScope.checkoutId,
    toolName,
    args,
  };
}
