/**
 * Shared contracts and teardown helpers for the production ssh2 transport.
 * Kept separate so connection authority and individual operations stay small.
 */

import type { SpawnProcess } from '../../vendor/emdash/ssh/transports';
import type { Ssh2AgentRuntime } from '../remote/ssh/ssh-identity-filter';
import {
  SshTransportError,
  type BoundedSshOperation,
} from '../remote/ssh/ssh-operation-lifecycle';
import type { ProxiedConnectFragment, SshProxySpec } from '../remote/ssh/proxied-connect-config';

export type Ssh2Resource = {
  close?(): void;
  destroy?(): void;
  end?(): void;
};

export type Ssh2Channel = Ssh2Resource & {
  stderr: NodeJS.ReadableStream;
  on(event: string, cb: (...args: unknown[]) => void): void;
  write(data: string): unknown;
  setWindow(rows: number, cols: number, height: number, width: number): void;
};

export type Ssh2Sftp = Ssh2Resource & {
  readFile(path: string, cb: (err: Error | undefined, data: Buffer) => void): void;
  writeFile(path: string, data: Buffer, cb: (err: Error | undefined) => void): void;
  readdir(
    path: string,
    cb: (err: Error | undefined, list: Array<{ filename: string }>) => void,
  ): void;
};

export type Ssh2Client = Ssh2Resource & {
  on(event: string, cb: (...args: unknown[]) => void): void;
  connect(cfg: Record<string, unknown>): void;
  exec(
    command: string,
    cb: (err: Error | undefined, stream?: Ssh2Channel) => void,
  ): void;
  shell(
    options: Record<string, unknown>,
    cb: (err: Error | undefined, stream?: Ssh2Channel) => void,
  ): void;
  sftp(cb: (err: Error | undefined, sftp?: Ssh2Sftp) => void): void;
};

export type Ssh2Module = Ssh2AgentRuntime & {
  Client: new () => Ssh2Client;
};

export type Ssh2TransportTimeouts = {
  readonly connectMs: number;
  readonly operationMs: number;
  readonly ptyOpenMs: number;
};

export type Ssh2TransportFactoryOptions = {
  readonly proxy?: SshProxySpec;
  readonly spawnProcess?: SpawnProcess;
  readonly timeouts?: Partial<Ssh2TransportTimeouts>;
};

export type PendingOperation = {
  readonly label: string;
  readonly outcomeUnknown: boolean;
  readonly controller: BoundedSshOperation<unknown>;
};

export type ConnectionState = {
  readonly generation: number;
  readonly client: Ssh2Client;
  phase: 'connecting' | 'connected' | 'closed';
  proxy: ProxiedConnectFragment | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
  connectResolve: (() => void) | null;
  connectReject: ((error: unknown) => void) | null;
  readonly operations: Set<PendingOperation>;
  readonly resources: Set<Ssh2Resource>;
};

const DEFAULT_TIMEOUTS: Ssh2TransportTimeouts = {
  connectMs: 20_000,
  operationMs: 30_000,
  ptyOpenMs: 15_000,
};

export function resolveTimeouts(
  configured: Partial<Ssh2TransportTimeouts> | undefined,
): Ssh2TransportTimeouts {
  return {
    connectMs: boundedTimeout(configured?.connectMs, DEFAULT_TIMEOUTS.connectMs, 'connect'),
    operationMs: boundedTimeout(
      configured?.operationMs,
      DEFAULT_TIMEOUTS.operationMs,
      'operation',
    ),
    ptyOpenMs: boundedTimeout(
      configured?.ptyOpenMs,
      DEFAULT_TIMEOUTS.ptyOpenMs,
      'openPty',
    ),
  };
}

export function boundedTimeout(
  configured: number | undefined,
  fallback: number,
  label: string,
): number {
  const value = configured ?? fallback;
  if (
    !Number.isFinite(value)
    || value < 1
    || value > 300_000
    || Math.floor(value) !== value
  ) {
    throw new Error(`ssh2-transport: ${label} timeout must be an integer from 1 to 300000ms`);
  }
  return value;
}

export function requireConnected(
  state: ConnectionState | null,
  operation: string,
): ConnectionState {
  if (!state || state.phase !== 'connected') {
    throw new SshTransportError(
      'not_connected',
      `SSH indisponível para ${operation}; reconecte manualmente antes de tentar novamente.`,
    );
  }
  return state;
}

export function teardownConnection(
  state: ConnectionState,
  error: SshTransportError,
): void {
  if (state.phase === 'closed') return;
  state.phase = 'closed';
  clearConnectTimer(state);
  const rejectConnect = state.connectReject;
  state.connectResolve = null;
  state.connectReject = null;
  rejectConnect?.(error);

  for (const pending of [...state.operations]) {
    pending.controller.cancel(new SshTransportError(
      error.code,
      error.message,
      { cause: error, outcomeUnknown: pending.outcomeUnknown },
    ));
  }
  state.operations.clear();

  for (const resource of [...state.resources]) closeResource(resource);
  state.resources.clear();
  try {
    state.proxy?.cleanup();
  } catch {
    // Best-effort proxy child teardown.
  }
  state.proxy = null;
  closeResource(state.client);
}

export function clearConnectTimer(state: ConnectionState): void {
  if (!state.connectTimer) return;
  clearTimeout(state.connectTimer);
  state.connectTimer = null;
}

export function releaseResource(
  state: ConnectionState,
  resource: Ssh2Resource,
): void {
  state.resources.delete(resource);
  closeResource(resource);
}

export function closeResource(resource: Ssh2Resource): void {
  try {
    if (typeof resource.destroy === 'function') {
      resource.destroy();
      return;
    }
    if (typeof resource.close === 'function') {
      resource.close();
      return;
    }
    resource.end?.();
  } catch {
    try {
      resource.end?.();
    } catch {
      // Cleanup is idempotent/best-effort.
    }
  }
}

export function assertPtyDimensions(cols: number, rows: number): void {
  if (
    !Number.isFinite(cols)
    || !Number.isFinite(rows)
    || cols < 1
    || rows < 1
    || Math.floor(cols) !== cols
    || Math.floor(rows) !== rows
  ) {
    throw new Error('ssh2-transport: PTY cols/rows must be positive integers');
  }
}

export function chunkText(chunk: unknown): string {
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
