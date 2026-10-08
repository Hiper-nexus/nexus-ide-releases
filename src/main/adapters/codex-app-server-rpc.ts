// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: withCodexAppServerClient (CodexProvider.ts:366-414: spawn curto do `codex app-server`, handshake initialize/initialized e um cliente por processo) reescrito sem Effect sobre o leitor NDJSON que o Nexus já tinha em quota/codex-cli-usage.ts — correlação por id, prazo único para a sessão, teto de bytes do stdout não confiável, CODEX_HOME explícito sem chaves de API do ambiente e kill garantido no fim.

import os from 'node:os';
import { spawn } from 'node:child_process';
import { z } from 'zod';

/**
 * F-964 (PRV-03): um processo `codex app-server` atende várias RPCs —
 * `account/read`, `account/rateLimits/read` e `model/list` — em vez de um
 * spawn por pergunta. Nenhuma thread ou turno de modelo é aberto.
 */

export const CODEX_APP_SERVER_ARGS: readonly string[] = Object.freeze([
  'app-server',
  '-c', 'cli_auth_credentials_store="file"',
  '-c', 'analytics.enabled=false',
  '-c', 'otel.exporter="none"',
]);

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export type CodexRpcFailureKind = 'rpc' | 'closed' | 'timeout' | 'overflow' | 'protocol' | 'spawn';

export class CodexRpcError extends Error {
  constructor(readonly kind: CodexRpcFailureKind, message: string) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

export interface CodexAppServerOptions {
  readonly binary: string;
  /** CODEX_HOME da conta (gerenciado) ou do login nativo. */
  readonly codexHome: string;
  /** Prazo da sessão inteira (handshake + todas as RPCs). */
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly clientName?: string;
}

export interface CodexAppServerRpc {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
}

const rpcResponse = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });
const rpcError = z.object({ message: z.string() });

/**
 * Abre o app-server, faz o handshake e entrega o cliente a `run`. O processo
 * morre quando `run` termina, falha ou estoura o prazo — nunca fica órfão.
 */
export function withCodexAppServer<T>(
  options: CodexAppServerOptions,
  run: (rpc: CodexAppServerRpc) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: options.codexHome };
    // Chave do ambiente não pode substituir o login salvo do CODEX_HOME.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.binary, [...CODEX_APP_SERVER_ARGS], {
        cwd: os.tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      reject(new CodexRpcError('spawn', 'codex app-server não abriu'));
      return;
    }
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 1;
    let settled = false;
    let output = '';
    let bytes = 0;
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const fail = (error: CodexRpcError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      reject(error);
    };
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(value);
    };
    const timer = setTimeout(
      () => fail(new CodexRpcError('timeout', 'codex app-server não respondeu no prazo')),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const write = (message: Record<string, unknown>): void => {
      if (settled) return;
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    const rpc: CodexAppServerRpc = {
      request(method, params) {
        if (settled) return Promise.reject(new CodexRpcError('closed', 'codex app-server já fechou'));
        const id = nextId++;
        return new Promise<unknown>((resolveRequest, rejectRequest) => {
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
          write({ method, ...(params === undefined ? {} : { params }), id });
        });
      },
      notify(method, params) {
        write({ method, ...(params === undefined ? {} : { params }) });
      },
    };

    const onLine = (line: string): void => {
      let data: unknown;
      try { data = JSON.parse(line); } catch {
        fail(new CodexRpcError('protocol', 'codex app-server mandou uma linha inválida'));
        return;
      }
      const parsed = rpcResponse.safeParse(data);
      // Notificações e pedidos do servidor (sem id nosso) não interessam aqui.
      if (!parsed.success) return;
      const entry = pending.get(parsed.data.id);
      if (!entry) return;
      pending.delete(parsed.data.id);
      if (parsed.data.error !== undefined) {
        const error = rpcError.safeParse(parsed.data.error);
        entry.reject(new CodexRpcError('rpc', error.success ? error.data.message : 'erro do codex app-server'));
        return;
      }
      entry.resolve(parsed.data.result);
    };

    child.on('error', () => fail(new CodexRpcError('spawn', 'codex app-server falhou')));
    child.on('close', () => fail(new CodexRpcError('closed', 'codex app-server fechou')));
    child.stdin?.on('error', () => fail(new CodexRpcError('closed', 'stdin do codex app-server fechou')));
    child.stdout?.on('error', () => fail(new CodexRpcError('closed', 'stdout do codex app-server fechou')));
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new CodexRpcError('overflow', 'codex app-server passou do teto de saída'));
        return;
      }
      output += chunk.toString('utf8');
      let newline: number;
      while (!settled && (newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (line.trim()) onLine(line);
      }
    });

    void (async () => {
      await rpc.request('initialize', {
        clientInfo: { name: options.clientName ?? 'nexus_quota', version: '1.0' },
        capabilities: null,
      });
      rpc.notify('initialized');
      return run(rpc);
    })().then(finish, (error: unknown) => fail(
      error instanceof CodexRpcError ? error : new CodexRpcError('rpc', error instanceof Error ? error.message : String(error)),
    ));
  });
}
