export type RemoteBridgeTailscaleStatus =
  | 'available'
  | 'requires-configuration'
  | 'unavailable';

/** Rótulos fechados — nunca texto cru da CLI (stderr carrega tskey-… e nós). */
export type RemoteBridgeTailscaleDiagnostic =
  | 'not-installed'
  | 'not-logged-in'
  | 'not-running'
  | 'no-magicdns'
  | 'serve-not-enabled'
  | 'permission-denied'
  | 'port-in-use'
  | 'timeout'
  | 'probe-failed'
  | 'unknown';

export interface RemoteBridgeTailscaleInfo {
  magicDnsName: string | null;
  /** Presente só enquanto o Nexus mantém o handler do Tailscale Serve ativo. */
  httpsUrl?: string;
  status: RemoteBridgeTailscaleStatus;
  diagnostic?: RemoteBridgeTailscaleDiagnostic;
}

export interface RemoteBridgeEndpoint {
  url: string;
  label: 'Tailscale HTTPS' | 'Tailscale IP' | 'Rede local' | 'Este computador';
}

export interface RemoteBridgeInfo {
  running: boolean;
  port?: number;
  urls: string[];
  /** As mesmas URLs de `urls`, rotuladas pela rede de origem. */
  endpoints?: RemoteBridgeEndpoint[];
  pairingCode?: string;
  pairingExpiresAt?: number;
  tokenCount: number;
  clientCount: number;
  certFingerprint?: string;
  tailscale?: RemoteBridgeTailscaleInfo;
}

export interface RemoteBridgeStartRequest {
  port?: number;
  /** Bind address. Defaults to 127.0.0.1; set 0.0.0.0 to expose on the LAN. */
  host?: string;
  /**
   * Publica a bridge no tailnet via Tailscale Serve (HTTPS *.ts.net). Só age
   * neste pedido explícito de start; ausente mantém o estado atual.
   */
  tailscale?: boolean;
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
