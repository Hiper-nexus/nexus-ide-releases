import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { buildOmpInheritedKeyEnv } from './omp-provider-keys';
import { StringDecoder } from 'node:string_decoder';
import {
  OMP_PINNED_MAJOR,
  ompAgentEndFrameSchema,
  ompAgentStartFrameSchema,
  ompAvailableModelsDataSchema,
  ompExtensionUiRequestSchema,
  ompHostToolCallFrameSchema,
  ompHostToolCancelFrameSchema,
  ompMessageUpdateFrameSchema,
  ompPromptResultFrameSchema,
  ompResponseFrameSchema,
  ompSessionStateSchema,
  ompToolExecutionEndFrameSchema,
  ompToolExecutionStartFrameSchema,
  type OmpApprovalPolicy,
  type OmpExtensionUiRequest,
  type OmpExtensionUiResponseFrame,
  type OmpHostToolDefinition,
  type OmpHostToolResultFrame,
  type OmpModel,
  type OmpResponseFrame,
  type OmpRpcCommand,
  type OmpRpcModelInfo,
  type OmpRpcPushEvent,
  type OmpRpcSessionLifecycle,
  type OmpRpcStateSnapshot,
  type OmpRpcUiResponse,
} from '../../shared/omp-rpc-types';
import { z } from 'zod';

/**
 * Sessão de agente oh-my-pi de primeira classe: hospeda `omp --mode rpc-ui`
 * como processo filho com PIPES (rpc-ui desliga o PTY) falando NDJSON —
 * nenhum PTY-scraping. O ciclo de vida (spawning|ready|busy|idle|exited) é
 * DERIVADO de agent_start/agent_end + spawn/exit, nunca de heurística de
 * output.
 *
 * Este módulo é main-process puro (node + shared): o roteamento de
 * host-tools pelo dispatcher MCP com token de gate real e a auditoria de
 * auto-aprovações entram por injeção (`OmpRpcSessionDeps`) — a fiação de
 * produção vive em omp-rpc-ipc.ts, e os testes usam um processo fake.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_UI_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 3_000;
const ARGS_PREVIEW_CHARS = 160;
const VERSION_PROBE_TIMEOUT_MS = 8_000;

/** Título de select que representa um prompt de aprovação/permissão. */
const APPROVAL_TITLE_RE = /approval|allow|permission|permitir|autoriza|aprova/i;
/** Opção afirmativa preferida quando um select de aprovação chega em yolo. */
const AFFIRMATIVE_OPTION_RE = /^(approve|allow|yes|sim|permitir|aprovar|ok)\b/i;

const baseFrameSchema = z.looseObject({ type: z.string() });

// ---------------------------------------------------------------------------
// Seams injetáveis (produção em omp-rpc-ipc.ts; testes usam fakes).
// ---------------------------------------------------------------------------

/** Superfície mínima de child_process que a sessão precisa. */
export interface OmpChildLike {
  stdin: { write(data: string): unknown } | null;
  stdout: {
    on(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
  } | null;
  stderr?: {
    on(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  pid?: number;
}

export type OmpSpawnFn = (
  binPath: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => OmpChildLike;

export interface OmpHostToolDispatchResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Decodifica um chunk de stream preservando UTF-8 multibyte que caia num boundary
 * de chunk do pipe. Buffers passam pelo StringDecoder (bufferiza a sequência
 * parcial até completar o code point); strings — de streams com encoding ou de
 * fakes de teste — passam direto.
 */
function decodeStreamChunk(
  decoder: StringDecoder,
  chunk: Buffer | string,
): string {
  return typeof chunk === 'string' ? chunk : decoder.write(chunk);
}

export interface OmpAutoApprovalRecord {
  sessionId: string;
  requestId: string;
  method: string;
  title: string;
  decision: 'confirmed' | 'selected' | 'cancelled';
  detail?: string;
}

export interface OmpRpcSessionDeps {
  /** Tools do host anunciadas via set_host_tools no start. */
  hostTools: OmpHostToolDefinition[];
  /**
   * Roteia um host_tool_call. Em produção passa pelo dispatcher MCP com o
   * token de gate da sessão — NUNCA bypassa allowlist/auditoria.
   */
  dispatchHostTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<OmpHostToolDispatchResult>;
  /**
   * Trilha de auditoria de cada auto-resposta em yolo. Se lançar, a decisão
   * afirmativa vira DENY (auditoria indisponível nunca aprova às cegas).
   */
  auditAutoApproval: (record: OmpAutoApprovalRecord) => void;
  /** Push de eventos já estreitados para o renderer. */
  onPush: (event: OmpRpcPushEvent) => void;
  spawnImpl?: OmpSpawnFn;
  requestTimeoutMs?: number;
  uiResponseTimeoutMs?: number;
  killGraceMs?: number;
}

export interface OmpRpcSessionConfig {
  sessionId: string;
  workspaceRoot: string;
  approvalPolicy: OmpApprovalPolicy;
  binPath: string;
  /** Modelo inicial aplicado via set_model após o ready. */
  model?: { provider: string; modelId: string };
  env?: Record<string, string>;
}

interface PendingRequest {
  command: string;
  resolve(frame: OmpResponseFrame): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface PendingUiRequest {
  method: 'select' | 'confirm' | 'input' | 'editor';
  timer: NodeJS.Timeout | null;
}

// ---------------------------------------------------------------------------
// Resolução do binário (mesma doutrina dos adapters: PATH de login já foi
// dobrado em process.env.PATH pelo path-resolver no bootstrap).
// ---------------------------------------------------------------------------

export interface OmpBinResolution {
  binPath: string;
  version: string | null;
}

type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
  cb: (err: Error | null, stdout: string | Buffer) => void,
) => unknown;

function execText(
  execImpl: ExecFileFn,
  file: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execImpl(
      file,
      args,
      { timeout: VERSION_PROBE_TIMEOUT_MS, env: process.env },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

/** Process-lifetime cache of `omp --version` + path (invalidated on major fail). */
let ompBinCache: { key: string; value: OmpBinResolution } | null = null;

/** Test seam / force re-probe after install. */
export function clearOmpBinCache(): void {
  ompBinCache = null;
}

/**
 * Resolve o caminho absoluto do `omp` (via PATH de login, como os adapters) e
 * valida a versão pinada com `omp --version` — o frame ready não carrega
 * versão, então o handshake de compatibilidade acontece aqui.
 */
export async function resolveOmpBin(
  bin = 'omp',
  execImpl: ExecFileFn = execFile as unknown as ExecFileFn,
): Promise<OmpBinResolution> {
  const cacheKey = bin;
  if (ompBinCache?.key === cacheKey) return ompBinCache.value;

  let binPath = bin;
  if (!bin.includes('/') && !bin.includes('\\')) {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    try {
      const out = await execText(execImpl, lookup, [bin]);
      const first = out.split('\n').map((line) => line.trim()).find(Boolean);
      if (!first) throw new Error('empty which output');
      binPath = first;
    } catch {
      throw new Error(
        `binário "${bin}" não encontrado no PATH — instale com ` +
          'brew install can1357/tap/omp',
      );
    }
  }
  let version: string | null = null;
  try {
    const out = await execText(execImpl, binPath, ['--version']);
    version = /(\d+)\.(\d+)\.(\d+)/.exec(out)?.[0] ?? null;
  } catch (err) {
    throw new Error(
      `omp --version falhou em ${binPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (version) {
    const major = Number(version.split('.')[0]);
    if (Number.isFinite(major) && major !== OMP_PINNED_MAJOR) {
      throw new Error(
        `versão do omp incompatível: encontrado ${version}, o protocolo ` +
          `RPC do Nexus está pinado no major ${OMP_PINNED_MAJOR}`,
      );
    }
  } else {
    // Output sem semver: segue (defensivo contra mudança de formato), mas
    // registra — a validação de major fica impossível.
    console.warn(
      `[omp-rpc] omp --version sem semver reconhecível em ${binPath}; ` +
        'pulando pin de versão',
    );
  }
  const resolved = { binPath, version };
  ompBinCache = { key: cacheKey, value: resolved };
  return resolved;
}

/**
 * Poll until the session leaves `spawning` (ready/idle/busy) or exits.
 * Used by mission-side RPC workers before the first prompt.
 */
export async function waitForOmpSessionReady(
  session: { readonly state: OmpRpcSessionLifecycle },
  timeoutMs = 20_000,
  sleepMs = 40,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.state === 'exited') {
      throw new Error('processo omp encerrou antes de ficar pronto');
    }
    if (session.state !== 'spawning') return;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  throw new Error('timeout aguardando omp --mode rpc-ui ficar pronto');
}

/**
 * Env mínimo para o filho: nada de segredos de outros adapters vaza para o
 * processo (mesma doutrina do allowlist do pty-manager). O omp resolve a
 * própria auth via ~/.omp.
 */
export function buildOmpChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allow = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'COLORTERM',
  ];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && (key.startsWith('LC_') || key.startsWith('XDG_'))) {
      env[key] = value;
    }
  }
  // Herança de chaves do vault (nunca do ambiente): o omp nasce com as API
  // keys que o usuário já guardou no Nexus — zero login extra para elas.
  Object.assign(env, buildOmpInheritedKeyEnv());
  env.NO_COLOR = '1';
  return env;
}

/** Argv do processo: rpc-ui + aprovação SEMPRE no host (always-ask), para que
 * cada aprovação passe pelo auto-responder auditado (yolo) ou pelo usuário
 * (safe) — nunca é decidida silenciosamente dentro do CLI. */
export function ompControlArgs(): string[] {
  return ['--mode', 'rpc-ui', '--approval-mode', 'always-ask'];
}

// ---------------------------------------------------------------------------
// Sessão.
// ---------------------------------------------------------------------------

export class OmpRpcSession {
  readonly sessionId: string;
  readonly approvalPolicy: OmpApprovalPolicy;

  private readonly deps: OmpRpcSessionDeps;
  private readonly config: OmpRpcSessionConfig;
  private readonly proc: OmpChildLike;

  private lifecycle: OmpRpcSessionLifecycle = 'spawning';
  private stdoutBuffer = '';
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private readonly diagnosticTail: string[] = [];
  private reqCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  /** Comandos enfileirados enquanto o frame ready não chega. */
  private readonly preReadyQueue: string[] = [];
  private readonly pendingUi = new Map<string, PendingUiRequest>();
  private readonly cancelledHostCalls = new Set<string>();
  private autoApprovals = 0;
  private lastModel: OmpModel | null = null;
  private lastContextUsage: OmpRpcStateSnapshot['contextUsage'] = null;
  private lastIsStreaming = false;
  private sessionName: string | null = null;
  private exitCode: number | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(config: OmpRpcSessionConfig, deps: OmpRpcSessionDeps) {
    this.sessionId = config.sessionId;
    this.approvalPolicy = config.approvalPolicy;
    this.config = config;
    this.deps = deps;

    const spawnImpl: OmpSpawnFn =
      deps.spawnImpl ??
      ((binPath, args, options) =>
        nodeSpawn(binPath, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: 'pipe',
        }) as unknown as OmpChildLike);

    this.proc = spawnImpl(config.binPath, ompControlArgs(), {
      cwd: config.workspaceRoot,
      env: config.env ?? buildOmpChildEnv(),
    });

    // UTF-8 multibyte pode cair num boundary de chunk do pipe; um StringDecoder
    // próprio bufferiza sequências parciais e só entrega code points completos
    // (senão pt-BR/emoji viram U+FFFD e corrompem tanto o texto exibido quanto os
    // argumentos de host_tool_call roteados ao MCP). Strings (fakes/streams com
    // encoding) passam direto.
    this.proc.stdout?.on('data', (chunk) =>
      this.onStdout(decodeStreamChunk(this.stdoutDecoder, chunk)),
    );
    this.proc.stderr?.on('data', (chunk) => {
      const text = decodeStreamChunk(this.stderrDecoder, chunk).trim();
      if (text) {
        console.warn(`[omp-rpc:${this.sessionId}] stderr: ${text.slice(0, 400)}`);
        this.rememberDiagnostic(text);
      }
    });
    this.proc.on('exit', (code) => this.onExit(code));
    this.proc.on('error', (err) => {
      console.warn(`[omp-rpc:${this.sessionId}] processo falhou:`, err);
      this.push({
        kind: 'notice',
        level: 'error',
        message: `processo omp falhou: ${err.message}`,
      });
      this.onExit(null);
    });
  }

  get state(): OmpRpcSessionLifecycle {
    return this.lifecycle;
  }

  snapshot(): OmpRpcStateSnapshot {
    return {
      state: this.lifecycle,
      model: this.lastModel
        ? { provider: this.lastModel.provider, id: this.lastModel.id }
        : null,
      contextUsage: this.lastContextUsage,
      isStreaming: this.lastIsStreaming,
      sessionName: this.sessionName,
      approvalPolicy: this.approvalPolicy,
      autoApprovals: this.autoApprovals,
    };
  }

  // ------------------------------------------------------------------
  // Comandos.
  // ------------------------------------------------------------------

  /**
   * Prompt com ack imediato (a conclusão do turno chega via agent_end).
   * Durante streaming o protocolo EXIGE streamingBehavior; sem indicação
   * explícita usa followUp (nunca deixa o prompt falhar por omissão).
   */
  async prompt(
    message: string,
    behavior?: 'steer' | 'followUp',
  ): Promise<void> {
    const streaming = this.lifecycle === 'busy' || this.lastIsStreaming;
    const command: OmpRpcCommand = {
      type: 'prompt',
      message,
      ...(streaming || behavior
        ? { streamingBehavior: behavior ?? 'followUp' }
        : {}),
    };
    await this.request(command);
  }

  async abort(): Promise<void> {
    await this.request({ type: 'abort' });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.request({ type: 'set_model', provider, modelId });
    await this.refreshState();
  }

  async listModels(): Promise<OmpRpcModelInfo[]> {
    const response = await this.request({ type: 'get_available_models' });
    const parsed = ompAvailableModelsDataSchema.safeParse(response.data);
    if (!parsed.success) return [];
    return parsed.data.models.map((model) => ({
      provider: model.provider,
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
    }));
  }

  /** Resposta do usuário (modo safe) para um extension_ui_request pendente. */
  respondUi(requestId: string, response: OmpRpcUiResponse): boolean {
    const pending = this.pendingUi.get(requestId);
    if (!pending) return false;
    this.settleUi(requestId);
    this.writeFrame(toUiResponseFrame(requestId, response));
    return true;
  }

  /** SIGTERM → grace → SIGKILL; rejeita pendências e solta o processo. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAllPending(new Error('sessão encerrada'));
    for (const requestId of [...this.pendingUi.keys()]) this.settleUi(requestId);
    if (this.lifecycle === 'exited') return;
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // Processo já morto — o exit handler cuida do resto.
    }
    this.killTimer = setTimeout(() => {
      if (this.lifecycle !== 'exited') {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          // Nada a salvar.
        }
      }
    }, this.deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    this.killTimer.unref?.();
  }

  // ------------------------------------------------------------------
  // Transporte NDJSON.
  // ------------------------------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        // Linha inválida: registra e segue — o parser nunca derruba a sessão.
        // É aqui que caem mensagens humanas do CLI ("No models available.
        // Use /login…") — o tail vira diagnóstico visível se o processo sair.
        this.rememberDiagnostic(trimmed);
        console.warn(
          `[omp-rpc:${this.sessionId}] linha NDJSON inválida ignorada: ` +
            trimmed.slice(0, 200),
        );
        continue;
      }
      try {
        this.routeFrame(value);
      } catch (err) {
        console.warn(`[omp-rpc:${this.sessionId}] frame não processado:`, err);
      }
    }
  }

  private writeFrame(frame: object): void {
    try {
      this.proc.stdin?.write(`${JSON.stringify(frame)}\n`);
    } catch (err) {
      console.warn(`[omp-rpc:${this.sessionId}] escrita no stdin falhou:`, err);
    }
  }

  private request(command: OmpRpcCommand): Promise<OmpResponseFrame> {
    if (this.lifecycle === 'exited' || this.disposed) {
      return Promise.reject(new Error('sessão omp encerrada'));
    }
    this.reqCounter += 1;
    const id = `req_${this.reqCounter}`;
    const line = `${JSON.stringify({ ...command, id })}\n`;
    return new Promise<OmpResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout aguardando resposta de ${command.type}`));
      }, this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      if (this.lifecycle === 'spawning') {
        // Ainda sem ready: enfileira — o flush acontece no frame ready.
        this.preReadyQueue.push(line);
      } else {
        try {
          this.proc.stdin?.write(line);
        } catch (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.preReadyQueue.length = 0;
  }

  // ------------------------------------------------------------------
  // Roteamento de frames.
  // ------------------------------------------------------------------

  private routeFrame(value: unknown): void {
    const base = baseFrameSchema.safeParse(value);
    if (!base.success) {
      console.warn(
        `[omp-rpc:${this.sessionId}] frame sem "type" string ignorado`,
      );
      return;
    }
    switch (base.data.type) {
      case 'ready':
        this.onReady();
        return;
      case 'response': {
        const parsed = ompResponseFrameSchema.safeParse(value);
        if (parsed.success) this.onResponse(parsed.data);
        return;
      }
      case 'agent_start': {
        if (ompAgentStartFrameSchema.safeParse(value).success) {
          this.lifecycle = 'busy';
          this.lastIsStreaming = true;
          this.pushStatus();
        }
        return;
      }
      case 'agent_end': {
        if (ompAgentEndFrameSchema.safeParse(value).success) {
          this.lifecycle = 'idle';
          this.lastIsStreaming = false;
          this.pushStatus();
          // contextUsage/model podem ter mudado durante o turno.
          void this.refreshState();
        }
        return;
      }
      case 'message_update': {
        const parsed = ompMessageUpdateFrameSchema.safeParse(value);
        if (!parsed.success) return;
        const event = parsed.data.assistantMessageEvent;
        if (event.type === 'text_delta' && typeof event.delta === 'string') {
          this.push({ kind: 'text-delta', delta: event.delta });
        } else if (
          event.type === 'thinking_delta' &&
          typeof event.delta === 'string'
        ) {
          this.push({ kind: 'thinking-delta', delta: event.delta });
        }
        return;
      }
      case 'message_end':
        this.push({ kind: 'message-end' });
        return;
      case 'tool_execution_start': {
        const parsed = ompToolExecutionStartFrameSchema.safeParse(value);
        if (!parsed.success) return;
        this.push({
          kind: 'tool',
          toolCallId: parsed.data.toolCallId,
          name: parsed.data.toolName,
          argsPreview: previewArgs(parsed.data.args),
          status: 'running',
        });
        return;
      }
      case 'tool_execution_end': {
        const parsed = ompToolExecutionEndFrameSchema.safeParse(value);
        if (!parsed.success) return;
        this.push({
          kind: 'tool',
          toolCallId: parsed.data.toolCallId,
          name: parsed.data.toolName,
          argsPreview: '',
          status: parsed.data.isError === true ? 'error' : 'ok',
        });
        return;
      }
      case 'extension_ui_request': {
        const parsed = ompExtensionUiRequestSchema.safeParse(value);
        if (parsed.success) this.onUiRequest(parsed.data);
        return;
      }
      case 'host_tool_call': {
        const parsed = ompHostToolCallFrameSchema.safeParse(value);
        if (parsed.success) {
          void this.onHostToolCall(
            parsed.data.id,
            parsed.data.toolName,
            parsed.data.arguments,
          );
        }
        return;
      }
      case 'host_tool_cancel': {
        const parsed = ompHostToolCancelFrameSchema.safeParse(value);
        if (parsed.success) this.cancelledHostCalls.add(parsed.data.targetId);
        return;
      }
      case 'prompt_result': {
        const parsed = ompPromptResultFrameSchema.safeParse(value);
        if (parsed.success && !parsed.data.agentInvoked) {
          // Prompt local-only: nunca haverá agent_end para este turno.
          if (this.lifecycle === 'busy') {
            this.lifecycle = 'idle';
            this.lastIsStreaming = false;
            this.pushStatus();
          }
        }
        return;
      }
      default:
        // Frames fora do subconjunto consumido (subagentes, comandos, etc.)
        // são ignorados por contrato.
        return;
    }
  }

  private onReady(): void {
    if (this.lifecycle !== 'spawning') return;
    this.lifecycle = 'ready';
    for (const line of this.preReadyQueue.splice(0)) {
      try {
        this.proc.stdin?.write(line);
      } catch (err) {
        console.warn(`[omp-rpc:${this.sessionId}] flush pós-ready falhou:`, err);
      }
    }
    this.pushStatus();
    void this.bootstrap();
  }

  /** set_host_tools → set_model opcional → get_state; então a sessão é idle. */
  private async bootstrap(): Promise<void> {
    try {
      if (this.deps.hostTools.length > 0) {
        await this.request({
          type: 'set_host_tools',
          tools: this.deps.hostTools,
        });
      }
      if (this.config.model) {
        await this.request({
          type: 'set_model',
          provider: this.config.model.provider,
          modelId: this.config.model.modelId,
        });
      }
      await this.refreshState();
    } catch (err) {
      console.warn(`[omp-rpc:${this.sessionId}] bootstrap falhou:`, err);
      this.push({
        kind: 'notice',
        level: 'warning',
        message: `bootstrap da sessão omp incompleto: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    if (this.lifecycle === 'ready') {
      this.lifecycle = this.lastIsStreaming ? 'busy' : 'idle';
      this.pushStatus();
    }
  }

  private onResponse(frame: OmpResponseFrame): void {
    if (!frame.id) return; // respostas sem id (parse/unknown) não correlacionam
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.command === 'get_state' && frame.success) {
      this.applyStateData(frame.data);
    }
    if (frame.success) pending.resolve(frame);
    else {
      pending.reject(
        new Error(frame.error ?? `${pending.command} falhou sem detalhe`),
      );
    }
  }

  private async refreshState(): Promise<void> {
    if (this.lifecycle === 'exited' || this.disposed) return;
    try {
      await this.request({ type: 'get_state' });
      this.pushStatus();
    } catch (err) {
      console.warn(`[omp-rpc:${this.sessionId}] get_state falhou:`, err);
    }
  }

  private applyStateData(data: unknown): void {
    const parsed = ompSessionStateSchema.safeParse(data);
    if (!parsed.success) return;
    this.lastModel = parsed.data.model ?? this.lastModel;
    this.lastContextUsage = parsed.data.contextUsage
      ? {
          tokens: parsed.data.contextUsage.tokens,
          contextWindow: parsed.data.contextUsage.contextWindow,
          percent: parsed.data.contextUsage.percent,
        }
      : this.lastContextUsage;
    this.lastIsStreaming = parsed.data.isStreaming;
    this.sessionName = parsed.data.sessionName ?? this.sessionName;
    // isStreaming corrige deriva se algum agent_start/agent_end se perdeu.
    if (this.lifecycle === 'busy' && !parsed.data.isStreaming) {
      this.lifecycle = 'idle';
    } else if (this.lifecycle === 'idle' && parsed.data.isStreaming) {
      this.lifecycle = 'busy';
    }
  }

  /** Últimas linhas humanas (stderr + stdout não-NDJSON) — o motivo REAL de
   * uma morte prematura, que antes era engolido ("código 1" seco). */
  private rememberDiagnostic(text: string): void {
    this.diagnosticTail.push(text.slice(0, 300));
    if (this.diagnosticTail.length > 6) this.diagnosticTail.shift();
  }

  private onExit(code: number | null): void {
    if (this.lifecycle === 'exited') return;
    this.lifecycle = 'exited';
    this.exitCode = code;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.rejectAllPending(new Error('processo omp encerrou'));
    for (const requestId of [...this.pendingUi.keys()]) this.settleUi(requestId);
    if (code !== null && code !== 0 && this.diagnosticTail.length > 0) {
      this.push({
        kind: 'notice',
        level: 'error',
        message: `omp saiu com código ${code}: ${this.diagnosticTail.join(' · ')}`,
      });
    }
    this.push({ kind: 'exit', code: this.exitCode });
  }

  // ------------------------------------------------------------------
  // Aprovações (extension_ui_request).
  // ------------------------------------------------------------------

  private onUiRequest(request: OmpExtensionUiRequest): void {
    switch (request.method) {
      case 'select':
      case 'confirm':
      case 'input':
      case 'editor':
        break;
      case 'cancel': {
        // O emissor desistiu do dialog alvo — encerra a pendência local.
        if (request.targetId && this.pendingUi.has(request.targetId)) {
          this.settleUi(request.targetId);
        }
        return;
      }
      case 'notify': {
        this.push({
          kind: 'notice',
          level: request.notifyType ?? 'info',
          message: request.message ?? '',
        });
        return;
      }
      case 'open_url': {
        // Um /login OAuth do CLI chega aqui. Virar notice mataria o fluxo (o
        // navegador nunca abria e o login nunca completava); o renderer mostra
        // a URL como link clicável que abre via openExternal validado.
        if (request.url) {
          this.push({ kind: 'open-url', url: request.url });
        } else {
          this.push({
            kind: 'notice',
            level: 'warning',
            message: 'abrir URL solicitado sem URL — pedido ignorado',
          });
        }
        return;
      }
      default:
        // setStatus/setWidget/setTitle/set_editor_text: superfícies de TUI
        // sem equivalente no painel — ignorados por contrato.
        return;
    }

    if (this.approvalPolicy === 'yolo') {
      this.autoRespond(request);
      return;
    }

    // Modo safe: encaminha ao renderer e espera com timeout (deny por default).
    const timeoutMs =
      typeof request.timeout === 'number' && request.timeout > 0
        ? request.timeout
        : this.deps.uiResponseTimeoutMs ?? DEFAULT_UI_RESPONSE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (!this.pendingUi.has(request.id)) return;
      this.settleUi(request.id);
      this.writeFrame({
        type: 'extension_ui_response',
        id: request.id,
        cancelled: true,
        timedOut: true,
      } satisfies OmpExtensionUiResponseFrame);
      this.push({
        kind: 'notice',
        level: 'warning',
        message: `aprovação "${request.title ?? request.method}" expirou sem resposta (negada)`,
      });
    }, timeoutMs);
    timer.unref?.();
    this.pendingUi.set(request.id, { method: request.method, timer });
    this.push({
      kind: 'ui-request',
      requestId: request.id,
      method: request.method,
      title: request.title ?? request.method,
      message: request.message ?? null,
      options: request.options ?? null,
      placeholder: request.placeholder ?? null,
      timeoutMs,
    });
  }

  /**
   * Auto-resposta em yolo: confirm aprova; select de aprovação escolhe a
   * opção afirmativa; input/editor cancelam (não existe resposta genérica).
   * CADA decisão é gravada na trilha de auditoria ANTES de responder — se a
   * auditoria estiver indisponível, decisões afirmativas degradam para DENY.
   */
  private autoRespond(request: OmpExtensionUiRequest): void {
    const title = request.title ?? request.method;
    let decision: OmpAutoApprovalRecord['decision'] = 'cancelled';
    let response: OmpExtensionUiResponseFrame = {
      type: 'extension_ui_response',
      id: request.id,
      cancelled: true,
    };
    let detail: string | undefined;

    if (request.method === 'confirm') {
      decision = 'confirmed';
      response = {
        type: 'extension_ui_response',
        id: request.id,
        confirmed: true,
      };
    } else if (
      request.method === 'select' &&
      APPROVAL_TITLE_RE.test(title) &&
      Array.isArray(request.options) &&
      request.options.length > 0
    ) {
      const pick =
        request.options.find((option) => AFFIRMATIVE_OPTION_RE.test(option)) ??
        request.options[0];
      decision = 'selected';
      detail = pick;
      response = { type: 'extension_ui_response', id: request.id, value: pick };
    }

    try {
      this.deps.auditAutoApproval({
        sessionId: this.sessionId,
        requestId: request.id,
        method: request.method,
        title,
        decision,
        detail,
      });
    } catch (err) {
      // Sem auditoria não há aprovação automática: degrada para deny.
      console.warn(
        `[omp-rpc:${this.sessionId}] auditoria indisponível; auto-aprovação negada:`,
        err,
      );
      this.writeFrame({
        type: 'extension_ui_response',
        id: request.id,
        cancelled: true,
      } satisfies OmpExtensionUiResponseFrame);
      this.push({
        kind: 'notice',
        level: 'error',
        message: `aprovação "${title}" negada: trilha de auditoria indisponível`,
      });
      return;
    }

    if (decision !== 'cancelled') this.autoApprovals += 1;
    this.writeFrame(response);
    this.push({
      kind: 'auto-approval',
      requestId: request.id,
      method: request.method,
      title,
      decision,
      total: this.autoApprovals,
    });
  }

  private settleUi(requestId: string): void {
    const pending = this.pendingUi.get(requestId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingUi.delete(requestId);
    this.push({ kind: 'ui-request-settled', requestId });
  }

  // ------------------------------------------------------------------
  // Host tools → dispatcher MCP.
  // ------------------------------------------------------------------

  private async onHostToolCall(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    let frame: OmpHostToolResultFrame;
    if (!this.deps.hostTools.some((tool) => tool.name === toolName)) {
      frame = hostToolResult(callId, `host tool desconhecida: ${toolName}`, true);
    } else {
      let outcome: OmpHostToolDispatchResult;
      try {
        outcome = await this.deps.dispatchHostTool(toolName, args);
      } catch (err) {
        outcome = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      frame = outcome.ok
        ? hostToolResult(callId, stringifyResult(outcome.result), false)
        : hostToolResult(callId, outcome.error ?? 'tool falhou', true);
    }
    if (this.cancelledHostCalls.delete(callId)) return; // abortada pelo servidor
    if (this.lifecycle === 'exited' || this.disposed) return;
    this.writeFrame(frame);
  }

  // ------------------------------------------------------------------
  // Push.
  // ------------------------------------------------------------------

  private push(event: OmpRpcPushEvent): void {
    try {
      this.deps.onPush(event);
    } catch (err) {
      console.warn(`[omp-rpc:${this.sessionId}] push falhou:`, err);
    }
  }

  private pushStatus(): void {
    this.push({
      kind: 'status',
      state: this.lifecycle,
      model: this.lastModel
        ? { provider: this.lastModel.provider, id: this.lastModel.id }
        : null,
      contextUsage: this.lastContextUsage,
      isStreaming: this.lastIsStreaming,
      sessionName: this.sessionName,
      autoApprovals: this.autoApprovals,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers puros.
// ---------------------------------------------------------------------------

function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    const text = JSON.stringify(args);
    return text.length > ARGS_PREVIEW_CHARS
      ? `${text.slice(0, ARGS_PREVIEW_CHARS)}…`
      : text;
  } catch {
    return '[args não serializáveis]';
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result ?? null, null, 2);
  } catch {
    return String(result);
  }
}

function hostToolResult(
  id: string,
  text: string,
  isError: boolean,
): OmpHostToolResultFrame {
  return {
    type: 'host_tool_result',
    id,
    result: { content: [{ type: 'text', text }] },
    ...(isError ? { isError: true } : {}),
  };
}

function toUiResponseFrame(
  id: string,
  response: OmpRpcUiResponse,
): OmpExtensionUiResponseFrame {
  if ('value' in response) {
    return { type: 'extension_ui_response', id, value: response.value };
  }
  if ('confirmed' in response) {
    return { type: 'extension_ui_response', id, confirmed: response.confirmed };
  }
  return { type: 'extension_ui_response', id, cancelled: true };
}
