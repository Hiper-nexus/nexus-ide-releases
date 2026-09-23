/**
 * Padrão boardRelay (paridade Overclock OVKA-754) para listagens de tools que
 * se perdem no caminho: a origem responde 200 em ms e a resposta morre entre
 * Cloudflare/HTTP2 e o cliente. O CLI espera, devolve `[]` e NUNCA pede de novo
 * — a sessão fica muda a missão inteira.
 *
 * Regras medidas (OCL-214):
 *  - listagens (initialize, tools/list, ping) repetem até N vezes em SOCKET
 *    NOVO — a conexão que engoliu a resposta está morta;
 *  - `tools/call` NUNCA é repetido (muda estado; retry cega duplica);
 *  - se tudo falha, a sessão NÃO fica muda: entrega uma tool placeholder de
 *    reconexão e retoma em background com `notifications/tools/list_changed`;
 *  - segredos só por ENV; status em arquivo atômico (tmp + rename).
 */

export type ListingRelayState = 'connecting' | 'ok' | 'missing' | 'recovered';

export interface ListingRelayStatus {
  state: ListingRelayState;
  attempts: number;
  at: number;
  detail?: string;
}

export const LISTING_RECONNECT_TOOL_NAME = 'nexus_reconectar';
export const LISTING_RELAY_ATTEMPT_MS = 5_000;
export const LISTING_RELAY_ATTEMPTS = 3;
export const LISTING_RELAY_BACKOFF_MS = [300, 1_000] as const;
export const LISTING_RELAY_CALL_TIMEOUT_MS = 120_000;
export const LISTING_RELAY_RECOVERY_DELAYS_MS = [
  5_000, 15_000, 45_000, 120_000, 300_000,
] as const;

export class RelayTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`relay timeout ${ms}ms`);
    this.name = 'RelayTimeoutError';
  }
}

export interface ListingRelayDeps {
  /** Um POST de listagem. `fresh: true` = socket novo (sem keep-alive). */
  post: (body: string, opts: { timeoutMs: number; fresh: boolean }) => Promise<{ status: number; messages: unknown[] }>;
  emit: (message: unknown) => void;
  log?: (line: string) => void;
  writeStatus?: (status: ListingRelayStatus) => void;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  attemptMs?: number;
  attempts?: number;
  backoffMs?: readonly number[];
  recoveryDelaysMs?: readonly number[];
}

/** Tool placeholder: o agente sabe que o backend está ausente e o que fazer. */
export function reconnectToolPlaceholder(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: LISTING_RECONNECT_TOOL_NAME,
    description:
      'The backend tool listing was lost in transit (3 attempts). ' +
      'This placeholder is the only tool until the backend comes back. ' +
      'Call once to retry now; the relay keeps recovering in the background ' +
      'and tools reappear via notifications/tools/list_changed. Do NOT ' +
      'report this as a product blocker and do NOT invent substitute tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

export class ListingRelay {
  private cachedTools: unknown[] | null = null;
  private state: ListingRelayState = 'connecting';
  private listingAttempts = 0;
  private recoveryStep = 0;
  private cancelRecovery: (() => void) | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly attemptMs: number;
  private readonly attempts: number;
  private readonly backoffMs: readonly number[];
  private readonly recoveryDelaysMs: readonly number[];

  constructor(private readonly deps: ListingRelayDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.attemptMs = deps.attemptMs ?? LISTING_RELAY_ATTEMPT_MS;
    this.attempts = deps.attempts ?? LISTING_RELAY_ATTEMPTS;
    this.backoffMs = deps.backoffMs ?? LISTING_RELAY_BACKOFF_MS;
    this.recoveryDelaysMs = deps.recoveryDelaysMs ?? LISTING_RELAY_RECOVERY_DELAYS_MS;
  }

  get currentState(): ListingRelayState {
    return this.state;
  }

  private setState(state: ListingRelayState, detail?: string): void {
    this.state = state;
    const status: ListingRelayStatus = {
      state,
      attempts: this.listingAttempts,
      at: this.now(),
      ...(detail ? { detail } : {}),
    };
    try {
      this.deps.writeStatus?.(status);
    } catch {
      // status file never kills the session
    }
  }

  private log(line: string): void {
    this.deps.log?.(`[listing-relay] ${line}`);
  }

  /**
   * Até `attempts` idas, só para métodos idempotentes de listagem.
   * Repete em timeout/5xx; 4xx é resposta de verdade.
   */
  private async postWithRetry(body: string, idempotent: boolean): Promise<unknown[]> {
    const max = idempotent ? this.attempts : 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= max; attempt += 1) {
      this.listingAttempts += 1;
      // 1ª ida pode usar keep-alive; retentativa é SEMPRE socket novo
      const fresh = attempt > 1;
      try {
        const reply = await this.deps.post(body, {
          timeoutMs: idempotent ? this.attemptMs : LISTING_RELAY_CALL_TIMEOUT_MS,
          fresh,
        });
        if (reply.status >= 500) {
          lastError = new Error(`HTTP ${reply.status}`);
        } else {
          this.setState('ok');
          this.recoveryStep = 0;
          return reply.messages;
        }
      } catch (err) {
        lastError = err;
      }
      if (attempt < max) {
        const pause = this.backoffMs[attempt - 1] ?? 1_000;
        await this.sleep(pause);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private emitError(id: unknown, message: string): void {
    this.deps.emit({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });
  }

  private emitResult(id: unknown, result: unknown): void {
    this.deps.emit({ jsonrpc: '2.0', id: id ?? null, result });
  }

  private async handleToolsList(id: unknown, body: string): Promise<void> {
    try {
      const messages = await this.postWithRetry(body, true);
      const first = messages[0] as { result?: { tools?: unknown[] } } | undefined;
      this.cachedTools = first?.result?.tools ?? [];
      this.setState('ok');
      this.stopRecovery();
      for (const message of messages) this.deps.emit(message);
    } catch (err) {
      this.cachedTools = null;
      this.setState('missing', err instanceof Error ? err.message : String(err));
      this.log(`listagem perdida (${this.listingAttempts} tentativas) — entregando reconectar`);
      this.emitResult(id, {
        tools: [reconnectToolPlaceholder()],
      });
      this.scheduleRecovery(body);
    }
  }

  private scheduleRecovery(body: string): void {
    this.stopRecovery();
    const delay = this.recoveryDelaysMs[
      Math.min(this.recoveryStep, this.recoveryDelaysMs.length - 1)
    ];
    this.recoveryStep += 1;
    const schedule = this.deps.schedule ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
    this.cancelRecovery = schedule(() => {
      void this.recoverNow(body);
    }, delay);
  }

  private stopRecovery(): void {
    this.cancelRecovery?.();
    this.cancelRecovery = null;
    this.recoveryStep = 0;
  }

  /**
   * Uma tentativa de reaver a lista; em sucesso, avisa o cliente para listar
   * de novo (`notifications/tools/list_changed`).
   */
  async recoverNow(body: string): Promise<boolean> {
    try {
      const messages = await this.postWithRetry(body, true);
      const first = messages[0] as { result?: { tools?: unknown[] } } | undefined;
      this.cachedTools = first?.result?.tools ?? [];
      this.setState('recovered');
      this.stopRecovery();
      this.deps.emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      for (const message of messages) this.deps.emit(message);
      return true;
    } catch {
      this.scheduleRecovery(body);
      return false;
    }
  }

  /** Uma mensagem vinda do cliente (stdin/HTTP). */
  async handle(req: {
    id?: number | string | null;
    method: string;
    params?: Record<string, unknown>;
  }): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: req.id ?? null, method: req.method, params: req.params });
    if (req.method === 'tools/list' || req.method === 'initialize' || req.method === 'ping') {
      if (req.method === 'tools/list') {
        await this.handleToolsList(req.id, body);
        return;
      }
      try {
        const messages = await this.postWithRetry(body, true);
        for (const message of messages) this.deps.emit(message);
      } catch (err) {
        this.emitError(
          req.id,
          `listagem perdida no transporte (${err instanceof Error ? err.message : String(err)}); ` +
            `chame ${LISTING_RECONNECT_TOOL_NAME} ou aguarde a recuperação automática`,
        );
      }
      return;
    }
    // tools/call e o resto: UMA tentativa só
    try {
      const messages = await this.postWithRetry(body, false);
      for (const message of messages) this.deps.emit(message);
    } catch (err) {
      this.emitError(
        req.id,
        `falha ao encaminhar ${req.method} (${err instanceof Error ? err.message : String(err)}); ` +
          'não repita chamadas com efeito às cegas',
      );
    }
  }

  close(): void {
    this.stopRecovery();
  }

  getCachedTools(): unknown[] | null {
    return this.cachedTools;
  }
}
