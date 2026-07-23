// Nexus SSH session manager under RemoteHostCapability (Gap D2).
// Patterns inspired by stablyai/orca ssh-connection-manager @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus-authored.
// See third_party/licenses/orca-MIT.txt.
//
// Production will inject a real ssh2 client; unit tests inject MockSshTransport.
// No agent-force; scope must authorize every session.

import type { RemoteHostCapability } from '../remote-capability';
import { remoteCapabilityGrantsAgentForce } from '../remote-capability';
import { identityAllowlistIsWildcard } from './ssh-identity-filter';
import { SshTransportError } from './ssh-operation-lifecycle';

export type SshAuthMethod =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'privateKey'; readonly privateKey: string; readonly passphrase?: string }
  | { readonly kind: 'agent'; readonly allowedFingerprints: readonly string[] };

/** Trust-on-first-use prompt for a host key not yet in the known-hosts vault. */
export type SshHostKeyPrompt = {
  readonly host: string;
  readonly port: number;
  /** OpenSSH-style `SHA256:<base64>` fingerprint of the presented host key. */
  readonly fingerprint: string;
};

export type SshConnectOptions = {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly auth: SshAuthMethod;
  readonly keepaliveIntervalMs?: number;
  /**
   * Confirm an UNKNOWN host key (trust-on-first-use). Return true to pin it and
   * continue. When omitted, an unknown key is pinned automatically (accept-new
   * semantics). A CHANGED key is always rejected regardless of this hook — that
   * is the man-in-the-middle protection and is not overridable.
   */
  readonly confirmUnknownHostKey?: (
    prompt: SshHostKeyPrompt,
  ) => boolean | Promise<boolean>;
};

export type SshOperationOptions = {
  /** Per-call timeout override. Production transports still enforce a bound. */
  readonly timeoutMs?: number;
  /** Cancellation never triggers an automatic retry. */
  readonly signal?: AbortSignal;
};

export type SshTransport = {
  connect(options: SshConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  exec(
    command: string,
    options?: SshOperationOptions,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(remotePath: string, options?: SshOperationOptions): Promise<string>;
  writeFile(
    remotePath: string,
    content: string,
    options?: SshOperationOptions,
  ): Promise<void>;
  listDir(
    remotePath: string,
    options?: SshOperationOptions,
  ): Promise<readonly string[]>;
  openPty?(
    cols: number,
    rows: number,
    options?: SshOperationOptions,
  ): Promise<{
    write: (data: string) => void;
    onData: (cb: (data: string) => void) => void;
    resize: (cols: number, rows: number) => void;
    close: () => void;
  }>;
};

export type SshSession = {
  readonly sessionId: string;
  readonly capability: RemoteHostCapability;
  readonly transport: SshTransport;
  /** Explicit reconnect only; no failed operation is replayed automatically. */
  reconnect(): Promise<void>;
  disconnect(): Promise<void>;
};

export type SshSessionManager = {
  connect(
    capability: RemoteHostCapability,
    options: SshConnectOptions,
    transport: SshTransport,
  ): Promise<SshSession>;
  get(sessionId: string): SshSession | null;
  disconnect(sessionId: string): Promise<void>;
  list(): readonly SshSession[];
};

let seq = 0;

export function createSshSessionManager(): SshSessionManager {
  const sessions = new Map<string, SshSession>();

  return {
    async connect(capability, options, transport) {
      if (capability.kind !== 'ssh') {
        throw new Error('ssh-session-manager: capability kind must be ssh');
      }
      if (!capability.paired) {
        throw new Error('ssh-session-manager: capability not paired (fail closed)');
      }
      // Invariant: remote capability never grants agent force.
      if (remoteCapabilityGrantsAgentForce(capability) !== false) {
        throw new Error('ssh-session-manager: agent force denied');
      }
      if (options.auth.kind === 'agent' && options.auth.allowedFingerprints.length === 0) {
        throw new Error('ssh-session-manager: empty agent identity allowlist');
      }
      // H3: reject the wildcard `['*']` — offering every agent identity to an
      // arbitrary host leaks all public keys and allows signing with the wrong
      // key. Callers must pin specific fingerprints (fail-closed).
      if (options.auth.kind === 'agent' && identityAllowlistIsWildcard(options.auth.allowedFingerprints)) {
        throw new Error('ssh-session-manager: wildcard identity allowlist rejected (H3)');
      }
      // Production transport is injected (ssh2 via createSsh2Transport).
      await transport.connect(options);
      const sessionId = `ssh-${++seq}-${capability.hostId}`;
      let closed = false;
      let reconnectInFlight: Promise<void> | null = null;
      const guardedTransport = createSessionTransportGuard(
        transport,
        () => closed,
      );
      const session: SshSession = {
        sessionId,
        capability,
        transport: guardedTransport,
        async reconnect() {
          if (closed) {
            throw new SshTransportError(
              'not_connected',
              'Sessão SSH encerrada; crie uma nova sessão para reconectar.',
            );
          }
          if (transport.isConnected()) return;
          if (reconnectInFlight) return reconnectInFlight;
          reconnectInFlight = (async () => {
            // Invalidate any dead generation/resources before opening another.
            await transport.disconnect();
            if (closed) {
              throw new SshTransportError(
                'not_connected',
                'Sessão SSH foi encerrada durante a reconexão.',
              );
            }
            await transport.connect(options);
          })();
          try {
            await reconnectInFlight;
          } finally {
            reconnectInFlight = null;
          }
        },
        async disconnect() {
          closed = true;
          try {
            await transport.disconnect();
          } finally {
            sessions.delete(sessionId);
          }
        },
      };
      sessions.set(sessionId, session);
      return session;
    },
    get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async disconnect(sessionId) {
      const s = sessions.get(sessionId);
      if (s) await s.disconnect();
    },
    list() {
      return [...sessions.values()];
    },
  };
}

function createSessionTransportGuard(
  transport: SshTransport,
  isClosed: () => boolean,
): SshTransport {
  const assertLive = (operation: string): void => {
    if (isClosed() || !transport.isConnected()) {
      throw new SshTransportError(
        'not_connected',
        `Transporte SSH morto para ${operation}; chame session.reconnect() explicitamente e verifique o estado remoto antes de repetir.`,
      );
    }
  };

  return {
    async connect() {
      throw new SshTransportError(
        'not_connected',
        'Use session.reconnect(); conexão direta pelo transporte da sessão é bloqueada.',
      );
    },
    disconnect() {
      return transport.disconnect();
    },
    isConnected() {
      return !isClosed() && transport.isConnected();
    },
    async exec(command, options) {
      assertLive('exec');
      return await transport.exec(command, options);
    },
    async readFile(remotePath, options) {
      assertLive('readFile');
      return await transport.readFile(remotePath, options);
    },
    async writeFile(remotePath, content, options) {
      assertLive('writeFile');
      await transport.writeFile(remotePath, content, options);
    },
    async listDir(remotePath, options) {
      assertLive('listDir');
      return await transport.listDir(remotePath, options);
    },
    openPty: transport.openPty
      ? async (cols, rows, options) => {
          assertLive('openPty');
          return await transport.openPty!(cols, rows, options);
        }
      : undefined,
  };
}

/** In-memory mock SSH transport for unit/e2e without real ssh2. */
export function createMockSshTransport(initialFs: Record<string, string> = {}): SshTransport & {
  readonly fs: Map<string, string>;
  readonly history: string[];
} {
  const fs = new Map(Object.entries(initialFs));
  const history: string[] = [];
  let connected = false;
  return {
    fs,
    history,
    async connect(options) {
      history.push(`connect:${options.username}@${options.host}:${options.port ?? 22}`);
      connected = true;
    },
    async disconnect() {
      history.push('disconnect');
      connected = false;
    },
    isConnected() {
      return connected;
    },
    async exec(command) {
      if (!connected) throw new Error('not connected');
      history.push(`exec:${command}`);
      if (command.startsWith('git ')) {
        return { code: 0, stdout: '## main\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async readFile(remotePath) {
      if (!connected) throw new Error('not connected');
      const v = fs.get(remotePath);
      if (v === undefined) throw new Error(`ENOENT:${remotePath}`);
      return v;
    },
    async writeFile(remotePath, content) {
      if (!connected) throw new Error('not connected');
      fs.set(remotePath, content);
      history.push(`write:${remotePath}`);
    },
    async listDir(remotePath) {
      if (!connected) throw new Error('not connected');
      const prefix = remotePath.endsWith('/') ? remotePath : `${remotePath}/`;
      const names = new Set<string>();
      for (const key of fs.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const part = rest.split('/')[0];
          if (part) names.add(part);
        } else if (key === remotePath) {
          // file
        }
      }
      return [...names].sort();
    },
    async openPty(cols, rows) {
      if (!connected) throw new Error('not connected');
      history.push(`pty:${cols}x${rows}`);
      let dataCb: ((data: string) => void) | null = null;
      return {
        write(data) {
          history.push(`pty-write:${data}`);
          // Echo for tests.
          dataCb?.(data);
        },
        onData(cb) {
          dataCb = cb;
        },
        resize(c, r) {
          history.push(`pty-resize:${c}x${r}`);
        },
        close() {
          history.push('pty-close');
          dataCb = null;
        },
      };
    },
  };
}
