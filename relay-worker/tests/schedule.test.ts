/**
 * O alarme da sala acorda no primeiro prazo real, não num ciclo fixo
 * (`src/schedule.ts`). Função pura: roda sem workerd.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextCheckAt } from '../src/schedule';

const MIN = 60_000;
const base = { roomTtlMs: 30 * MIN, heartbeatMs: 30_000 };

describe('nextCheckAt', () => {
  it('host antigo que nunca pingou, já fora da janela: só o TTL ocioso acorda a sala', () => {
    const now = 10 * MIN;
    const at = nextCheckAt({
      ...base,
      now,
      lastActivityMs: now - 1_000,
      peers: [{ joinedMs: now - 5 * MIN, seenMs: now - 1_000, lastPingMs: null }],
    });
    assert.equal(at, now - 1_000 + 30 * MIN + 1);
  });

  it('quem pinga: última prova de vida + 2 intervalos; frame mais novo que o ping adia', () => {
    const now = 10 * MIN;
    const peers = [{ joinedMs: now - 5 * MIN, seenMs: now - 50_000, lastPingMs: now - 10_000 }];
    assert.equal(nextCheckAt({ ...base, now, lastActivityMs: now, peers }), now - 10_000 + 60_000 + 1);
    const talking = [{ joinedMs: now - 5 * MIN, seenMs: now - 2_000, lastPingMs: now - 10_000 }];
    assert.equal(nextCheckAt({ ...base, now, lastActivityMs: now, peers: talking }), now - 2_000 + 60_000 + 1);
  });

  it('quem acabou de entrar e ainda não pingou: fim da janela de 2 intervalos', () => {
    const now = 10 * MIN;
    const at = nextCheckAt({
      ...base,
      now,
      lastActivityMs: now,
      peers: [
        { joinedMs: now - 5 * MIN, seenMs: now - 5 * MIN, lastPingMs: null },
        { joinedMs: now - 5_000, seenMs: now - 5_000, lastPingMs: null },
      ],
    });
    assert.equal(at, now - 5_000 + 60_000 + 1);
  });

  it('o menor prazo vence, e nunca fica no passado', () => {
    const now = 10 * MIN;
    const at = nextCheckAt({
      ...base,
      now,
      lastActivityMs: now - 31 * MIN,
      peers: [{ joinedMs: now - 5 * MIN, seenMs: now - 5 * MIN, lastPingMs: now - 2 * MIN }],
    });
    assert.equal(at, now + 1);
  });
});
