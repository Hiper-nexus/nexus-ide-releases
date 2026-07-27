import { execFile, spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildOmpSelectedProviderKeyEnv } from './omp-provider-keys';
import { StringDecoder } from 'node:string_decoder';
import {
  OMP_RPC_SUPPORTED_VERSION,
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
import {
  mintOmpRpcPhysicalHostCall,
  type OmpRpcPhysicalHostCall,
} from '../orch/http-mcp-boundary';
import { governedOmpArgs } from '../orch/governed-cli-profile';
import {
  captureDescendantSnapshot,
  terminatePtyProcessTree,
  type DescendantSnapshot,
  type ProcessTableRow,
  type PtyProcessTreeTerminationProof,
} from '../pty/pty-descendant-termination';
import {
  currentDarwinPtySupervisorRuntime,
  isProvenDarwinPtySupervisorExit,
  supervisedPtyCommand,
} from '../pty/darwin-pty-supervisor';
import { OmpChildOutputRedactor } from './omp-output-redaction';

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
/** Hard transport budgets: the child is not a trusted memory authority. */
export const OMP_RPC_MAX_FRAME_CHARS = 1_048_576;
export const OMP_RPC_MAX_PENDING_REQUESTS = 512;
export const OMP_RPC_MAX_PRE_READY_BYTES = 8 * 1_048_576;
export const OMP_RPC_MAX_PENDING_UI = 256;
export const OMP_RPC_MAX_CANCELLED_HOST_CALLS = 4_096;
export const OMP_RPC_MAX_ACTIVE_HOST_CALLS = 128;

/** Título de select que representa um prompt de aprovação/permissão. */
const APPROVAL_TITLE_RE = /approval|allow|permission|permitir|autoriza|aprova/i;
/** Opção afirmativa preferida quando um select de aprovação chega em yolo. */
const AFFIRMATIVE_OPTION_RE = /^(approve|allow|yes|sim|permitir|aprovar|ok)\b/i;

const baseFrameSchema = z.looseObject({ type: z.string().max(64) });

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
  on(
    event: 'exit',
    cb: (
      code: number | null,
      signal?: NodeJS.Signals | number | null,
    ) => void,
  ): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  pid?: number;
}

export type OmpSpawnFn = (
  binPath: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    /** Dedicated POSIX session/process group used as a durable lineage fence. */
    detached: boolean;
  },
) => OmpChildLike;

export interface OmpProcessTreeTerminationInput {
  readonly rootPid: number;
  readonly ownsRoot: () => boolean;
  readonly killRoot: (signal: 'SIGTERM' | 'SIGKILL') => void;
  readonly rootExited: Promise<void>;
}

export interface OmpProcessTreeTerminationOptions {
  readonly platform?: NodeJS.Platform;
  readonly snapshotTimeoutMs?: number;
  readonly termTimeoutMs?: number;
  readonly killTimeoutMs?: number;
}

export type OmpProcessTreeTerminator = (
  input: OmpProcessTreeTerminationInput,
  options?: OmpProcessTreeTerminationOptions,
) => Promise<PtyProcessTreeTerminationProof>;

export type OmpProcessTreeCapture = (
  rootPid: number,
) => Promise<DescendantSnapshot | null>;

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
    physicalCall: OmpRpcPhysicalHostCall,
  ) => Promise<OmpHostToolDispatchResult>;
  /**
   * Trilha de auditoria de cada auto-resposta em yolo. Se lançar, a decisão
   * afirmativa vira DENY (auditoria indisponível nunca aprova às cegas).
   */
  auditAutoApproval: (record: OmpAutoApprovalRecord) => void;
  /** Push de eventos já estreitados para o renderer. */
  onPush: (event: OmpRpcPushEvent) => void;
  spawnImpl?: OmpSpawnFn;
  /**
   * Test seam for the production/default spawn path. Unlike `spawnImpl`, this
   * preserves the native-supervisor receipt contract.
   */
  defaultSpawnImplForTest?: OmpSpawnFn;
  /** Test seam paired with `defaultSpawnImplForTest`. */
  runtimePlatformForTest?: NodeJS.Platform;
  requestTimeoutMs?: number;
  uiResponseTimeoutMs?: number;
  killGraceMs?: number;
  /** Test seam; production reuses the authority-critical PTY tree inventory. */
  terminateProcessTree?: OmpProcessTreeTerminator;
  /** Test seam for the same bounded process-table inventory. */
  captureProcessTree?: OmpProcessTreeCapture;
  processInventoryIntervalMs?: number;
}

export interface OmpRpcSessionConfig {
  sessionId: string;
  workspaceRoot: string;
  approvalPolicy: OmpApprovalPolicy;
  binPath: string;
  /**
   * Governed mission workers must not inherit user-installed extensions,
   * rules or skills. Direct/panel sessions intentionally keep the user's full
   * OMP profile and therefore leave this unset.
   */
  governed?: boolean;
  /** Modelo inicial aplicado via set_model após o ready. */
  model?: { provider: string; modelId: string };
  env?: Record<string, string>;
  /**
   * Exact main-owned credential values for child-output redaction. Values stay
   * inside the session object and are never serialized, logged or rendered.
   */
  credentialSecrets?: readonly string[];
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

interface PendingAgentStart {
  requestId: string;
  acked: boolean;
  started: boolean;
  resolve(): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Binary resolution — same doctrine as the adapters (isBinInstalled in
// adapter-registry.ts): fast `which` against process.env.PATH first (the
// login-shell PATH is folded into it once at bootstrap by path-resolver);
// on a miss, re-resolve the login-shell PATH LIVE and retry. The live retry
// matters because the boot-time fold is one-shot: a `brew install` that
// lands afterwards is invisible to process.env.PATH until the next launch.
// ---------------------------------------------------------------------------

export interface OmpBinResolution {
  binPath: string;
  version: string;
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execImpl(
      file,
      args,
      { timeout: VERSION_PROBE_TIMEOUT_MS, env },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

/** Well-known install dirs, mirroring COMMON_MAC_LINUX_PATHS in adapter-registry. */
const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
];

/**
 * Resolve the login-shell PATH live — deliberately NOT memoised, so a
 * `brew install` that just finished is visible on the very next probe.
 * The shell probe rides the injected execImpl to stay fakeable in tests.
 */
async function probeLoginShellPath(execImpl: ExecFileFn): Promise<string> {
  if (process.platform === 'win32') return process.env.PATH ?? '';
  const shell = process.env.SHELL ?? '/bin/bash';
  let resolved = process.env.PATH ?? '';
  try {
    const out = await execText(execImpl, shell, [
      '-l',
      '-c',
      'printf "%s" "$PATH"',
    ]);
    resolved = out.trim() || resolved;
  } catch {
    // Heavy profiles timing out must not lock out standard installations.
  }
  const parts = resolved.split(path.delimiter).filter(Boolean);
  for (const dir of COMMON_BIN_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(path.delimiter);
}

/** `which`/`where` lookup: absolute path of the first hit, null on any miss. */
async function whichBin(
  execImpl: ExecFileFn,
  bin: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = await execText(execImpl, lookup, [bin], env);
    return (
      out
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
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
  // The env that actually located the binary — reused for `omp --version`
  // so the probe runs against the same PATH that proved the binary exists.
  let effectiveEnv: NodeJS.ProcessEnv = process.env;
  if (!bin.includes('/') && !bin.includes('\\')) {
    let found = await whichBin(execImpl, bin, process.env);
    if (!found && process.platform !== 'win32') {
      // Fast lookup missed. The boot-time PATH fold is one-shot, so an omp
      // installed after launch (fresh Homebrew, new tap) is invisible here —
      // re-resolve the login-shell PATH live and retry, the same fallback
      // isBinInstalled() applies to every other adapter.
      const loginPath = await probeLoginShellPath(execImpl);
      if (loginPath && loginPath !== (process.env.PATH ?? '')) {
        const loginEnv = { ...process.env, PATH: loginPath };
        found = await whichBin(execImpl, bin, loginEnv);
        if (found) effectiveEnv = loginEnv;
      }
    }
    if (!found) {
      throw new Error(
        `binário "${bin}" não encontrado no PATH — instale com ` +
          'brew install can1357/tap/omp',
      );
    }
    binPath = found;
  }
  let version: string | null = null;
  try {
    const out = await execText(execImpl, binPath, ['--version'], effectiveEnv);
    version =
      /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(
        out,
      )?.[1] ?? null;
  } catch (err) {
    throw new Error(
      `omp --version falhou em ${binPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!version) {
    throw new Error(
      'omp --version não informou uma versão semântica reconhecível. ' +
        `Ação: reinstale ou ative o omp ${OMP_RPC_SUPPORTED_VERSION} e tente novamente.`,
    );
  }
  if (version !== OMP_RPC_SUPPORTED_VERSION) {
    throw new Error(
      `versão do omp incompatível com o RPC do Nexus: encontrado ${version}; ` +
        `suportado ${OMP_RPC_SUPPORTED_VERSION}. Ação: instale ou ative o omp ` +
        `${OMP_RPC_SUPPORTED_VERSION} e tente novamente.`,
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
  session: {
    readonly state: OmpRpcSessionLifecycle;
    readonly bootstrapStatus?: 'pending' | 'ready' | 'failed';
    readonly bootstrapError?: string | null;
  },
  timeoutMs = 20_000,
  sleepMs = 40,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.state === 'exited') {
      throw new Error('processo omp encerrou antes de ficar pronto');
    }
    if (session.bootstrapStatus === 'failed') {
      throw new Error(
        `bootstrap omp falhou: ${session.bootstrapError ?? 'erro desconhecido'}`,
      );
    }
    if (
      session.state === 'idle' &&
      (session.bootstrapStatus === undefined ||
        session.bootstrapStatus === 'ready')
    )
      return;
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
  model?: string | null,
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
    if (
      typeof value === 'string' &&
      (key.startsWith('LC_') || key.startsWith('XDG_'))
    ) {
      env[key] = value;
    }
  }
  // Credenciais nunca são herdadas do ambiente e jamais fazem fan-out do
  // vault. Quando há um modelo exato, entra somente a família de chave
  // release-pinned daquele provider. Sem modelo (auth-broker/list/token), não
  // entra nenhuma launcher key.
  Object.assign(env, buildOmpSelectedProviderKeyEnv(model));
  env.NO_COLOR = '1';
  return env;
}

/** Argv do processo: rpc-ui + aprovação SEMPRE no host (always-ask), para que
 * cada aprovação passe pelo auto-responder auditado (yolo) ou pelo usuário
 * (safe) — nunca é decidida silenciosamente dentro do CLI. */
export function ompControlArgs(governed = false): string[] {
  return [
    '--mode',
    'rpc-ui',
    '--approval-mode',
    'always-ask',
    ...(governed ? governedOmpArgs([]) : []),
  ];
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
  private readonly darwinResponsibilitySupervisor: boolean;
  private readonly childOutputRedactor: OmpChildOutputRedactor;

  private lifecycle: OmpRpcSessionLifecycle = 'spawning';
  private stdoutBuffer = '';
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private readonly diagnosticTail: string[] = [];
  private reqCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  /** Comandos enfileirados enquanto o frame ready não chega. */
  private readonly preReadyQueue = new Map<string, string>();
  private preReadyBytes = 0;
  private readonly pendingUi = new Map<string, PendingUiRequest>();
  private readonly cancelledHostCalls = new Set<string>();
  private readonly activeHostCalls = new Set<string>();
  private autoApprovals = 0;
  private lastModel: OmpModel | null = null;
  private lastContextUsage: OmpRpcStateSnapshot['contextUsage'] = null;
  private lastIsStreaming = false;
  private sessionName: string | null = null;
  private exitCode: number | null = null;
  private disposed = false;
  private physicalRootExited = false;
  private physicalRootSignal: NodeJS.Signals | number | null | undefined;
  /** Spawn emitted `error` before Node assigned any OS process identity. */
  private childNeverSpawned = false;
  private resolvePhysicalRootExit!: () => void;
  private readonly physicalRootExit = new Promise<void>((resolve) => {
    this.resolvePhysicalRootExit = resolve;
  });
  private terminationFlight: Promise<PtyProcessTreeTerminationProof> | null =
    null;
  private successfulTermination: PtyProcessTreeTerminationProof | null = null;
  private initialInventoryFlight: Promise<DescendantSnapshot | null> | null =
    null;
  private initialPhysicalSnapshot: DescendantSnapshot | null = null;
  private readonly trackedPhysicalRows = new Map<string, ProcessTableRow>();
  private readonly authorizedSessionIds = new Set<number>();
  private readonly authorizedProcessGroups = new Set<number>();
  private readonly authorizedTerminals = new Set<string>();
  private inventoryCompromised = false;
  private inventoryTimer: NodeJS.Timeout | null = null;
  private bootstrapLifecycle: 'pending' | 'ready' | 'failed' = 'pending';
  private bootstrapFailure: string | null = null;
  private pendingAgentStart: PendingAgentStart | null = null;

  constructor(config: OmpRpcSessionConfig, deps: OmpRpcSessionDeps) {
    this.sessionId = config.sessionId;
    this.approvalPolicy = config.approvalPolicy;
    this.config = config;
    this.deps = deps;

    const runtimePlatform =
      deps.runtimePlatformForTest ?? process.platform;
    this.darwinResponsibilitySupervisor =
      deps.spawnImpl === undefined && runtimePlatform === 'darwin';
    const defaultSpawnImpl: OmpSpawnFn =
      deps.defaultSpawnImplForTest ??
      ((binPath, args, options) => {
        const command = supervisedPtyCommand(
          currentDarwinPtySupervisorRuntime(__dirname),
          binPath,
          args,
        );
        return nodeSpawn(command.file, command.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: 'pipe',
          detached: options.detached,
        }) as unknown as OmpChildLike;
      });
    const spawnImpl: OmpSpawnFn =
      deps.spawnImpl ?? defaultSpawnImpl;
    const childEnv =
      config.env ??
      buildOmpChildEnv(
        process.env,
        config.model
          ? `${config.model.provider}/${config.model.modelId}`
          : undefined,
      );
    this.childOutputRedactor = new OmpChildOutputRedactor(
      config.credentialSecrets,
      childEnv,
    );

    this.proc = spawnImpl(config.binPath, ompControlArgs(config.governed), {
      cwd: config.workspaceRoot,
      env: childEnv,
      // The dedicated POSIX session/process group gives natural exits a
      // durable lineage boundary even after the root has been reaped.
      detached: runtimePlatform !== 'win32',
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
      if (this.disposed || this.lifecycle === 'exited') return;
      const text = this.childOutputRedactor.stream(
        'stderr',
        decodeStreamChunk(this.stderrDecoder, chunk),
      ).trim();
      if (text) {
        console.warn(
          `[omp-rpc:${this.sessionId}] stderr: ${text.slice(0, 400)}`,
        );
        this.rememberDiagnostic(text);
      }
    });
    this.proc.on('exit', (code, signal) =>
      this.onExit(code, true, signal),
    );
    this.proc.on('error', (err) => {
      const safeMessage = this.redactChildText(err.message);
      console.warn(
        `[omp-rpc:${this.sessionId}] processo falhou: ${safeMessage}`,
      );
      this.push({
        kind: 'notice',
        level: 'error',
        message: `processo omp falhou: ${safeMessage}`,
      });
      // ENOENT/EACCES-style spawn failures have no OS PID and therefore no
      // possible descendant tree. This is explicit proof that the child never
      // existed. Errors after a PID was assigned remain fail-closed until the
      // exact exit callback and process inventory prove physical teardown.
      if (this.physicalRootPid() === null && !this.physicalRootExited) {
        this.childNeverSpawned = true;
        this.physicalRootExited = true;
        this.resolvePhysicalRootExit();
        if (this.inventoryTimer) {
          clearTimeout(this.inventoryTimer);
          this.inventoryTimer = null;
        }
      }
      this.onExit(null, false);
    });
    if (!this.darwinResponsibilitySupervisor) {
      this.initialInventoryFlight = this.captureAndTrackPhysicalInventory();
      void this.initialInventoryFlight.finally(() => {
        this.schedulePhysicalInventoryRefresh();
      });
    }
  }

  get state(): OmpRpcSessionLifecycle {
    return this.lifecycle;
  }

  get bootstrapStatus(): 'pending' | 'ready' | 'failed' {
    return this.bootstrapLifecycle;
  }

  get bootstrapError(): string | null {
    return this.bootstrapFailure;
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

  /**
   * Mission-worker submit contract: an RPC response is only transport ACK.
   * Return solely after the exact idle session emits a real agent_start.
   */
  async promptAndWaitForAgentStart(
    message: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    if (this.lifecycle !== 'idle' || this.bootstrapLifecycle !== 'ready') {
      throw new Error(
        'sessão omp precisa estar idle e com bootstrap concluído',
      );
    }
    if (this.pendingAgentStart) {
      throw new Error(
        'já existe um prompt aguardando agent_start nesta sessão omp',
      );
    }
    const command: OmpRpcCommand = { type: 'prompt', message };
    let requestId = '';
    let resolveStart!: () => void;
    let rejectStart!: (error: Error) => void;
    const startPromise = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    // A prompt_result may reject before the transport ACK arrives. Attach a
    // noop observer immediately; the method still awaits the same promise.
    void startPromise.catch(() => {});
    try {
      const response = await this.request(command, (issuedId) => {
        requestId = issuedId;
        const timer = setTimeout(() => {
          if (this.pendingAgentStart?.requestId !== issuedId) return;
          this.settlePendingAgentStart(
            new Error(
              'O worker OMP recebeu o prompt, mas não iniciou o agente a tempo.',
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        this.pendingAgentStart = {
          requestId: issuedId,
          acked: false,
          started: false,
          resolve: resolveStart,
          reject: rejectStart,
          timer,
        };
      });
      const data = response.data;
      if (
        data &&
        typeof data === 'object' &&
        (data as { agentInvoked?: unknown }).agentInvoked === false
      ) {
        this.settlePendingAgentStart(
          new Error('O prompt OMP foi local-only e não iniciou o agente.'),
        );
      }
      const pending = this.readPendingAgentStart();
      if (pending?.requestId === requestId) {
        pending.acked = true;
        if (pending.started) this.settlePendingAgentStart();
      }
      await startPromise;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (this.readPendingAgentStart()?.requestId === requestId) {
        this.settlePendingAgentStart(normalized);
      }
      throw normalized;
    }
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
      provider: this.redactChildText(model.provider),
      id: this.redactChildText(model.id),
      ...(model.name
        ? { name: this.redactChildText(model.name) }
        : {}),
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

  /**
   * Begin logical revocation and physical process-tree termination.
   *
   * Success is authority-critical: it comes only from the shared process
   * inventory proving both the exact root callback and every captured/late
   * descendant absent. Callers may retry a failed proof, but failure never
   * turns into synthetic success.
   */
  async terminate(
    options: OmpProcessTreeTerminationOptions = {},
  ): Promise<PtyProcessTreeTerminationProof> {
    if (this.successfulTermination) return this.successfulTermination;
    if (this.terminationFlight) return this.terminationFlight;
    this.beginLogicalDispose();
    const root = this.proc;
    const rootPid =
      typeof root.pid === 'number' && Number.isInteger(root.pid)
        ? root.pid
        : -1;
    const terminateProcessTree: OmpProcessTreeTerminator =
      this.deps.terminateProcessTree ??
      ((input, deps) => terminatePtyProcessTree(input, deps));
    const operation = (async (): Promise<PtyProcessTreeTerminationProof> => {
      if (this.childNeverSpawned) {
        return Object.freeze({
          ok: true,
          rootExited: true,
          descendantsExited: true,
        });
      }
      if (this.physicalRootExited) {
        return this.proveNaturalProcessTreeExit();
      }
      if (this.darwinResponsibilitySupervisor) {
        try {
          if (!root.kill('SIGTERM')) {
            throw new Error(
              'o supervisor Darwin recusou o pedido de encerramento',
            );
          }
          await this.physicalRootExit;
          return this.proveDarwinResponsibilitySupervisorExit();
        } catch (error) {
          return Object.freeze({
            ok: false,
            rootExited: this.physicalRootExited,
            descendantsExited: false,
            error:
              error instanceof Error
                ? error.message
                : `Darwin responsibility teardown failed: ${String(error)}`,
          });
        }
      }
      let proof: PtyProcessTreeTerminationProof;
      try {
        proof = await terminateProcessTree(
          {
            rootPid,
            ownsRoot: () =>
              this.proc === root &&
              (rootPid === -1 || this.proc.pid === rootPid),
            killRoot: (signal) => {
              root.kill(signal);
            },
            rootExited: this.physicalRootExit,
          },
          {
            termTimeoutMs:
              options.termTimeoutMs ??
              this.deps.killGraceMs ??
              DEFAULT_KILL_GRACE_MS,
            ...(options.killTimeoutMs !== undefined
              ? { killTimeoutMs: options.killTimeoutMs }
              : {}),
            ...(options.snapshotTimeoutMs !== undefined
              ? { snapshotTimeoutMs: options.snapshotTimeoutMs }
              : {}),
            ...(options.platform !== undefined
              ? { platform: options.platform }
              : {}),
          },
        );
      } catch (error) {
        proof = Object.freeze({
          ok: false,
          rootExited: this.physicalRootExited,
          descendantsExited: false,
          error:
            error instanceof Error
              ? error.message
              : `OMP process-tree termination failed: ${String(error)}`,
        });
      }
      // The root may have exited naturally between the initial check and the
      // terminator's first ps capture. A spawn-time/rolling inventory plus the
      // dedicated POSIX lineage can still prove that cleanly without turning
      // a race into an unrecoverable authority leak.
      if (!proof.ok && this.physicalRootExited) {
        const naturalProof = await this.proveNaturalProcessTreeExit();
        if (naturalProof.ok) return naturalProof;
      }
      return proof;
    })();
    this.terminationFlight = operation;
    const proof = await operation;
    if (proof.ok && proof.rootExited && proof.descendantsExited) {
      this.successfulTermination = proof;
    }
    if (this.terminationFlight === operation) {
      this.terminationFlight = null;
    }
    return proof;
  }

  /**
   * Fire-and-observe compatibility entrypoint. It initiates the same physical
   * fence but deliberately returns no success signal; inventory ownership must
   * stay with the caller until `terminate()` resolves with a complete proof.
   */
  dispose(): void {
    void this.terminate().then((proof) => {
      if (!proof.ok) {
        console.warn(
          `[omp-rpc:${this.sessionId}] process-tree exit not proven: ` +
            (proof.error ?? 'unknown physical teardown failure'),
        );
      }
    });
  }

  private beginLogicalDispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inventoryTimer) {
      clearTimeout(this.inventoryTimer);
      this.inventoryTimer = null;
    }
    this.settlePendingAgentStart(
      new Error('sessão encerrada antes de agent_start'),
    );
    this.rejectAllPending(new Error('sessão encerrada'));
    for (const requestId of [...this.pendingUi.keys()])
      this.settleUi(requestId);
    // Do not flush a possible partial credential prefix into replay while a
    // physical process is being revoked.
    this.childOutputRedactor.clear();
  }

  private physicalRootPid(): number | null {
    return typeof this.proc.pid === 'number' &&
      Number.isInteger(this.proc.pid) &&
      this.proc.pid > 0
      ? this.proc.pid
      : null;
  }

  private physicalIdentityKey(row: ProcessTableRow): string {
    return `${row.pid}:${row.startedAt}`;
  }

  private hasUnambiguousPhysicalIdentity(
    row: ProcessTableRow,
    capturedAtMs: number,
  ): boolean {
    const startedAtMs = Date.parse(row.startedAt);
    return (
      Number.isFinite(startedAtMs) &&
      startedAtMs < Math.floor(capturedAtMs / 1_000) * 1_000
    );
  }

  private uniquePhysicalRows(
    rows: readonly ProcessTableRow[],
  ): Map<number, ProcessTableRow> | null {
    const byPid = new Map<number, ProcessTableRow>();
    for (const row of rows) {
      if (byPid.has(row.pid)) return null;
      byPid.set(row.pid, row);
    }
    return byPid;
  }

  private recordPhysicalSnapshot(snapshot: DescendantSnapshot): void {
    const rootPid = this.physicalRootPid();
    const structurallyValid =
      snapshot.root !== null &&
      rootPid !== null &&
      snapshot.root.pid === rootPid &&
      this.uniquePhysicalRows(snapshot.inventory) !== null &&
      this.hasUnambiguousPhysicalIdentity(
        snapshot.root,
        snapshot.capturedAtMs,
      );
    if (!structurallyValid) {
      // `ps lstart` has one-second resolution. A first same-second capture is
      // expected immediately after spawn and must be retried, not turned into
      // permanent corruption. Once an exact baseline exists, however, any
      // duplicate/mismatch is an authority break and remains fail-closed.
      if (this.initialPhysicalSnapshot) this.inventoryCompromised = true;
      return;
    }
    if (
      !snapshot.root ||
      rootPid === null ||
      snapshot.root.pid !== rootPid
    ) {
      return;
    }
    if (!this.initialPhysicalSnapshot) {
      this.initialPhysicalSnapshot = snapshot;
      const treeRows = [snapshot.root, ...snapshot.descendants];
      const treeKeys = new Set(
        treeRows.map((row) => this.physicalIdentityKey(row)),
      );
      const authorizeBoundary = (
        value: number | string,
        members: readonly ProcessTableRow[],
        target: Set<number> | Set<string>,
      ): void => {
        if (
          members.length > 0 &&
          members.every((row) =>
            treeKeys.has(this.physicalIdentityKey(row)),
          )
        ) {
          (target as Set<number | string>).add(value);
        }
      };
      if (snapshot.root.sid > 0 && snapshot.root.sid === snapshot.root.pid) {
        authorizeBoundary(
          snapshot.root.sid,
          snapshot.inventory.filter((row) => row.sid === snapshot.root!.sid),
          this.authorizedSessionIds,
        );
      }
      if (
        snapshot.root.pgid > 0 &&
        snapshot.root.pgid === snapshot.root.pid
      ) {
        authorizeBoundary(
          snapshot.root.pgid,
          snapshot.inventory.filter(
            (row) => row.pgid === snapshot.root!.pgid,
          ),
          this.authorizedProcessGroups,
        );
      }
      if (
        snapshot.root.tty !== '?' &&
        snapshot.root.tty !== '??' &&
        snapshot.root.tty !== '-'
      ) {
        authorizeBoundary(
          snapshot.root.tty,
          snapshot.inventory.filter(
            (row) => row.tty === snapshot.root!.tty,
          ),
          this.authorizedTerminals,
        );
      }
    } else if (
      this.initialPhysicalSnapshot.root?.startedAt !== snapshot.root.startedAt
    ) {
      this.inventoryCompromised = true;
      return;
    }
    for (const row of snapshot.descendants) {
      this.trackedPhysicalRows.set(this.physicalIdentityKey(row), row);
    }
    for (const row of snapshot.inventory) {
      if (
        this.authorizedSessionIds.has(row.sid) ||
        this.authorizedProcessGroups.has(row.pgid) ||
        this.authorizedTerminals.has(row.tty)
      ) {
        this.trackedPhysicalRows.set(this.physicalIdentityKey(row), row);
      }
    }
  }

  private async captureAndTrackPhysicalInventory(): Promise<DescendantSnapshot | null> {
    const rootPid = this.physicalRootPid();
    if (rootPid === null) {
      this.inventoryCompromised = true;
      return null;
    }
    const capture =
      this.deps.captureProcessTree ??
      ((pid: number) => captureDescendantSnapshot(pid));
    try {
      const snapshot = await capture(rootPid);
      if (snapshot?.root) this.recordPhysicalSnapshot(snapshot);
      return snapshot;
    } catch {
      this.inventoryCompromised = true;
      return null;
    }
  }

  private schedulePhysicalInventoryRefresh(): void {
    if (this.disposed || this.physicalRootExited || this.inventoryTimer) return;
    const intervalMs = this.deps.processInventoryIntervalMs ?? 1_000;
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 30_000
    ) {
      this.inventoryCompromised = true;
      return;
    }
    this.inventoryTimer = setTimeout(() => {
      this.inventoryTimer = null;
      if (this.disposed || this.physicalRootExited) return;
      void this.captureAndTrackPhysicalInventory().finally(() => {
        this.schedulePhysicalInventoryRefresh();
      });
    }, intervalMs);
    this.inventoryTimer.unref?.();
  }

  private physicalRowsAreGone(rows: readonly ProcessTableRow[]): boolean {
    const byPid = this.uniquePhysicalRows(rows);
    const initialRoot = this.initialPhysicalSnapshot?.root;
    if (!byPid || !initialRoot) return false;
    const currentRoot = byPid.get(initialRoot.pid);
    if (currentRoot?.startedAt === initialRoot.startedAt) return false;
    for (const expected of this.trackedPhysicalRows.values()) {
      if (byPid.get(expected.pid)?.startedAt === expected.startedAt) {
        return false;
      }
    }
    return !rows.some(
      (row) =>
        this.authorizedSessionIds.has(row.sid) ||
        this.authorizedProcessGroups.has(row.pgid) ||
        this.authorizedTerminals.has(row.tty),
    );
  }

  private async proveNaturalProcessTreeExit(): Promise<PtyProcessTreeTerminationProof> {
    if (this.darwinResponsibilitySupervisor) {
      return this.proveDarwinResponsibilitySupervisorExit();
    }
    await this.initialInventoryFlight;
    const rootPid = this.physicalRootPid();
    const hasClosedLineage =
      this.authorizedSessionIds.size > 0 ||
      this.authorizedProcessGroups.size > 0 ||
      this.authorizedTerminals.size > 0;
    if (
      !this.physicalRootExited ||
      rootPid === null ||
      !this.initialPhysicalSnapshot?.root ||
      this.inventoryCompromised ||
      !hasClosedLineage
    ) {
      return Object.freeze({
        ok: false,
        rootExited: this.physicalRootExited,
        descendantsExited: false,
        error:
          'O inventário OMP anterior ao exit não estabeleceu uma linhagem física fechada.',
      });
    }
    const capture =
      this.deps.captureProcessTree ??
      ((pid: number) => captureDescendantSnapshot(pid));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let snapshot: DescendantSnapshot | null;
      try {
        snapshot = await capture(rootPid);
      } catch {
        snapshot = null;
      }
      if (!snapshot || !this.physicalRowsAreGone(snapshot.inventory)) {
        return Object.freeze({
          ok: false,
          rootExited: true,
          descendantsExited: false,
          error:
            'O inventário pós-exit do OMP não provou todos os descendentes ausentes.',
        });
      }
      if (attempt === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25);
          timer.unref?.();
        });
      }
    }
    return Object.freeze({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
  }

  private proveDarwinResponsibilitySupervisorExit(): PtyProcessTreeTerminationProof {
    const ok =
      this.physicalRootExited &&
      isProvenDarwinPtySupervisorExit({
        exitCode: this.exitCode,
        signal: this.physicalRootSignal,
      });
    return Object.freeze({
      ok,
      rootExited: this.physicalRootExited,
      descendantsExited: ok,
      ...(!ok
        ? {
            error:
              'O supervisor Darwin não produziu uma saída normal verificável; ' +
              'a ausência dos processos sob responsabilidade não foi provada.',
          }
        : {}),
    });
  }

  // ------------------------------------------------------------------
  // Transporte NDJSON.
  // ------------------------------------------------------------------

  private onStdout(chunk: string): void {
    if (this.disposed || this.lifecycle === 'exited') return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset);
      if (newline < 0) {
        const suffix = chunk.slice(offset);
        if (
          this.stdoutBuffer.length + suffix.length >
          OMP_RPC_MAX_FRAME_CHARS
        ) {
          this.failTransport('frame NDJSON excedeu o limite de 1 MiB');
          return;
        }
        this.stdoutBuffer += suffix;
        return;
      }
      const segment = chunk.slice(offset, newline);
      if (this.stdoutBuffer.length + segment.length > OMP_RPC_MAX_FRAME_CHARS) {
        this.failTransport('frame NDJSON excedeu o limite de 1 MiB');
        return;
      }
      const line = this.stdoutBuffer + segment;
      this.stdoutBuffer = '';
      offset = newline + 1;
      this.consumeStdoutLine(line);
      if (this.disposed) return;
    }
  }

  private consumeStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      // Human diagnostics are tolerated, but only inside the bounded frame.
      const safeDiagnostic = this.redactChildText(trimmed);
      this.rememberDiagnostic(safeDiagnostic);
      console.warn(
        `[omp-rpc:${this.sessionId}] linha NDJSON inválida ignorada: ` +
          safeDiagnostic.slice(0, 200),
      );
      return;
    }
    try {
      this.routeFrame(value);
    } catch (err) {
      console.warn(
        `[omp-rpc:${this.sessionId}] frame não processado: ` +
          this.redactChildText(
            err instanceof Error ? err.message : String(err),
          ),
      );
    }
  }

  private failTransport(reason: string): void {
    this.stdoutBuffer = '';
    this.push({
      kind: 'notice',
      level: 'error',
      message: `sessão omp encerrada: ${reason}`,
    });
    this.dispose();
  }

  private writeFrame(frame: object): void {
    try {
      this.proc.stdin?.write(`${JSON.stringify(frame)}\n`);
    } catch (err) {
      console.warn(`[omp-rpc:${this.sessionId}] escrita no stdin falhou:`, err);
    }
  }

  private request(
    command: OmpRpcCommand,
    onIssued?: (requestId: string) => void,
    bootstrapCommand = false,
  ): Promise<OmpResponseFrame> {
    if (this.lifecycle === 'exited' || this.disposed) {
      return Promise.reject(new Error('sessão omp encerrada'));
    }
    if (this.pending.size >= OMP_RPC_MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new Error('limite de comandos pendentes da sessão omp excedido'),
      );
    }
    this.reqCounter += 1;
    const id = `req_${this.reqCounter}`;
    const line = `${JSON.stringify({ ...command, id })}\n`;
    const queueUntilBootstrap =
      !bootstrapCommand && this.bootstrapLifecycle !== 'ready';
    if (
      queueUntilBootstrap &&
      this.preReadyBytes + line.length > OMP_RPC_MAX_PRE_READY_BYTES
    ) {
      return Promise.reject(
        new Error('orçamento da fila pré-ready da sessão omp excedido'),
      );
    }
    return new Promise<OmpResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.removePreReadyRequest(id);
        reject(new Error(`timeout aguardando resposta de ${command.type}`));
      }, this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      try {
        onIssued?.(id);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.removePreReadyRequest(id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (queueUntilBootstrap) {
        // User commands remain queued through the whole bootstrap. An RPC
        // timeout removes the exact line, so no acknowledged failure can turn
        // into a late effect after ready.
        this.preReadyQueue.set(id, line);
        this.preReadyBytes += line.length;
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
    this.preReadyQueue.clear();
    this.preReadyBytes = 0;
  }

  private removePreReadyRequest(id: string): void {
    const line = this.preReadyQueue.get(id);
    if (line === undefined) return;
    this.preReadyQueue.delete(id);
    this.preReadyBytes = Math.max(0, this.preReadyBytes - line.length);
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
          if (this.pendingAgentStart) {
            this.pendingAgentStart.started = true;
            if (this.pendingAgentStart.acked) this.settlePendingAgentStart();
          }
          this.lifecycle = 'busy';
          this.lastIsStreaming = true;
          this.pushStatus();
        }
        return;
      }
      case 'agent_end': {
        if (ompAgentEndFrameSchema.safeParse(value).success) {
          this.flushAssistantText();
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
          const delta = this.childOutputRedactor.stream(
            'assistant-text',
            event.delta,
          );
          if (delta) this.push({ kind: 'text-delta', delta });
        } else if (
          event.type === 'thinking_delta' &&
          typeof event.delta === 'string'
        ) {
          const delta = this.childOutputRedactor.stream(
            'assistant-thinking',
            event.delta,
          );
          if (delta) this.push({ kind: 'thinking-delta', delta });
        }
        return;
      }
      case 'message_end':
        this.flushAssistantText();
        this.push({ kind: 'message-end' });
        return;
      case 'tool_execution_start': {
        const parsed = ompToolExecutionStartFrameSchema.safeParse(value);
        if (!parsed.success) return;
        this.push({
          kind: 'tool',
          toolCallId: parsed.data.toolCallId,
          name: parsed.data.toolName,
          argsPreview: previewArgs(
            this.childOutputRedactor.value(parsed.data.args),
          ),
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
        if (parsed.success)
          this.rememberCancelledHostCall(parsed.data.targetId);
        return;
      }
      case 'prompt_result': {
        const parsed = ompPromptResultFrameSchema.safeParse(value);
        if (parsed.success && !parsed.data.agentInvoked) {
          const pendingStart = this.pendingAgentStart;
          if (
            pendingStart &&
            (parsed.data.id === undefined ||
              parsed.data.id === pendingStart.requestId)
          ) {
            this.settlePendingAgentStart(
              new Error('O prompt OMP foi local-only e não iniciou o agente.'),
            );
          }
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
    this.pushStatus();
    void this.bootstrap();
  }

  /** set_host_tools → set_model opcional → get_state; então a sessão é idle. */
  private async bootstrap(): Promise<void> {
    try {
      if (this.deps.hostTools.length > 0) {
        await this.request(
          {
            type: 'set_host_tools',
            tools: this.deps.hostTools,
          },
          undefined,
          true,
        );
      }
      if (this.config.model) {
        await this.request(
          {
            type: 'set_model',
            provider: this.config.model.provider,
            modelId: this.config.model.modelId,
          },
          undefined,
          true,
        );
      }
      await this.request({ type: 'get_state' }, undefined, true);
      this.pushStatus();
      this.bootstrapLifecycle = 'ready';
    } catch (err) {
      this.bootstrapLifecycle = 'failed';
      this.bootstrapFailure = this.redactChildText(
        err instanceof Error ? err.message : String(err),
      );
      console.warn(
        `[omp-rpc:${this.sessionId}] bootstrap falhou: ${this.bootstrapFailure}`,
      );
      this.push({
        kind: 'notice',
        level: 'warning',
        message: `bootstrap da sessão omp incompleto: ${this.bootstrapFailure}`,
      });
    }
    if (this.lifecycle === 'ready' && this.bootstrapLifecycle === 'ready') {
      this.lifecycle = this.lastIsStreaming ? 'busy' : 'idle';
      this.pushStatus();
      const queued = [...this.preReadyQueue.entries()];
      this.preReadyQueue.clear();
      this.preReadyBytes = 0;
      for (const [requestId, line] of queued) {
        if (!this.pending.has(requestId)) continue;
        try {
          this.proc.stdin?.write(line);
        } catch (err) {
          console.warn(
            `[omp-rpc:${this.sessionId}] flush pós-bootstrap falhou:`,
            err,
          );
        }
      }
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
        new Error(
          this.redactChildText(
            frame.error ?? `${pending.command} falhou sem detalhe`,
          ),
        ),
      );
    }
  }

  private async refreshState(): Promise<void> {
    if (this.lifecycle === 'exited' || this.disposed) return;
    try {
      await this.request({ type: 'get_state' });
      this.pushStatus();
    } catch (err) {
      console.warn(
        `[omp-rpc:${this.sessionId}] get_state falhou: ` +
          this.redactChildText(
            err instanceof Error ? err.message : String(err),
          ),
      );
    }
  }

  private applyStateData(data: unknown): void {
    const parsed = ompSessionStateSchema.safeParse(data);
    if (!parsed.success) return;
    this.lastModel = parsed.data.model
      ? {
          ...parsed.data.model,
          provider: this.redactChildText(parsed.data.model.provider),
          id: this.redactChildText(parsed.data.model.id),
        }
      : this.lastModel;
    this.lastContextUsage = parsed.data.contextUsage
      ? {
          tokens: parsed.data.contextUsage.tokens,
          contextWindow: parsed.data.contextUsage.contextWindow,
          percent: parsed.data.contextUsage.percent,
        }
      : this.lastContextUsage;
    this.lastIsStreaming = parsed.data.isStreaming;
    this.sessionName =
      parsed.data.sessionName == null
        ? this.sessionName
        : this.redactChildText(parsed.data.sessionName);
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
    this.diagnosticTail.push(this.redactChildText(text).slice(0, 300));
    if (this.diagnosticTail.length > 6) this.diagnosticTail.shift();
  }

  private onExit(
    code: number | null,
    physical: boolean,
    signal?: NodeJS.Signals | number | null,
  ): void {
    if (physical && !this.physicalRootExited) {
      this.physicalRootExited = true;
      this.physicalRootSignal = signal;
      this.resolvePhysicalRootExit();
      if (this.inventoryTimer) {
        clearTimeout(this.inventoryTimer);
        this.inventoryTimer = null;
      }
    }
    if (this.lifecycle === 'exited') return;
    this.lifecycle = 'exited';
    this.settlePendingAgentStart(
      new Error('processo omp encerrou antes de agent_start'),
    );
    this.exitCode = code;
    this.rejectAllPending(new Error('processo omp encerrou'));
    for (const requestId of [...this.pendingUi.keys()])
      this.settleUi(requestId);
    this.cancelledHostCalls.clear();
    this.activeHostCalls.clear();
    this.stdoutBuffer = '';
    this.childOutputRedactor.clearStreams();
    if (code !== null && code !== 0 && this.diagnosticTail.length > 0) {
      this.push({
        kind: 'notice',
        level: 'error',
        message: `omp saiu com código ${code}: ${this.diagnosticTail.join(' · ')}`,
      });
    }
    this.push({ kind: 'exit', code: this.exitCode });
    this.childOutputRedactor.clear();
  }

  private settlePendingAgentStart(error?: Error): void {
    const pending = this.pendingAgentStart;
    if (!pending) return;
    this.pendingAgentStart = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  /** Callback assíncrono de request() pode instalar/remover o waiter. */
  private readPendingAgentStart(): PendingAgentStart | null {
    return this.pendingAgentStart;
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

    if (
      this.pendingUi.has(request.id) ||
      this.pendingUi.size >= OMP_RPC_MAX_PENDING_UI
    ) {
      this.writeFrame({
        type: 'extension_ui_response',
        id: request.id,
        cancelled: true,
      } satisfies OmpExtensionUiResponseFrame);
      this.push({
        kind: 'notice',
        level: 'warning',
        message: this.pendingUi.has(request.id)
          ? 'pedido de UI OMP duplicado foi negado'
          : 'limite de pedidos de UI OMP pendentes excedido; pedido negado',
      });
      return;
    }

    // Modo safe: encaminha ao renderer e espera com timeout (deny por default).
    const timeoutMs =
      typeof request.timeout === 'number' && request.timeout > 0
        ? request.timeout
        : (this.deps.uiResponseTimeoutMs ?? DEFAULT_UI_RESPONSE_TIMEOUT_MS);
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
        title: this.redactChildText(title),
        decision,
        detail:
          detail === undefined
            ? undefined
            : this.redactChildText(detail),
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
    if (this.activeHostCalls.has(callId)) {
      this.writeFrame(hostToolResult(callId, 'host tool call duplicada', true));
      return;
    }
    if (this.activeHostCalls.size >= OMP_RPC_MAX_ACTIVE_HOST_CALLS) {
      this.writeFrame(
        hostToolResult(
          callId,
          'limite de host tools concorrentes excedido',
          true,
        ),
      );
      return;
    }
    this.activeHostCalls.add(callId);
    let frame: OmpHostToolResultFrame;
    try {
      if (!this.deps.hostTools.some((tool) => tool.name === toolName)) {
        frame = hostToolResult(
          callId,
          `host tool desconhecida: ${toolName}`,
          true,
        );
      } else {
        let outcome: OmpHostToolDispatchResult;
        try {
          const physicalCall = mintOmpRpcPhysicalHostCall({
            sessionId: this.sessionId,
            childPid: this.proc.pid,
            callId,
            toolName,
          });
          outcome = await this.deps.dispatchHostTool(
            toolName,
            this.childOutputRedactor.value(args),
            physicalCall,
          );
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
    } finally {
      this.activeHostCalls.delete(callId);
    }
    if (this.cancelledHostCalls.delete(callId)) return; // abortada pelo servidor
    if (this.lifecycle === 'exited' || this.disposed) return;
    this.writeFrame(frame);
  }

  private rememberCancelledHostCall(callId: string): void {
    if (this.cancelledHostCalls.has(callId)) return;
    if (this.cancelledHostCalls.size >= OMP_RPC_MAX_CANCELLED_HOST_CALLS) {
      const oldest = this.cancelledHostCalls.values().next().value;
      if (typeof oldest === 'string') this.cancelledHostCalls.delete(oldest);
    }
    this.cancelledHostCalls.add(callId);
  }

  // ------------------------------------------------------------------
  // Push.
  // ------------------------------------------------------------------

  private push(event: OmpRpcPushEvent): void {
    try {
      this.deps.onPush(this.redactPushEvent(event));
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

  private redactChildText(value: string): string {
    return this.childOutputRedactor.text(value);
  }

  private flushAssistantText(): void {
    const text = this.childOutputRedactor.flush('assistant-text');
    if (text) this.push({ kind: 'text-delta', delta: text });
    const thinking = this.childOutputRedactor.flush('assistant-thinking');
    if (thinking) this.push({ kind: 'thinking-delta', delta: thinking });
  }

  private redactPushEvent(event: OmpRpcPushEvent): OmpRpcPushEvent {
    switch (event.kind) {
      case 'status':
        return {
          ...event,
          model: event.model
            ? {
                provider: this.redactChildText(event.model.provider),
                id: this.redactChildText(event.model.id),
              }
            : null,
          sessionName:
            event.sessionName === null
              ? null
              : this.redactChildText(event.sessionName),
        };
      case 'text-delta':
      case 'thinking-delta':
        return { ...event, delta: this.redactChildText(event.delta) };
      case 'tool':
        return {
          ...event,
          name: this.redactChildText(event.name),
          argsPreview: this.redactChildText(event.argsPreview),
        };
      case 'ui-request':
        return {
          ...event,
          title: this.redactChildText(event.title),
          message:
            event.message === null
              ? null
              : this.redactChildText(event.message),
          options:
            event.options === null
              ? null
              : event.options.map((option) =>
                  this.redactChildText(option),
                ),
          placeholder:
            event.placeholder === null
              ? null
              : this.redactChildText(event.placeholder),
        };
      case 'auto-approval':
        return {
          ...event,
          title: this.redactChildText(event.title),
        };
      case 'notice':
        return {
          ...event,
          message: this.redactChildText(event.message),
        };
      case 'open-url':
        return { ...event, url: this.redactChildText(event.url) };
      default:
        return event;
    }
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
