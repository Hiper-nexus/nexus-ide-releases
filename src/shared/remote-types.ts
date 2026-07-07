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
