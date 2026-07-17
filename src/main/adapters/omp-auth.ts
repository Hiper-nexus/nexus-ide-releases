import { spawn as nodeSpawn } from 'node:child_process';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import {
  ompAuthBrokerEntrySchema,
  type OmpAuthBrokerEntry,
  type OmpAuthPushEvent,
} from '../../shared/omp-auth-types';
import {
  buildOmpChildEnv,
  type OmpChildLike,
  type OmpSpawnFn,
} from './omp-rpc-service';

/**
 * Lógica pura do login OAuth de assinaturas do oh-my-pi
 * (`omp auth-broker login <providerId>`). O CLI imprime
 * "Open this URL in your browser:" + a URL https e escuta o callback em
 * localhost; um readline "Paste the authorization code…" fica de fallback.
 *
 * CRÍTICO: o stdin do filho fica ABERTO (nunca stdin.end()) — fechar quebra o
 * readline do CLI com ERR_USE_AFTER_CLOSE; com o pipe aberto, o fluxo
 * navegador → callback localhost completa sem nenhum input.
 *
 * Main-process puro (node + shared): a fiação IPC vive em omp-auth-ipc.ts e
 * os testes injetam um processo fake (mesmo padrão do OmpRpcSession).
 */

/** Login OAuth depende de interação humana — 5 min de teto, depois mata. */
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Quantas linhas de diagnóstico guardar para a mensagem de erro. */
const DIAGNOSTIC_TAIL_LINES = 4;

const brokerListSchema = z.array(ompAuthBrokerEntrySchema);

/**
 * Valida a saída de `omp auth-broker list --json` (já JSON.parse-ada pelo
 * chamador). Lança em formato inesperado — o IPC reporta o erro à UI.
 */
export function parseAuthBrokerList(json: unknown): OmpAuthBrokerEntry[] {
  const parsed = brokerListSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('saída inesperada de `omp auth-broker list --json`');
  }
  return parsed.data;
}

/**
 * Primeira URL https de um texto (o CLI a imprime na linha seguinte a
 * "Open this URL in your browser:"; robusto a variações de frase).
 */
export function extractOAuthUrl(text: string): string | null {
  const match = /https:\/\/\S+/.exec(text);
  return match ? match[0] : null;
}

/** Decodifica chunk preservando UTF-8 multibyte em boundary de pipe. */
function decodeChunk(decoder: StringDecoder, chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : decoder.write(chunk);
}

export interface OmpLoginFlowConfig {
  flowId: string;
  providerId: string;
  binPath: string;
}

export interface OmpLoginFlowDeps {
  /** Push de eventos já estreitados (nunca stdout bruto). */
  onEvent: (event: OmpAuthPushEvent) => void;
  spawnImpl?: OmpSpawnFn;
  env?: Record<string, string>;
  cwd?: string;
  loginTimeoutMs?: number;
}

export class OmpLoginFlow {
  readonly flowId: string;
  readonly providerId: string;

  private readonly deps: OmpLoginFlowDeps;
  private readonly proc: OmpChildLike;
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private readonly diagnosticTail: string[] = [];
  private timeoutTimer: NodeJS.Timeout | null = null;
  private awaitingAuthSent = false;
  private settled = false;

  constructor(config: OmpLoginFlowConfig, deps: OmpLoginFlowDeps) {
    this.flowId = config.flowId;
    this.providerId = config.providerId;
    this.deps = deps;

    const spawnImpl: OmpSpawnFn =
      deps.spawnImpl ??
      ((binPath, args, options) =>
        nodeSpawn(binPath, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: 'pipe',
        }) as unknown as OmpChildLike);

    this.proc = spawnImpl(
      config.binPath,
      ['auth-broker', 'login', config.providerId],
      {
        cwd: deps.cwd ?? homedir(),
        env: deps.env ?? buildOmpChildEnv(),
      },
    );

    // stdin NUNCA é fechado por aqui (ver header do módulo).
    this.proc.stdout?.on('data', (chunk) =>
      this.onStdout(decodeChunk(this.stdoutDecoder, chunk)),
    );
    this.proc.stderr?.on('data', (chunk) => {
      const text = decodeChunk(this.stderrDecoder, chunk).trim();
      if (text) this.rememberDiagnostic(text);
    });
    this.proc.on('exit', (code) => this.onExit(code));
    this.proc.on('error', (err) =>
      this.fail(`processo omp falhou: ${err.message}`),
    );

    this.timeoutTimer = setTimeout(() => {
      this.kill();
      this.fail(
        'login expirou após 5 min sem autorização — tente de novo',
      );
    }, deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    this.timeoutTimer.unref?.();
  }

  /** Cancelamento pelo usuário: mata o filho e encerra como erro explícito. */
  cancel(): void {
    if (this.settled) return;
    this.kill();
    this.fail('Login cancelado pelo usuário.');
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // O stdout do login não carrega segredo (o token vai direto para o
      // cofre do omp); o tail só alimenta mensagem de erro.
      this.rememberDiagnostic(trimmed);
      if (this.awaitingAuthSent) continue;
      const url = extractOAuthUrl(trimmed);
      if (url) {
        this.awaitingAuthSent = true;
        this.emit({ phase: 'awaiting-auth', providerId: this.providerId, url });
      }
    }
  }

  private onExit(code: number | null): void {
    if (this.settled) return;
    if (code === 0) {
      this.settle();
      this.emit({ phase: 'done', providerId: this.providerId });
      return;
    }
    const detail = this.diagnosticTail.join(' · ');
    this.fail(
      detail
        ? `omp auth-broker login saiu com código ${code ?? '—'}: ${detail}`
        : `omp auth-broker login saiu com código ${code ?? '—'}`,
    );
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settle();
    this.emit({
      phase: 'error',
      providerId: this.providerId,
      message: message.slice(0, 2000),
    });
  }

  private settle(): void {
    this.settled = true;
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private kill(): void {
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // Já morto — o exit handler cuida do resto.
    }
  }

  private rememberDiagnostic(text: string): void {
    this.diagnosticTail.push(text.slice(0, 300));
    if (this.diagnosticTail.length > DIAGNOSTIC_TAIL_LINES) {
      this.diagnosticTail.shift();
    }
  }

  private emit(event: OmpAuthPushEvent): void {
    try {
      this.deps.onEvent(event);
    } catch (err) {
      console.warn(`[omp-auth:${this.flowId}] push falhou:`, err);
    }
  }
}
