export interface RemoteBridgeInfo {
  running: boolean;
  port?: number;
  urls: string[];
  pairingCode?: string;
  pairingExpiresAt?: number;
  tokenCount: number;
  clientCount: number;
  certFingerprint?: string;
}

export interface RemoteBridgeStartRequest {
  port?: number;
  /** Bind address. Defaults to 127.0.0.1; set 0.0.0.0 to expose on the LAN. */
  host?: string;
}

export interface RemoteCliDetection {
  target: string;
  found: Array<{ cli: string; path: string }>;
  error?: string;
}

export interface RemoteTmuxSession {
  name: string;
  windows: number;
  createdAt?: number;
  attached: boolean;
}

export interface RemoteSpawnRequest {
  target: string;
  cwd?: string;
  cli: 'claude' | 'codex' | 'agy' | 'kimi';
  sessionName?: string;
  prompt?: string;
}

export interface RemoteSpawnResult {
  ok: boolean;
  target: string;
  sessionName?: string;
  attachCommand?: string;
  sessions?: RemoteTmuxSession[];
  detected?: RemoteCliDetection;
  error?: string;
}

export type RemoteSshHostSource = 'nexus' | 'imported';

/** Vista do operador: apelido sem IP/hostname. */
export interface RemoteSshHostView {
  alias: string;
  source: RemoteSshHostSource;
  user?: string;
  port?: number;
  ready: boolean;
  hasNexusKey: boolean;
}

export interface RemoteSshConnectRequest {
  alias: string;
  host: string;
  user: string;
  password: string;
  port?: number;
}

export type RemoteSshConnectErrorKind =
  | 'auth'
  | 'timeout'
  | 'host_key'
  | 'unreachable'
  | 'invalid'
  | 'unknown';

export interface RemoteSshConnectResult {
  ok: boolean;
  alias?: string;
  error?: string;
  errorKind?: RemoteSshConnectErrorKind;
}

export interface RemoteSshImportResult {
  ok: boolean;
  imported: RemoteSshHostView[];
  skipped: number;
  error?: string;
}
