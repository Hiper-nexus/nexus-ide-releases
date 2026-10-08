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

// MOB-12 (F-1022): escopos por aparelho, escolhidos no pareamento.
//   read    — status, snapshot com panes/missões, leitura e stream do pane, Git/arquivos (F-1014)
//   input   — pane.input e pane.resize
//   approve — agentSession.respondToApproval (e ver os pedidos pendentes)
//   close   — pane.close
export type RemoteDeviceScope = 'read' | 'input' | 'approve' | 'close';

/** Ordem canônica; aparelho pareado antes do MOB-12 recebe todos. */
export const REMOTE_DEVICE_SCOPES: readonly RemoteDeviceScope[] = [
  'read',
  'input',
  'approve',
  'close',
];

/** Aparelho pareado, como o desktop mostra (nunca o token nem o hash). */
export interface RemoteBridgeDeviceView {
  /** Id do grant (registro do token), não o token. */
  id: string;
  keyFingerprint: string;
  pairedAt: number;
  expiresAt: number;
  scopes: RemoteDeviceScope[];
  connected: boolean;
}

export interface RemoteBridgeSetDeviceScopesRequest {
  deviceId: string;
  scopes: RemoteDeviceScope[];
}

export interface RemoteBridgeInfo {
  running: boolean;
  port?: number;
  urls: string[];
  /** As mesmas URLs de `urls`, rotuladas pela rede de origem. */
  endpoints?: RemoteBridgeEndpoint[];
  pairingCode?: string;
  pairingExpiresAt?: number;
  /** MOB-12: escopos que o código atual concede ao próximo aparelho. */
  pairingScopes?: RemoteDeviceScope[];
  /** MOB-12: aparelhos pareados neste checkout (só para o desktop). */
  devices?: RemoteBridgeDeviceView[];
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
  /** MOB-12: escopos do código emitido neste start; ausente = todos. */
  scopes?: RemoteDeviceScope[];
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
