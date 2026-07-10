import { describe, expect, it } from 'vitest';
import {
  EventLedger,
  LedgerConcurrencyError,
  verifyEventChain,
  type LedgerEvent,
  type LedgerStorage,
} from './event-ledger';

class MemoryStorage implements LedgerStorage {
  events: LedgerEvent[] = [];
  rejectNext = false;

  readLast(): LedgerEvent | null {
    return this.events.at(-1) ?? null;
  }

  compareAndAppend(expectedSequence: number, expectedHash: string, event: LedgerEvent): boolean {
    if (this.rejectNext) {
      this.rejectNext = false;
      return false;
    }
    const last = this.readLast();
    const sequence = last?.sequence ?? 0;
    const hash = last?.eventHash ?? '0'.repeat(64);
    if (sequence !== expectedSequence || hash !== expectedHash) return false;
    this.events.push(event);
    return true;
  }

  list(): readonly LedgerEvent[] {
    return [...this.events];
  }
}

function draft(type: 'contract-frozen' | 'sensor-finished' = 'contract-frozen') {
  return {
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    missionId: 'mission-a',
    type,
    actor: { kind: 'nexus' as const, id: 'nexus-core' },
    payload: { contractId: 'contract-a' },
    versions: {
      appVersion: '0.12.0',
      contextHash: 'a'.repeat(64),
      contractHash: 'b'.repeat(64),
      policyHash: 'c'.repeat(64),
      evaluatorVersion: 'review-v1',
    },
  };
}

describe('EventLedger', () => {
  it('appends a monotonic canonical hash chain and replays deterministically', () => {
    const storage = new MemoryStorage();
    let clock = 1_700_000_000_000;
    const ledger = new EventLedger(storage, { now: () => clock++ });
    const first = ledger.append(draft());
    const second = ledger.append({
      ...draft('sensor-finished'),
      payload: { sensorId: 'unit', exitCode: 0 },
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.eventHash);
    expect(verifyEventChain(storage.list())).toEqual({ valid: true, count: 2 });
    expect(
      ledger.replay(
        { sensors: 0 },
        (state, event) => ({
          sensors: state.sensors + Number(event.type === 'sensor-finished'),
        }),
      ),
    ).toEqual({ sensors: 1 });
  });

  it('detects any payload or chain tampering before replay', () => {
    const storage = new MemoryStorage();
    const ledger = new EventLedger(storage);
    ledger.append(draft());
    const tampered = storage.list().map((event) => ({
      ...event,
      payload: { contractId: 'changed' },
    }));
    expect(verifyEventChain(tampered)).toMatchObject({
      valid: false,
      brokenSequence: 1,
    });
  });

  it('fails explicitly on optimistic concurrency instead of last-write-wins', () => {
    const storage = new MemoryStorage();
    storage.rejectNext = true;
    const ledger = new EventLedger(storage);
    expect(() => ledger.append(draft())).toThrow(LedgerConcurrencyError);
    expect(storage.events).toHaveLength(0);
  });

  it('rejects effects without immutable context/contract versions', () => {
    const storage = new MemoryStorage();
    const ledger = new EventLedger(storage);
    const unsafe = draft('sensor-finished');
    unsafe.versions = { appVersion: '0.12.0' } as typeof unsafe.versions;
    expect(() => ledger.append(unsafe)).toThrow(/contextHash.*contractHash/i);
  });

  it('rejects secrets, prompts, installation/session IDs and absolute paths', () => {
    const ledger = new EventLedger(new MemoryStorage());
    const sensitivePayloads: unknown[] = [
      { apiKey: 'secret' },
      { prompt: 'full agent prompt' },
      { installationId: 'install-a' },
      { sessionId: 'pty-a' },
      { file: '/Users/alice/private.ts' },
    ];
    for (const payload of sensitivePayloads) {
      expect(() =>
        ledger.append({ ...draft(), payload: payload as never }),
      ).toThrow(/sensitive/i);
    }
  });
});
