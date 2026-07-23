// Derived from can1357/oh-my-pi@03c48d073 rpc-types (MIT)
import { z } from 'zod';

/**
 * Tipos do protocolo RPC do oh-my-pi (`omp --mode rpc-ui`) — SOMENTE o
 * subconjunto que o Nexus consome/emite. O transporte é NDJSON sobre
 * stdin/stdout (1 objeto JSON por linha, sem envelope). Todo frame que chega
 * do processo é `unknown` até passar por um destes schemas (padrão do repo:
 * zod no receptor).
 *
 * A versão do binário é pinada exatamente (docs/rpc.md não versiona o frame
 * `ready`, então o handshake valida `omp --version` antes do start).
 */

/** Única release cujo contrato rpc-ui foi validado pelo Nexus. */
export const OMP_RPC_SUPPORTED_VERSION = '17.0.4' as const;

// ---------------------------------------------------------------------------
// Frames inbound (stdout do processo omp) — schemas zod.
// ---------------------------------------------------------------------------

/** Primeiro frame emitido pelo processo; não carrega versão. */
export const ompReadyFrameSchema = z.looseObject({ type: z.literal('ready') });

export const ompModelSchema = z.looseObject({
  provider: z.string().max(256),
  id: z.string().max(512),
  name: z.string().max(1_024).optional(),
});
export type OmpModel = z.infer<typeof ompModelSchema>;

export const ompContextUsageSchema = z.looseObject({
  tokens: z.number(),
  contextWindow: z.number(),
  percent: z.number(),
});
export type OmpContextUsage = z.infer<typeof ompContextUsageSchema>;

/** Payload de `get_state` (RpcSessionState) — só os campos que o Nexus usa. */
export const ompSessionStateSchema = z.looseObject({
  model: ompModelSchema.optional(),
  thinkingLevel: z.string().max(128).optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  sessionId: z.string().max(512),
  sessionName: z.string().max(2_048).optional(),
  contextUsage: ompContextUsageSchema.optional(),
});
export type OmpSessionState = z.infer<typeof ompSessionStateSchema>;

/**
 * Resposta de comando. `prompt` é ack imediato: a conclusão do turno chega por
 * `agent_end`, `data.agentInvoked: false` ou por um `prompt_result` posterior.
 */
export const ompResponseFrameSchema = z.looseObject({
  type: z.literal('response'),
  id: z.string().max(256).optional(),
  command: z.string().max(128),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().max(65_536).optional(),
});
export type OmpResponseFrame = z.infer<typeof ompResponseFrameSchema>;

export const ompPromptResultFrameSchema = z.looseObject({
  type: z.literal('prompt_result'),
  id: z.string().max(256).optional(),
  agentInvoked: z.boolean(),
});

/** Deltas de streaming dentro de `message_update` (AssistantMessageEvent). */
export const ompAssistantMessageEventSchema = z.looseObject({
  type: z.string().max(128),
  contentIndex: z.number().optional(),
  delta: z.string().max(1_048_576).optional(),
});

export const ompAgentStartFrameSchema = z.looseObject({
  type: z.literal('agent_start'),
});
export const ompAgentEndFrameSchema = z.looseObject({
  type: z.literal('agent_end'),
});
export const ompMessageUpdateFrameSchema = z.looseObject({
  type: z.literal('message_update'),
  assistantMessageEvent: ompAssistantMessageEventSchema,
});
export const ompMessageEndFrameSchema = z.looseObject({
  type: z.literal('message_end'),
});

export const ompToolExecutionStartFrameSchema = z.looseObject({
  type: z.literal('tool_execution_start'),
  toolCallId: z.string().max(256),
  toolName: z.string().max(256),
  args: z.unknown().optional(),
});
export const ompToolExecutionEndFrameSchema = z.looseObject({
  type: z.literal('tool_execution_end'),
  toolCallId: z.string().max(256),
  toolName: z.string().max(256),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
});

/**
 * Pedidos de UI de extensões (inclui prompts de aprovação de tools quando o
 * processo roda com `--approval-mode always-ask`). Só os métodos com resposta
 * (select/confirm/input/editor) participam do fluxo de aprovação; os demais
 * são efeitos de apresentação.
 */
export const ompExtensionUiRequestSchema = z.looseObject({
  type: z.literal('extension_ui_request'),
  id: z.string().max(256),
  method: z.enum([
    'select',
    'confirm',
    'input',
    'editor',
    'cancel',
    'notify',
    'setStatus',
    'setWidget',
    'setTitle',
    'set_editor_text',
    'open_url',
  ]),
  title: z.string().max(4_096).optional(),
  message: z.string().max(65_536).optional(),
  options: z.array(z.string().max(20_000)).max(256).optional(),
  placeholder: z.string().max(20_000).optional(),
  prefill: z.string().max(200_000).optional(),
  targetId: z.string().max(256).optional(),
  url: z.string().max(8_192).optional(),
  notifyType: z.enum(['info', 'warning', 'error']).optional(),
  timeout: z.number().finite().int().positive().max(600_000).optional(),
});
export type OmpExtensionUiRequest = z.infer<typeof ompExtensionUiRequestSchema>;

export const ompHostToolCallFrameSchema = z.looseObject({
  type: z.literal('host_tool_call'),
  id: z.string().max(256),
  toolCallId: z.string().max(256),
  toolName: z.string().max(256),
  arguments: z.record(z.string(), z.unknown()),
});
export type OmpHostToolCallFrame = z.infer<typeof ompHostToolCallFrameSchema>;

export const ompHostToolCancelFrameSchema = z.looseObject({
  type: z.literal('host_tool_cancel'),
  id: z.string().max(256),
  targetId: z.string().max(256),
});

export const ompAvailableCommandsUpdateFrameSchema = z.looseObject({
  type: z.literal('available_commands_update'),
  commands: z.array(z.unknown()).max(4_096),
});

/** Payload de `get_available_models`. */
export const ompAvailableModelsDataSchema = z.looseObject({
  models: z.array(ompModelSchema).max(4_096),
});

// ---------------------------------------------------------------------------
// Frames outbound (stdin do processo omp) — tipos TS (nós construímos, não
// validamos).
// ---------------------------------------------------------------------------

export interface OmpHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema simples do input da tool. */
  parameters: Record<string, unknown>;
}

export type OmpRpcCommand =
  | {
      id?: string;
      type: 'prompt';
      message: string;
      /** Obrigatório durante streaming; sem ele o prompt FALHA. */
      streamingBehavior?: 'steer' | 'followUp';
    }
  | { id?: string; type: 'steer'; message: string }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'get_available_models' }
  | { id?: string; type: 'set_host_tools'; tools: OmpHostToolDefinition[] };

export type OmpExtensionUiResponseFrame =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | {
      type: 'extension_ui_response';
      id: string;
      cancelled: true;
      timedOut?: boolean;
    };

export interface OmpHostToolResultFrame {
  type: 'host_tool_result';
  id: string;
  result: { content: Array<{ type: 'text'; text: string }> };
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Superfície IPC Nexus (renderer ⇄ main) — canais, payloads e eventos push.
// ---------------------------------------------------------------------------

export const OMP_RPC_CHANNELS = {
  start: 'ompRpc:start',
  prompt: 'ompRpc:prompt',
  abort: 'ompRpc:abort',
  setModel: 'ompRpc:setModel',
  getState: 'ompRpc:getState',
  listModels: 'ompRpc:listModels',
  respondUi: 'ompRpc:respondUi',
  dispose: 'ompRpc:dispose',
  /** Live panel + mission rpc-ui sessions (fleet / ops). */
  listSessions: 'ompRpc:listSessions',
  /** Push main → renderer: `{sessionId, event}` já validado/estreitado. */
  event: 'ompRpc:event',
} as const;

export const ompApprovalPolicySchema = z.enum(['yolo', 'safe']);
export type OmpApprovalPolicy = z.infer<typeof ompApprovalPolicySchema>;

export const ompRpcStartRequestSchema = z
  .object({
    /** Precisa viver dentro do escopo de projeto autorizado do renderer. */
    workspaceRoot: z.string().min(1).max(4096).optional(),
    /**
     * Sessões iniciadas pelo renderer são painéis auxiliares sem autoridade
     * de missão. `yolo` é reservado ao scheduler main-owned.
     */
    approvalPolicy: z.literal('safe'),
    model: z
      .object({
        provider: z.string().min(1).max(128),
        modelId: z.string().min(1).max(256),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OmpRpcStartRequest = z.infer<typeof ompRpcStartRequestSchema>;

const sessionRefSchema = z.object({ sessionId: z.string().min(1).max(64) });

export const ompRpcPromptRequestSchema = sessionRefSchema
  .extend({
    message: z.string().min(1).max(200_000),
    /** Como enfileirar quando o agente está streamando (default followUp). */
    behavior: z.enum(['steer', 'followUp']).optional(),
  })
  .strict();
export type OmpRpcPromptRequest = z.infer<typeof ompRpcPromptRequestSchema>;

export const ompRpcSessionRefSchema = sessionRefSchema.strict();
export type OmpRpcSessionRef = z.infer<typeof ompRpcSessionRefSchema>;

export const ompRpcSetModelRequestSchema = sessionRefSchema
  .extend({
    provider: z.string().min(1).max(128),
    modelId: z.string().min(1).max(256),
  })
  .strict();
export type OmpRpcSetModelRequest = z.infer<typeof ompRpcSetModelRequestSchema>;

export const ompRpcUiResponseSchema = z.union([
  z.object({ value: z.string().max(20_000) }).strict(),
  z.object({ confirmed: z.boolean() }).strict(),
  z.object({ cancelled: z.literal(true) }).strict(),
]);
export type OmpRpcUiResponse = z.infer<typeof ompRpcUiResponseSchema>;

export const ompRpcRespondUiRequestSchema = sessionRefSchema
  .extend({
    requestId: z.string().min(1).max(128),
    response: ompRpcUiResponseSchema,
  })
  .strict();
export type OmpRpcRespondUiRequest = z.infer<
  typeof ompRpcRespondUiRequestSchema
>;

/** Estado derivado deterministicamente de agent_start/agent_end + spawn/exit. */
export const ompRpcSessionLifecycleSchema = z.enum([
  'spawning',
  'ready',
  'busy',
  'idle',
  'exited',
]);
export type OmpRpcSessionLifecycle = z.infer<
  typeof ompRpcSessionLifecycleSchema
>;

const pushModelSchema = z
  .object({ provider: z.string(), id: z.string() })
  .strict();

const pushContextUsageSchema = z
  .object({
    tokens: z.number(),
    contextWindow: z.number(),
    percent: z.number(),
  })
  .strict();

/**
 * Eventos push main → renderer, JÁ estreitados (nunca o frame bruto do
 * processo). O renderer valida cada evento com este schema antes de usar.
 */
export const ompRpcPushEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('status'),
      state: ompRpcSessionLifecycleSchema,
      model: pushModelSchema.nullable(),
      contextUsage: pushContextUsageSchema.nullable(),
      isStreaming: z.boolean(),
      sessionName: z.string().nullable(),
      autoApprovals: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('text-delta'), delta: z.string() }).strict(),
  z.object({ kind: z.literal('thinking-delta'), delta: z.string() }).strict(),
  z.object({ kind: z.literal('message-end') }).strict(),
  z
    .object({
      kind: z.literal('tool'),
      toolCallId: z.string(),
      name: z.string(),
      argsPreview: z.string(),
      status: z.enum(['running', 'ok', 'error']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ui-request'),
      requestId: z.string(),
      method: z.enum(['select', 'confirm', 'input', 'editor']),
      title: z.string(),
      message: z.string().nullable(),
      options: z.array(z.string()).nullable(),
      placeholder: z.string().nullable(),
      timeoutMs: z.number().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ui-request-settled'),
      requestId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('auto-approval'),
      requestId: z.string(),
      method: z.string(),
      title: z.string(),
      decision: z.enum(['confirmed', 'selected', 'cancelled']),
      total: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('notice'),
      level: z.enum(['info', 'warning', 'error']),
      message: z.string(),
    })
    .strict(),
  // open_url do CLI (ex.: /login OAuth) — o renderer mostra um link clicável;
  // a abertura passa pelo openExternal validado (https-only) do main.
  z.object({ kind: z.literal('open-url'), url: z.string() }).strict(),
  z.object({ kind: z.literal('exit'), code: z.number().nullable() }).strict(),
]);
export type OmpRpcPushEvent = z.infer<typeof ompRpcPushEventSchema>;

export const ompRpcEventEnvelopeSchema = z
  .object({
    sessionId: z.string().min(1).max(64),
    event: ompRpcPushEventSchema,
  })
  .strict();
export type OmpRpcEventEnvelope = z.infer<typeof ompRpcEventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Resultados IPC + API do preload.
// ---------------------------------------------------------------------------

export interface OmpRpcStartResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

export interface OmpRpcCommandResult {
  ok: boolean;
  error?: string;
}

export interface OmpRpcModelInfo {
  provider: string;
  id: string;
  name?: string;
}

export interface OmpRpcListModelsResult {
  ok: boolean;
  models: OmpRpcModelInfo[];
  error?: string;
}

export interface OmpRpcStateSnapshot {
  state: OmpRpcSessionLifecycle;
  model: { provider: string; id: string } | null;
  contextUsage: { tokens: number; contextWindow: number; percent: number } | null;
  isStreaming: boolean;
  sessionName: string | null;
  approvalPolicy: OmpApprovalPolicy;
  autoApprovals: number;
}

export interface OmpRpcGetStateResult {
  ok: boolean;
  snapshot?: OmpRpcStateSnapshot;
  error?: string;
}

/**
 * API renderer-facing exposta pelo preload como `window.nexus.ompRpc`.
 * O renderer nunca vê o ipcRenderer cru — só este contrato.
 */
export interface OmpRpcSessionSummary {
  sessionId: string;
  paneId: string;
  kind: 'panel' | 'mission';
  title: string;
  missionId?: string;
  state: OmpRpcSessionLifecycle;
  snapshot: OmpRpcStateSnapshot;
}

export interface OmpRpcApi {
  start(request: OmpRpcStartRequest): Promise<OmpRpcStartResult>;
  prompt(
    sessionId: string,
    message: string,
    behavior?: 'steer' | 'followUp',
  ): Promise<OmpRpcCommandResult>;
  abort(sessionId: string): Promise<OmpRpcCommandResult>;
  setModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<OmpRpcCommandResult>;
  getState(sessionId: string): Promise<OmpRpcGetStateResult>;
  listModels(sessionId: string): Promise<OmpRpcListModelsResult>;
  listSessions(): Promise<OmpRpcSessionSummary[]>;
  respondUi(
    sessionId: string,
    requestId: string,
    response: OmpRpcUiResponse,
  ): Promise<OmpRpcCommandResult>;
  dispose(sessionId: string): Promise<OmpRpcCommandResult>;
  onEvent(cb: (envelope: OmpRpcEventEnvelope) => void): () => void;
}
