/**
 * Teto agregado de salas (RelayRegistry) no workerd real, com RELAY_MAX_ROOMS=2.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { newRoom, sleep, startRelay, staysOpen, TestClient, type Relay } from './harness';

const TTL_MS = 5_000;
const IDLE_MS = 1_500;
const local = process.env.RELAY_TEST_URL ? 'RELAY_MAX_ROOMS=2 só no workerd local' : false;

describe('nexus-relay: teto de salas', { skip: local }, () => {
  let relay: Relay;
  const host = (room: string) => new TestClient(`${relay.wsBase}/r/${room}?role=host`);

  /** Abre um host; se o teto ainda não devolveu a vaga, tenta de novo. */
  async function hostEventually(room: string, timeoutMs: number): Promise<TestClient> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const client = host(room);
      await client.opened;
      const result = await staysOpen(client, 250);
      if (result === 'open') return client;
      assert.deepEqual(result, { code: 4029, reason: 'relay at capacity' });
      if (Date.now() > deadline) throw new Error('a vaga não voltou');
      await sleep(250);
    }
  }

  before(async () => {
    relay = await startRelay({
      RELAY_MAX_ROOMS: '2',
      RELAY_ROOM_TTL_MS: String(TTL_MS),
      RELAY_HEARTBEAT_MS: '400',
      RELAY_IDLE_TAKEOVER_MS: String(IDLE_MS),
    });
  });

  after(async () => {
    await relay?.stop();
  });

  it('acima de RELAY_MAX_ROOMS o host leva 101 + 4029; fechar uma sala devolve a vaga', { timeout: 30_000 }, async () => {
    const first = host(newRoom());
    const second = host(newRoom());
    await Promise.all([first.opened, second.opened]);
    const third = host(newRoom());
    await third.opened;
    assert.deepEqual(await third.closed, { code: 4029, reason: 'relay at capacity' });
    first.close();
    await first.closed;
    const fourth = await hostEventually(newRoom(), 3_000);
    second.close();
    fourth.close();
    await Promise.all([second.closed, fourth.closed]);
  });

  it('o TTL ocioso também devolve a vaga', { timeout: 30_000 }, async () => {
    const a = await hostEventually(newRoom(), 3_000);
    const b = await hostEventually(newRoom(), 3_000);
    const refused = host(newRoom());
    assert.deepEqual(await refused.closed, { code: 4029, reason: 'relay at capacity' });
    assert.deepEqual(await a.closed, { code: 4001, reason: 'idle timeout' });
    await b.closed;
    const c = await hostEventually(newRoom(), 3_000);
    c.close();
    await c.closed;
  });

  it('host que assume uma sala ociosa não gasta vaga nova', { timeout: 30_000 }, async () => {
    const roomA = newRoom();
    const a = await hostEventually(roomA, 3_000);
    const b = await hostEventually(newRoom(), 3_000);
    await sleep(IDLE_MS + 300);
    const takeover = host(roomA);
    await takeover.opened;
    assert.deepEqual(await a.closed, { code: 4008, reason: 'replaced by a new host' });
    assert.equal(await staysOpen(takeover, 300), 'open');
    // O teto continua cheio: a sala assumida é a mesma.
    const refused = host(newRoom());
    assert.deepEqual(await refused.closed, { code: 4029, reason: 'relay at capacity' });
    takeover.close();
    b.close();
    await Promise.all([takeover.closed, b.closed]);
  });

  it('reinício abrupto (sockets somem sem close) não prende vagas: elas voltam sozinhas', { timeout: 60_000 }, async () => {
    const a = await hostEventually(newRoom(), 3_000);
    const b = await hostEventually(newRoom(), 3_000);
    await relay.restart!();
    await Promise.all([a.closed, b.closed]);
    // O alarme da sala sem host libera a vaga; o aluguel (2 × TTL) é o último recurso.
    const c = await hostEventually(newRoom(), 2 * TTL_MS + 3_000);
    const d = await hostEventually(newRoom(), 3_000);
    c.close();
    d.close();
  });
});
