import type { ProjectExecutionScope } from '../../shared/types';
import type { AuditSource } from '../jarvis/audit-log';
import type { PermissionScope } from '../jarvis/permissions';
import type { AgentGateContext } from './gate';

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
  /**
   * Caminho que funciona, para o agente. Separado de `error` de propósito:
   * `error` é contrato (o smoke empacotado e o renderer comparam a string
   * canônica); a dica é copy e pode mudar sem quebrar ninguém.
   */
  hint?: string;
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
    /**
     * True quando o caller está confinado a leitura (pane.readOnly).
     * A gate de mutação preserva as proteções que valem para qualquer caller
     * (.context/ read-only, merge-queue) e faz short-circuit nas guards de
     * contract/stage — read-only não escreve.
     */
    callerReadOnly?: boolean,
  ): void;
}

export type WorkflowAuthorityResolver = (
  scope: ProjectExecutionScope,
  missionId: string,
) => WorkflowEffectAuthority;

/**
 * Prepara a reversibilidade e devolve a frase de desfazer que vai para a
 * auditoria. Lançar aqui ABORTA o comando: preparo quebrado não pode virar
 * ação sem volta.
 */
export type DestructiveReversibilityPreparer = (input: {
  readonly command: string;
  readonly cwd: string;
}) => Promise<{ readonly revertPath: string; readonly reversible: boolean }>;

export interface McpDispatchOptions {
  /** Physical source override for the authenticated ACP bridge boundary. */
  source?: McpDispatchSource;
  confirm?: McpConfirmationHandler;
  /**
   * Transport-owned observation of the completed dispatch result. The MCP
   * protocol uses this only for post-response lifecycle recovery; observers
   * must never change the tool result or become a second authority path.
   */
  onToolResult?: (result: Readonly<ToolDispatchResult>) => void;
  /** Renderer/voice seam: revalidate the exact native caller after awaits. */
  assertCurrentCaller?: () => boolean;
  /** Aborted when the native caller disappears while a handler is running. */
  callerSignal?: AbortSignal;
  /**
   * Constrói o caminho de volta de um comando destrutivo ANTES de ele rodar.
   * Seam de teste: produção usa lixeira do SO + refs do git. Ausente = sem
   * preparo, e nesse caso o piso de consentimento destrutivo permanece.
   */
  prepareDestructiveReversibility?: DestructiveReversibilityPreparer;
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
  /** Internal seam; production reserves synchronously in the scoped store. */
  reserveMissionBudget?: MissionBudgetReserver;
  /**
   * Caller-supplied operation id. This is the receipt key. A lost-response
   * retry resends the same id and does not run the handler. A JSON-RPC id is
   * not an operation id: reusing "1" starts a new call.
   */
  logicalOperationId?: string;
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
