/**
 * Teto agregado de salas (RELAY_MAX_ROOMS): uma instância só, chamada pelas
 * salas, nunca pela internet. Guarda o id do Durable Object da sala (derivado
 * do roomId por hash, sem o roomId) e um prazo de aluguel. A sala adquire ao
 * ganhar host, renova no alarme e libera ao fechar; o que um reinício deixar
 * para trás some sozinho quando o aluguel vence.
 */
import { relayConfig } from './config';

export type RegistryOp = 'acquire' | 'renew' | 'release';

interface RegistryRequest {
  op: RegistryOp;
  id: string;
  leaseMs: number;
}

function parse(body: unknown): RegistryRequest | null {
  if (!body || typeof body !== 'object') return null;
  const { op, id, leaseMs } = body as Record<string, unknown>;
  if (op !== 'acquire' && op !== 'renew' && op !== 'release') return null;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  if (typeof leaseMs !== 'number' || !Number.isSafeInteger(leaseMs) || leaseMs < 1) return null;
  return { op, id, leaseMs };
}

export class RelayRegistry implements DurableObject {
  readonly #sql: SqlStorage;
  readonly #maxRooms: number;

  constructor(state: DurableObjectState, env: Env) {
    this.#sql = state.storage.sql;
    this.#maxRooms = relayConfig(env).maxRooms;
    this.#sql.exec('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  }

  async fetch(request: Request): Promise<Response> {
    const call = parse(await request.json().catch(() => null));
    if (!call) return new Response(null, { status: 400 });
    const now = Date.now();
    this.#sql.exec('DELETE FROM rooms WHERE expires_at <= ?', now);
    if (call.op === 'release') {
      this.#sql.exec('DELETE FROM rooms WHERE id = ?', call.id);
      return Response.json({ ok: true });
    }
    if (call.op === 'acquire') {
      const known = this.#sql.exec('SELECT 1 FROM rooms WHERE id = ?', call.id).toArray().length > 0;
      const open = this.#sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM rooms').one().n;
      if (!known && open >= this.#maxRooms) return Response.json({ ok: false });
    }
    // renew nunca recusa: a sala já existe, só volta a ser contada.
    this.#sql.exec(
      'INSERT INTO rooms (id, expires_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at',
      call.id,
      now + call.leaseMs,
    );
    return Response.json({ ok: true });
  }
}
