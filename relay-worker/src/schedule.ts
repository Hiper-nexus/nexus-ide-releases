/**
 * Quando o alarme da sala precisa acordar: no primeiro prazo real, nunca num
 * ciclo fixo. Prazos: o TTL ocioso da sala; o heartbeat de quem pinga (última
 * prova de vida + 2 intervalos); e, para quem entrou há até 2 intervalos e
 * ainda não pingou, o fim dessa janela (é quando se sabe se ele pinga ou é
 * cliente antigo, que fica só com o TTL). Atividade só empurra prazos para
 * frente, então basta recalcular no alarme e na entrada de cada conexão.
 */
export interface PeerTiming {
  joinedMs: number;
  /** Último frame recebido desta conexão. */
  seenMs: number;
  /** Último pong automático do runtime; null = nunca pingou. */
  lastPingMs: number | null;
}

export interface RoomTiming {
  now: number;
  lastActivityMs: number;
  roomTtlMs: number;
  heartbeatMs: number;
  peers: readonly PeerTiming[];
}

export function nextCheckAt({ now, lastActivityMs, roomTtlMs, heartbeatMs, peers }: RoomTiming): number {
  const window = 2 * heartbeatMs;
  let next = lastActivityMs + roomTtlMs + 1;
  for (const peer of peers) {
    if (peer.lastPingMs !== null) next = Math.min(next, Math.max(peer.lastPingMs, peer.seenMs) + window + 1);
    else if (now - peer.joinedMs <= window) next = Math.min(next, peer.joinedMs + window + 1);
  }
  return Math.max(next, now + 1);
}
