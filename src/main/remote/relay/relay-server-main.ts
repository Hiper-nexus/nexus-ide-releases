/**
 * Entry point standalone do relay cego. Ele é empacotado separadamente para
 * rodar como um serviço Railway, sem carregar Electron nem o restante do app.
 */
import { startBlindRelay, type BlindRelayOptions } from './blind-relay';

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_ROOMS = 128;
const DEFAULT_MAX_PEERS_PER_ROOM = 8;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_ROOM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_UPGRADES_PER_MINUTE = 60;

function readPositiveInteger(
  name: string,
  fallback: number,
  maximum: number,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function readAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = env.RELAY_ALLOWED_ORIGINS?.trim() ?? '';
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new Error('RELAY_ALLOWED_ORIGINS is required in production');
    }
    return [];
  }

  return raw.split(',').map((entry) => {
    const value = entry.trim();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`RELAY_ALLOWED_ORIGINS contains an invalid origin: ${value}`);
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== value) {
      throw new Error(`RELAY_ALLOWED_ORIGINS must contain origins only: ${value}`);
    }
    return parsed.origin;
  });
}

export function relayOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): BlindRelayOptions {
  const portRaw = env.RELAY_PORT ?? env.PORT;
  const port = portRaw
    ? readPositiveInteger(env.RELAY_PORT ? 'RELAY_PORT' : 'PORT', DEFAULT_PORT, 65_535, env)
    : DEFAULT_PORT;

  return {
    port,
    host: env.RELAY_HOST?.trim() || '0.0.0.0',
    allowedOrigins: readAllowedOrigins(env),
    maxRooms: readPositiveInteger('RELAY_MAX_ROOMS', DEFAULT_MAX_ROOMS, 10_000, env),
    maxPeersPerRoom: readPositiveInteger(
      'RELAY_MAX_PEERS_PER_ROOM',
      DEFAULT_MAX_PEERS_PER_ROOM,
      128,
      env,
    ),
    maxFrameBytes: readPositiveInteger(
      'RELAY_MAX_FRAME_BYTES',
      DEFAULT_MAX_FRAME_BYTES,
      4 * 1024 * 1024,
      env,
    ),
    roomTtlMs: readPositiveInteger(
      'RELAY_ROOM_TTL_MS',
      DEFAULT_ROOM_TTL_MS,
      24 * 60 * 60 * 1000,
      env,
    ),
    maxUpgradesPerIpPerMinute: readPositiveInteger(
      'RELAY_MAX_UPGRADES_PER_IP_PER_MINUTE',
      DEFAULT_MAX_UPGRADES_PER_MINUTE,
      10_000,
      env,
    ),
  };
}

export async function startRelayServer(): Promise<void> {
  const relay = await startBlindRelay(relayOptionsFromEnv());
  let stopping = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await relay.stop();
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.stdout.write(`[relay] listening on ${relay.port}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startRelayServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[relay] failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
