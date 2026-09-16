/**
 * Testes de invariante para a API real de mission-leadership.ts, escritos
 * contra os 6 invariantes combinados com o operador. O fixture de ports
 * abaixo é uma implementação mínima e fiel de MissionLeadershipPorts — sem
 * port de terminate (não existe: o motor nunca mata sessão), com A
 * (missions), C (panes → claim 'mission-panes') e D (sessionContexts →
 * claim 'gate', revogado por sessão a cada replaceRuntimeLeader).
 */
import { describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  MissionLeadership,
  type LeadershipChange,
  type LeadershipClaim,
  type LeadershipSession,
  type MissionLeadershipPorts,
} from './mission-leadership';

const scope = testProjectScope();
const MISSION_ID = 'mission-1';

type RuntimeSnapshot = Map<string, { missionId: string; paneId: string } | null>;
type Origin = 'spawn' | 'adopt' | 'respawn' | 'promote';

function depsFixture() {
  const missions = new Map<string, string | null>();
  const panes = new Map<string, { paneId: string; sessionId: string } | null>();
  const sessionContexts: RuntimeSnapshot = new Map();
  const sessions = new Map<string, LeadershipSession>();
  const missionWrites: Array<string | null> = [];
  const events: LeadershipChange[] = [];

  const ports: MissionLeadershipPorts<RuntimeSnapshot> = {
    readMission: (missionId) => ({ orchestratorSessionId: missions.get(missionId) ?? null }),
    readClaims: (missionId) => {
      const claims: LeadershipClaim[] = [];
      const paneClaim = panes.get(missionId);
      if (paneClaim) {
        claims.push({ source: 'mission-panes', sessionId: paneClaim.sessionId, paneId: paneClaim.paneId });
      }
      for (const [sessionId, ctx] of sessionContexts) {
        if (ctx && ctx.missionId === missionId) {
          claims.push({ source: 'gate', sessionId, paneId: ctx.paneId });
        }
      }
      return claims;
    },
    readSession: (sessionId) => sessions.get(sessionId) ?? null,
    transaction: (commit) => commit(),
    setDurableLeader: (missionId, leader) => {
      missionWrites.push(leader.sessionId);
      missions.set(missionId, leader.sessionId);
      return true;
    },
    replacePaneLeader: (missionId, leader) => {
      panes.set(missionId, { paneId: leader.paneId, sessionId: leader.sessionId });
      return true;
    },
    captureRuntime: () => new Map(sessionContexts),
    replaceRuntimeLeader: (missionId, leader) => {
      for (const [sessionId, ctx] of sessionContexts) {
        if (ctx && ctx.missionId === missionId && sessionId !== leader.sessionId) {
          sessionContexts.set(sessionId, null);
        }
      }
      sessionContexts.set(leader.sessionId, { missionId, paneId: leader.paneId });
      return true;
    },
    restoreRuntime: (_missionId, snapshot) => {
      sessionContexts.clear();
      for (const [sessionId, ctx] of snapshot) sessionContexts.set(sessionId, ctx);
    },
    emitLeadershipChanged: (event) => {
      events.push(event);
    },
  };

  const forScope = vi.fn(() => ports);
  const engine = new MissionLeadership<RuntimeSnapshot>({ forScope });

  function registerSession(sessionId: string, paneId: string, state: string): void {
    sessions.set(sessionId, { sessionId, paneId, scope, missionId: MISSION_ID, state });
  }

  return { engine, missions, panes, sessionContexts, sessions, missionWrites, events, registerSession };
}

describe('resolveMissionLeader (2) — líder durável morto nunca vira null nem pane morto como vivo', () => {
  it('sessão durável morta → proven:false, mas devolve o líder, nunca null', () => {
    const f = depsFixture();
    f.registerSession('session-dead', 'pane-1', 'exited');
    f.missions.set(MISSION_ID, 'session-dead');

    const leader = f.engine.resolveMissionLeader(scope, MISSION_ID);

    expect(leader).not.toBeNull();
    expect(leader?.sessionId).toBe('session-dead');
    expect(leader?.paneId).toBe('pane-1');
    expect(leader?.proven).toBe(false);
    expect(leader?.source).toBe('durable');
  });

  it('sessão durável viva → proven:true', () => {
    const f = depsFixture();
    f.registerSession('session-live', 'pane-1', 'busy');
    f.missions.set(MISSION_ID, 'session-live');

    const leader = f.engine.resolveMissionLeader(scope, MISSION_ID);

    expect(leader?.proven).toBe(true);
    expect(leader?.sessionId).toBe('session-live');
  });

  it('sem líder durável nem claim viva → null', () => {
    const f = depsFixture();
    expect(f.engine.resolveMissionLeader(scope, MISSION_ID)).toBeNull();
  });
});

describe('invariante 1 — nunca dois líderes com sessão viva na mesma missão', () => {
  it.each(['spawn', 'adopt', 'respawn', 'promote'] as const)(
    "origin '%s' sobre um líder JÁ vivo é recusado — nunca instala um segundo líder",
    (origin: Origin) => {
      const f = depsFixture();
      f.registerSession('session-a', 'pane-a', 'busy');
      f.registerSession('session-b', 'pane-b', 'busy');
      f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-a', paneId: 'pane-a', origin: 'spawn' });

      expect(() =>
        f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-b', paneId: 'pane-b', origin }),
      ).toThrow(/leadership_existing_session/);

      expect(f.engine.resolveMissionLeader(scope, MISSION_ID)?.sessionId).toBe('session-a');
      expect(() => f.engine.assertSingleLeader(scope, MISSION_ID)).not.toThrow();
      expect(f.missionWrites.every((value) => Boolean(value))).toBe(true);
    },
  );
});

describe("invariante 3 — origin:'adopt' NUNCA termina sessão alguma (não há port de terminate)", () => {
  it('adota um pane vivo sem líder anterior — a sessão não é tocada', () => {
    const f = depsFixture();
    f.registerSession('session-adopted', 'pane-1', 'busy');
    const before = structuredClone(f.sessions.get('session-adopted'));

    f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-adopted', paneId: 'pane-1', origin: 'adopt' });

    expect(f.sessions.get('session-adopted')).toEqual(before);
  });

  it('outro líder JÁ vivo registrado → recusa (leadership_existing_session), e o líder antigo segue intacto', () => {
    const f = depsFixture();
    f.registerSession('session-old', 'pane-old', 'busy');
    f.registerSession('session-adopted', 'pane-new', 'busy');
    f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-old', paneId: 'pane-old', origin: 'spawn' });
    const before = structuredClone(f.sessions.get('session-old'));

    expect(() =>
      f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-adopted', paneId: 'pane-new', origin: 'adopt' }),
    ).toThrow(/leadership_existing_session/);

    expect(f.sessions.get('session-old')).toEqual(before);
    expect(f.engine.resolveMissionLeader(scope, MISSION_ID)?.sessionId).toBe('session-old');
  });

  it.each(['adopt', 'promote'] as const)(
    "outro líder EXITED (não vivo) → origin '%s' passa, e a sessão antiga não é apagada nem alterada",
    (origin: 'adopt' | 'promote') => {
      const f = depsFixture();
      f.registerSession('session-old', 'pane-old', 'busy');
      f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-old', paneId: 'pane-old', origin: 'spawn' });
      // a sessão antiga sai por fora do motor — quem prova isso é o próprio state.
      f.sessions.set('session-old', { ...f.sessions.get('session-old')!, state: 'exited' });
      f.registerSession('session-new', 'pane-new', 'busy');
      const before = structuredClone(f.sessions.get('session-old'));

      f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-new', paneId: 'pane-new', origin });

      expect(f.sessions.get('session-old')).toEqual(before);
      expect(f.engine.resolveMissionLeader(scope, MISSION_ID)?.sessionId).toBe('session-new');
    },
  );
});

describe("invariante 4 — origin:'respawn' com líder VIVO: recusa explícita, nunca fica sem líder", () => {
  it('respawn sobre líder ainda registrado (vivo) é recusado — A nunca fica vazia, líder antigo segue', () => {
    const f = depsFixture();
    f.registerSession('session-old', 'pane-old', 'busy');
    f.registerSession('session-new', 'pane-new', 'busy');
    f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-old', paneId: 'pane-old', origin: 'spawn' });

    expect(() =>
      f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-new', paneId: 'pane-new', origin: 'respawn' }),
    ).toThrow(/leadership_existing_session/);

    expect(f.missionWrites.every((value) => Boolean(value))).toBe(true);
    expect(f.engine.resolveMissionLeader(scope, MISSION_ID)?.sessionId).toBe('session-old');
    expect(f.sessions.get('session-old')?.state).toBe('busy');
  });

  it('respawn sobre líder EXITED também é recusado — spawn/respawn contam até registro morto', () => {
    const f = depsFixture();
    f.registerSession('session-old', 'pane-old', 'busy');
    f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-old', paneId: 'pane-old', origin: 'spawn' });
    f.sessions.set('session-old', { ...f.sessions.get('session-old')!, state: 'exited' });
    f.registerSession('session-new', 'pane-new', 'busy');

    expect(() =>
      f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-new', paneId: 'pane-new', origin: 'respawn' }),
    ).toThrow(/leadership_existing_session/);

    expect(f.engine.resolveMissionLeader(scope, MISSION_ID)?.sessionId).toBe('session-old');
  });

  it('respawn sem NENHUM registro anterior funciona como um spawn normal', () => {
    const f = depsFixture();
    f.registerSession('session-new', 'pane-new', 'busy');

    const result = f.engine.applyLeadership(scope, MISSION_ID, {
      sessionId: 'session-new', paneId: 'pane-new', origin: 'respawn',
    });

    expect(result.leader.sessionId).toBe('session-new');
    expect(f.engine.resolveMissionLeader(scope, MISSION_ID)?.sessionId).toBe('session-new');
  });
});

describe('invariante 5 — applyLeadership escreve as 3 fontes duráveis (A, C, D) e emite UM evento', () => {
  it.each(['spawn', 'adopt', 'respawn', 'promote'] as const)(
    "origin '%s' numa missão sem líder anterior: A, C e D concordam, e sai exatamente 1 evento",
    (origin: Origin) => {
      const f = depsFixture();
      f.registerSession('session-1', 'pane-1', 'busy');

      const result = f.engine.applyLeadership(scope, MISSION_ID, { sessionId: 'session-1', paneId: 'pane-1', origin });

      expect(f.missions.get(MISSION_ID)).toBe('session-1');
      expect(f.panes.get(MISSION_ID)).toEqual({ paneId: 'pane-1', sessionId: 'session-1' });
      expect(f.sessionContexts.get('session-1')).toEqual({ missionId: MISSION_ID, paneId: 'pane-1' });
      expect(f.events).toHaveLength(1);
      expect(f.events[0]).toMatchObject({
        type: 'mission-leadership-changed',
        missionId: MISSION_ID,
        sessionId: 'session-1',
        paneId: 'pane-1',
        origin,
      });
      expect(result.rendererNotified).toBe(true);
    },
  );
});

describe('invariante 6 — split-brain detectável entre as fontes duráveis', () => {
  it('A diz X e C diz Y → assertSingleLeader lança nomeando as duas sessões', () => {
    const f = depsFixture();
    f.missions.set(MISSION_ID, 'session-x');
    f.panes.set(MISSION_ID, { paneId: 'pane-y', sessionId: 'session-y' });

    let thrown: unknown;
    try {
      f.engine.assertSingleLeader(scope, MISSION_ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('leadership_split_brain');
    expect(message).toContain('session-x');
    expect(message).toContain('session-y');
  });

  it('A e C concordando → assertSingleLeader não lança', () => {
    const f = depsFixture();
    f.missions.set(MISSION_ID, 'session-x');
    f.panes.set(MISSION_ID, { paneId: 'pane-x', sessionId: 'session-x' });

    expect(() => f.engine.assertSingleLeader(scope, MISSION_ID)).not.toThrow();
  });

  it('C ausente (só A registrado) não é split-brain — não lança', () => {
    const f = depsFixture();
    f.missions.set(MISSION_ID, 'session-x');

    expect(() => f.engine.assertSingleLeader(scope, MISSION_ID)).not.toThrow();
  });
});
