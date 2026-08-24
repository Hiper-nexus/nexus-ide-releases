import { describe, expect, it } from 'vitest';
import { MISSION_RUNTIME_CLOSED_MARKER } from './mission-recovery-policy';
import {
  leftoverIsolationPatch,
  NEXUS_LEFTOVER_PARKED_MARKER,
  persistLeftoverIsolation,
  pickFocusedRunningMission,
  siblingRunningMissionIds,
  shouldPersistLeftoverIsolation,
  shouldSkipLeftoverRemount,
  wasMissionLeftoverParked,
  isFreshIniciarKickoff,
  type LeftoverIsolationMission,
  type LeftoverIsolationWriter,
} from './mission-leftover-isolation';

function mission(
  overrides: Partial<LeftoverIsolationMission> = {},
): LeftoverIsolationMission {
  return {
    id: 'mission-leftover',
    status: 'running',
    intentState: 'executing',
    description: 'Entregar o time de 20 stories',
    updatedAt: 10,
    ...overrides,
  };
}

function memoryWriter(
  rows: LeftoverIsolationMission[],
): LeftoverIsolationWriter<LeftoverIsolationMission> {
  return {
    get(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    update(id, patch) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return null;
      const next = { ...rows[index]!, ...patch, updatedAt: Date.now() };
      rows[index] = next;
      return next;
    },
  };
}

describe('persistLeftoverIsolation — park grava status não-running', () => {
  it('park/leftover/unfocus persiste blocked + selo leftover, não running', () => {
    const rows = [mission()];
    const parked = persistLeftoverIsolation(memoryWriter(rows), rows[0]!.id, 'park');

    expect(parked?.status).toBe('blocked');
    expect(parked?.intentState).toBe('blocked_user');
    expect(parked?.description).toContain(NEXUS_LEFTOVER_PARKED_MARKER);
    expect(wasMissionLeftoverParked(parked!)).toBe(true);
    expect(rows[0]!.status).toBe('blocked');
  });

  it('é idempotente: leftover já parked não reescreve', () => {
    const first = leftoverIsolationPatch(mission(), 'leftover');
    const rows = [
      mission({
        status: 'blocked',
        intentState: 'blocked_user',
        description: first.description,
      }),
    ];
    const writer = memoryWriter(rows);
    const again = persistLeftoverIsolation(writer, rows[0]!.id, 'unfocus');

    expect(again?.description).toBe(first.description);
    expect(again?.status).toBe('blocked');
  });

  it('Encerrar persiste blocked_user leftover — reopen não remonta', () => {
    const rows = [mission({ status: 'running', intentState: 'executing' })];
    const parked = persistLeftoverIsolation(
      memoryWriter(rows),
      rows[0]!.id,
      'encerrar',
    );

    expect(parked?.status).toBe('blocked');
    expect(parked?.intentState).toBe('blocked_user');
    expect(parked?.description).toContain(NEXUS_LEFTOVER_PARKED_MARKER);
    expect(parked?.description).toContain(MISSION_RUNTIME_CLOSED_MARKER);
    expect(rows[0]!.status).not.toBe('running');
  });

  it('Encerrar já fechado (runtime-closed + leftover) é idempotente', () => {
    const first = persistLeftoverIsolation(
      memoryWriter([mission()]),
      'mission-leftover',
      'encerrar',
    );
    const rows = [first!];
    const again = persistLeftoverIsolation(
      memoryWriter(rows),
      rows[0]!.id,
      'encerrar',
    );
    expect(again?.description).toBe(first?.description);
    expect(again?.status).toBe('blocked');
  });

  it('Encerrar falha fechado se o store ainda devolver running', () => {
    const rows = [mission({ status: 'running', intentState: 'executing' })];
    const writer: LeftoverIsolationWriter<LeftoverIsolationMission> = {
      get: (id) => rows.find((row) => row.id === id) ?? null,
      update: (id) => rows.find((row) => row.id === id) ?? null,
    };
    expect(() => persistLeftoverIsolation(writer, rows[0]!.id, 'encerrar')).toThrow(
      /não persistiu leftover não-running/,
    );
    expect(rows[0]!.status).toBe('running');
  });
});

describe('shouldPersistLeftoverIsolation', () => {
  it('running sem Maestro deste processo persiste — excepto kickoff fresco', () => {
    expect(
      shouldPersistLeftoverIsolation({
        status: 'running',
        alreadyClosedByOperator: false,
        alreadyLeftoverParked: false,
        hasThisProcessLiveMaestro: false,
      }),
    ).toBe(true);
    expect(
      shouldPersistLeftoverIsolation({
        status: 'running',
        alreadyClosedByOperator: false,
        alreadyLeftoverParked: false,
        hasThisProcessLiveMaestro: false,
        isFreshKickoff: true,
      }),
    ).toBe(false);
    expect(
      shouldPersistLeftoverIsolation({
        status: 'running',
        alreadyClosedByOperator: false,
        alreadyLeftoverParked: false,
        hasThisProcessLiveMaestro: true,
      }),
    ).toBe(false);
  });
});

describe('shouldSkipLeftoverRemount — reopen não remonta leftover', () => {
  it('automatic: leftover parked ou running leftover do disco sem Maestro não remonta', () => {
    expect(
      shouldSkipLeftoverRemount({
        mission: mission({
          status: 'blocked',
          description: leftoverIsolationPatch(mission()).description,
        }),
        liveMaestroSessionId: null,
        remountKind: 'automatic',
      }),
    ).toBe(true);
    expect(
      shouldSkipLeftoverRemount({
        mission: mission({ updatedAt: 1 }),
        liveMaestroSessionId: null,
        remountKind: 'automatic',
      }),
    ).toBe(true);
    expect(
      shouldSkipLeftoverRemount({
        mission: mission(),
        liveMaestroSessionId: null,
        remountKind: 'automatic',
        isLeftover: true,
      }),
    ).toBe(true);
  });

  it('kickoff fresco com recibo ainda pode nascer — não é leftover', () => {
    expect(
      shouldSkipLeftoverRemount({
        mission: mission(),
        liveMaestroSessionId: null,
        remountKind: 'automatic',
        isFreshKickoff: true,
      }),
    ).toBe(false);
  });

  it('Retomar do operador (operator) não é skip — religa o card', () => {
    expect(
      shouldSkipLeftoverRemount({
        mission: mission({
          status: 'blocked',
          description: leftoverIsolationPatch(mission()).description,
        }),
        liveMaestroSessionId: null,
        remountKind: 'operator',
      }),
    ).toBe(false);
  });
});

describe('siblingRunningMissionIds — Iniciar não empilha times', () => {
  it('não inclui a missão que está nascendo', () => {
    expect(
      siblingRunningMissionIds('nova', [{ id: 'nova' }, { id: 'velha-a' }, { id: 'velha-b' }]),
    ).toEqual(['velha-a', 'velha-b']);
  });

  it('lista vazia quando só existe a que inicia', () => {
    expect(siblingRunningMissionIds('só', [{ id: 'só' }])).toEqual([]);
  });
});

describe('pickFocusedRunningMission — só este processo', () => {
  it('ignora row leftover/running do disco sem Maestro vivo', () => {
    const leftover = mission({ id: 'disk-leftover', updatedAt: 99 });
    const focused = mission({ id: 'live-now', updatedAt: 1 });
    expect(
      pickFocusedRunningMission(
        [leftover, focused],
        new Map([['live-now', 'sess-1']]),
      )?.id,
    ).toBe('live-now');
    expect(pickFocusedRunningMission([leftover], new Map())).toBeNull();
  });

  it('após Encerrar, pickFocused ignora a row mesmo se o status ainda mentir running', () => {
    const encerrada = persistLeftoverIsolation(
      memoryWriter([mission({ id: 'mission-ebd1c3ee' })]),
      'mission-ebd1c3ee',
      'encerrar',
    )!;
    const stillLabeledRunning = {
      ...encerrada,
      status: 'running',
      intentState: 'executing',
    };
    expect(
      pickFocusedRunningMission(
        [stillLabeledRunning],
        new Map([['mission-ebd1c3ee', 'sess-zombie']]),
      ),
    ).toBeNull();
  });
});

describe('isFreshIniciarKickoff — Iniciar sem recibo', () => {
  it('idade <1s sem recibo e sem Maestro é fresco', () => {
    const now = Date.now();
    expect(
      isFreshIniciarKickoff({
        status: 'running',
        createdAt: now,
        updatedAt: now,
        sealedCount: 20,
        paneCount: 0,
        hasLiveMaestro: false,
        hasKickoffReceipt: false,
      }),
    ).toBe(true);
  });

  it('seladas ≥20 e panes 0 neste pid é fresco mesmo depois de 1s', () => {
    const now = Date.now() - 1500;
    expect(
      isFreshIniciarKickoff({
        status: 'running',
        createdAt: now,
        updatedAt: Date.now(),
        sealedCount: 20,
        paneCount: 0,
        hasLiveMaestro: false,
        hasKickoffReceipt: false,
      }),
    ).toBe(true);
  });

  it('leftover stale do disco não é fresco', () => {
    expect(
      isFreshIniciarKickoff({
        status: 'running',
        createdAt: 10,
        updatedAt: 10,
        sealedCount: 20,
        paneCount: 0,
        hasLiveMaestro: false,
        hasKickoffReceipt: false,
      }),
    ).toBe(false);
  });
});
