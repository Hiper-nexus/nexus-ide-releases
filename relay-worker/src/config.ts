/**
 * Configuração do relay a partir das variáveis do Worker, com as mesmas regras
 * do relay da Railway (`server/src/relay/server.ts`). Valor inválido falha
 * fechado: a requisição vira 500 em vez de rodar com limite inventado.
 */
export interface RelayConfig {
  allowedOrigins: ReadonlySet<string>;
  /** Teto de salas abertas ao mesmo tempo (contadas pelo RelayRegistry). */
  maxRooms: number;
  maxPeersPerRoom: number;
  /** Teto de um frame, binário ou TEXT (bytes UTF-8), como o maxPayload da Railway. */
  maxFrameBytes: number;
  /** Quem passa disto numa janela de 1 s é derrubado. */
  maxMessagesPerSecond: number;
  roomTtlMs: number;
  /** Quem já pingou e fica 2 intervalos calado é derrubado. */
  heartbeatMs: number;
  /** Conexão calada há mais que isto cede a vaga: host para um novo host, guest para um novo guest. */
  idleTakeoverMs: number;
}

export type RelayEnv = Pick<
  Env,
  | 'RELAY_ALLOWED_ORIGINS'
  | 'RELAY_MAX_ROOMS'
  | 'RELAY_MAX_PEERS_PER_ROOM'
  | 'RELAY_MAX_FRAME_BYTES'
  | 'RELAY_MAX_MESSAGES_PER_SECOND'
  | 'RELAY_ROOM_TTL_MS'
  | 'RELAY_HEARTBEAT_MS'
  | 'RELAY_IDLE_TAKEOVER_MS'
>;

function positiveInteger(
  env: RelayEnv,
  name: keyof RelayEnv,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function allowedOrigins(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const parsed = new URL(entry);
        if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== entry) {
          throw new Error(`RELAY_ALLOWED_ORIGINS must contain origins only: ${entry}`);
        }
        return parsed.origin;
      }),
  );
}

export function relayConfig(env: RelayEnv): RelayConfig {
  return {
    allowedOrigins: allowedOrigins(env.RELAY_ALLOWED_ORIGINS),
    maxRooms: positiveInteger(env, 'RELAY_MAX_ROOMS', 2_000, 100_000),
    maxPeersPerRoom: positiveInteger(env, 'RELAY_MAX_PEERS_PER_ROOM', 8, 128),
    maxFrameBytes: positiveInteger(env, 'RELAY_MAX_FRAME_BYTES', 256 * 1024, 1024 * 1024),
    maxMessagesPerSecond: positiveInteger(env, 'RELAY_MAX_MESSAGES_PER_SECOND', 1_000, 100_000),
    roomTtlMs: positiveInteger(env, 'RELAY_ROOM_TTL_MS', 30 * 60 * 1000, 24 * 60 * 60 * 1000),
    heartbeatMs: positiveInteger(env, 'RELAY_HEARTBEAT_MS', 30_000, 10 * 60 * 1000),
    idleTakeoverMs: positiveInteger(env, 'RELAY_IDLE_TAKEOVER_MS', 45_000, 60 * 60 * 1000),
  };
}
