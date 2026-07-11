// Nexus SSH session manager under RemoteHostCapability (Gap D2).
// Patterns inspired by stablyai/orca ssh-connection-manager @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus-authored.
// See third_party/licenses/orca-MIT.txt.
//
// Production will inject a real ssh2 client; unit tests inject MockSshTransport.
// No agent-force; scope must authorize every session.

import type { RemoteHostCapability } from '../remote-capability';
import { remoteCapabilityGrantsAgentForce } from '../remote-capability';

export type SshAuthMethod =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'privateKey'; readonly privateKey: string; readonly passphrase?: string }
  | { readonly kind: 'agent'; readonly allowedFingerprints: readonly string[] };

export type SshConnectOptions = {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly auth: SshAuthMethod;
  readonly keepaliveIntervalMs?: number;
};

export type SshTransport = {
  connect(options: SshConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  exec(
    command: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(remotePath: string): Promise<string>;
  writeFile(remotePath: string, content: string): Promise<void>;
  listDir(remotePath: string): Promise<readonly string[]>;
  openPty?(
    cols: number,
    rows: number,
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
      // Production transport is injected (ssh2 via createSsh2Transport).
      await transport.connect(options);
      const sessionId = `ssh-${++seq}-${capability.hostId}`;
      const session: SshSession = {
        sessionId,
        capability,
        transport,
        async disconnect() {
          await transport.disconnect();
          sessions.delete(sessionId);
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
