/**
 * Relay cego do companion mobile no Cloudflare (substitui o `nexus-relay` da
 * Railway, `server/src/relay/server.ts`). Este Worker só filtra o upgrade, na
 * mesma ordem da Railway — limite por IP (429), Origin (403, antes de olhar o
 * path), rota `/r/<roomId>?role=host|guest` (404) — e entrega o WebSocket ao
 * Durable Object da sala (`idFromName(roomId)`), onde vive o protocolo.
 *
 * Nada é registrado: nem sala, nem IP, nem payload.
 */
import { relayConfig } from './config';

export { RelayRegistry } from './registry';
export { RelayRoom } from './room';

const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

function status(code: number): Response {
  return new Response(null, { status: code });
}

export default {
  async fetch(request, env): Promise<Response> {
    // A Railway respondia 404 a todo HTTP que não fosse upgrade.
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return status(404);
    const config = relayConfig(env);
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.UPGRADE_RATE_LIMITER.limit({ key: ip });
    if (!success) return status(429);
    // Cliente nativo (desktop) não manda Origin; browser fora da lista é recusado.
    const origin = request.headers.get('Origin');
    if (origin !== null && !config.allowedOrigins.has(origin)) return status(403);
    const url = new URL(request.url);
    const match = ROOM_PATH.exec(url.pathname);
    const role = url.searchParams.get('role');
    if (!match || (role !== 'host' && role !== 'guest')) return status(404);
    const room = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(match[1]!));
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;
