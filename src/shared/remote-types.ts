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
  cli: 'claude' | 'codex' | 'gemini' | 'kimi' | 'antigravity';
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
