import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../persistence/db';
import { initHandoffStore, submitHandoff } from '../orch/handoff-store';
import {
  createMission,
  initMissionStore,
  setMissionStatus,
} from '../orch/mission-store';
import { createTask, initTaskStore, updateTask } from '../orch/task-store';
import {
  initMissionPaneStore,
  recordMissionPane,
} from '../orch/mission-pane-store';
import { initSquadStore, saveSquad } from '../orch/squad-store';
import { initUsageStore, recordUsage } from '../usage/usage-store';
import { initMediaUsageStore } from '../usage/media-usage-store';
import { GAMIFICATION_CHANNELS } from '../../shared/gamification-types';
import { getMeta, listXpEvents } from './gamification-store';
import {
  buildSnapshot,
  doPrestige,
  hasGreenEvidence,
  initGamificationService,
  recordMediaGeneratedForGamification,
  shutdownGamificationService,
} from './gamification-service';

// better-sqlite3 é módulo nativo; rebuildado p/ Electron não carrega no node
// do vitest — os testes de SQL viram skip, não falha (padrão do repo).
let sqlite: (new (file: string) => Db) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sqlite = require('better-sqlite3') as new (file: string) => Db;
  new sqlite(':memory:').close();
} catch {
  sqlite = null;
}

const GREEN_ARTIFACT = { kind: 'verification', command: 'npm test', exitCode: 0 };

describe('hasGreenEvidence (puro)', () => {
  it('extrai comando com exit 0; senão null', () => {
    expect(hasGreenEvidence([GREEN_ARTIFACT])).toBe('npm test (exit 0)');
    expect(hasGreenEvidence([{ kind: 'verification', command: 'x', exitCode: 1 }])).toBeNull();
    expect(hasGreenEvidence([{ kind: 'file', path: 'a.ts' }, 'texto', null])).toBeNull();
    expect(hasGreenEvidence([])).toBeNull();
  });
});

// Subconjunto do schema real (persistence/db.ts) usado pelos stores orch.
const ORCH_TABLES = `
CREATE TABLE IF NOT EXISTS squads (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  builtin                   INTEGER NOT NULL DEFAULT 0,
  orchestrator_instructions TEXT NOT NULL DEFAULT '',
  native_instructions       TEXT NOT NULL DEFAULT '',
  roster_json               TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS missions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  squad_id        TEXT,
  milestones_json TEXT NOT NULL DEFAULT '[]',
  orch_session_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_panes (
  id         TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  model      TEXT,
  effort     TEXT,
  cwd        TEXT,
  title      TEXT NOT NULL,
  agent_name TEXT,
  role       TEXT NOT NULL DEFAULT 'worker',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  session_id     TEXT,
  from_agent     TEXT,
  status         TEXT NOT NULL,
  summary        TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  delivered      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  mission_id TEXT,
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

describe.skipIf(!sqlite)('gamification-service (SQLite real)', () => {
  afterEach(() => {
    shutdownGamificationService();
  });

  function makeDb(): Db {
    const db = new (sqlite as new (file: string) => Db)(':memory:');
    db.exec(ORCH_TABLES);
    initUsageStore(db);
    initMediaUsageStore(db);
    return db;
  }

  /** Hidrata os stores singleton do orch a partir do db do teste. */
  function bootStores(db: Db): void {
    initSquadStore(db);
    initMissionStore(db);
    initMissionPaneStore(db);
    initHandoffStore(db);
    initTaskStore(db);
  }

  function bootService(db: Db, over: { sober?: boolean } = {}) {
    const broadcast = vi.fn();
    initGamificationService({
      db,
      broadcast,
      now: () => Date.now(),
      soberMode: () => over.sober ?? false,
    });
    return { broadcast };
  }

  function narrations(broadcast: ReturnType<typeof vi.fn>): string[] {
    return broadcast.mock.calls
      .filter(([channel]) => channel === 'voice:narrate')
      .map(([, payload]) => (payload as { text: string }).text);
  }

  it('handoff success SEM evidência vira handoff_success (peso simples)', () => {
    const db = makeDb();
    bootStores(db);
    bootService(db);
    const h = submitHandoff({ status: 'success', summary: 'entrega simples de teste' });
    const events = listXpEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('handoff_success');
    expect(events[0].entityKey).toBe(`handoff:${h.id}`);
    expect(events[0].points).toBe(3_000);
    db.close();
  });

  it('handoff success COM evidência vira handoff_green (com evidência gravada)', () => {
    const db = makeDb();
    bootStores(db);
    bootService(db);
    submitHandoff({
      status: 'success',
      summary: 'entrega verificada de teste',
      artifacts: [GREEN_ARTIFACT],
    });
    const events = listXpEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('handoff_green');
    expect(events[0].points).toBe(8_000);
    expect(events[0].evidence).toBe('npm test (exit 0)');
    // failed/blocked não pontuam
    submitHandoff({ status: 'failed', summary: 'tentativa que falhou mesmo' });
    expect(listXpEvents(db)).toHaveLength(1);
    db.close();
  });

  it('missão done com handoff verde + custo na banda = mission_green com bônus', () => {
    const db = makeDb();
    bootStores(db);
    bootService(db);
    const m = createMission({ title: 'Missão eficiente' });
    recordMissionPane({ missionId: m.id, adapterId: 'claude', effort: 'medium' });
    // custo real barato (bem abaixo da banda medium de US$0.75)
    recordUsage(db, {
      sessionId: 's1',
      messageId: 'msg-1',
      model: 'claude-sonnet-5',
      inputTokens: 10_000,
      outputTokens: 10_000,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      timestamp: 1,
      missionId: m.id,
    });
    submitHandoff({
      status: 'success',
      summary: 'implementação verificada da missão',
      artifacts: [GREEN_ARTIFACT],
      missionId: m.id,
    });
    setMissionStatus(m.id, 'done');
    const mission = listXpEvents(db).find((e) => e.entityKey === `mission:${m.id}`);
    expect(mission?.kind).toBe('mission_green');
    // 25000 × effort medium (1) × diminishing(0) × (1 + bônus 0.5) = 37500
    expect(mission?.points).toBe(37_500);
    expect(buildSnapshot().counters.efficient_mission).toBe(1);
    db.close();
  });

  it('idempotência: re-varredura não duplica eventos nem re-narra conquista', () => {
    const db = makeDb();
    bootStores(db);
    const { broadcast } = bootService(db);
    submitHandoff({
      status: 'success',
      summary: 'primeira entrega verificada',
      artifacts: [GREEN_ARTIFACT],
    });
    const eventsAfterFirst = listXpEvents(db).length;
    const narratedAfterFirst = narrations(broadcast).length;
    // nova mudança de store re-varre tudo; nada novo a pontuar
    submitHandoff({ status: 'partial', summary: 'progresso parcial reportado' });
    expect(listXpEvents(db)).toHaveLength(eventsAfterFirst);
    expect(narrations(broadcast)).toHaveLength(narratedAfterFirst);
    db.close();
  });

  it('level-up narra "Subiu para INICIADO."; modo sóbrio suprime narração', () => {
    const db = makeDb();
    bootStores(db);
    const { broadcast } = bootService(db);
    for (let i = 0; i < 4; i += 1) {
      const m = createMission({ title: `Missão ${i}` });
      submitHandoff({
        status: 'success',
        summary: `entrega verificada da missão ${i}`,
        artifacts: [GREEN_ARTIFACT],
        missionId: m.id,
      });
      setMissionStatus(m.id, 'done');
    }
    // 4×25000 (missões) + 4×8000 (handoffs) = 132000 ≥ 100000 (INICIADO)
    expect(buildSnapshot().tier).toBe('INICIADO');
    expect(narrations(broadcast)).toContain('Subiu para INICIADO.');
    shutdownGamificationService();

    // Mesmo jogo em modo sóbrio: XP acumula, voz fica muda.
    const db2 = makeDb();
    bootStores(db2);
    const { broadcast: b2 } = bootService(db2, { sober: true });
    const m = createMission({ title: 'Missão silenciosa' });
    submitHandoff({
      status: 'success',
      summary: 'entrega verificada em silêncio',
      artifacts: [GREEN_ARTIFACT],
      missionId: m.id,
    });
    setMissionStatus(m.id, 'done');
    expect(listXpEvents(db2).length).toBeGreaterThan(0);
    expect(narrations(b2)).toHaveLength(0);
    db.close();
    db2.close();
  });

  it('retro: replay marca replayDone, usa peso simples e NUNCA narra', () => {
    const db = makeDb();
    bootStores(db);
    // histórico pré-existente ANTES do service nascer
    const m = createMission({ title: 'Missão antiga' });
    setMissionStatus(m.id, 'done');
    submitHandoff({
      status: 'success',
      summary: 'entrega antiga com evidência',
      artifacts: [GREEN_ARTIFACT],
      missionId: m.id,
    });
    const t = createTask({ title: 'Task antiga' });
    updateTask(t.id, { status: 'done' });

    const { broadcast } = bootService(db);
    expect(getMeta(db, 'replayDone')).toBe('1');
    const events = listXpEvents(db);
    const byKey = new Map(events.map((e) => [e.entityKey, e]));
    // verde histórico NÃO existe: peso simples, mesmo com artifact compatível
    expect(byKey.get(`mission:${m.id}`)?.kind).toBe('mission_done');
    expect(byKey.get(`mission:${m.id}`)?.points).toBe(10_000);
    expect(byKey.get(`mission:${m.id}`)?.retro).toBe(true);
    expect(events.find((e) => e.kind === 'handoff_success')?.points).toBe(3_000);
    expect(byKey.get(`task_done:${t.id}`)?.points).toBe(5_000);
    expect(narrations(broadcast)).toHaveLength(0);
    db.close();
  });

  it('snapshot completo: streak, conquistas, skins, counters por categoria', () => {
    // Só timers falsos (Date real): deixa o broadcast coalescido de 1s disparar.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const db = makeDb();
    bootStores(db);
    saveSquad({
      id: 'squad-teste',
      name: 'Squad Teste',
      createdAt: '2026-07-06',
      agents: [
        { id: 'ag-rev', agentName: 'revisora', category: 'reviewer', cli: 'claude' },
      ],
    });
    const { broadcast } = bootService(db);
    submitHandoff({
      status: 'success',
      summary: 'revisão verificada e entregue',
      artifacts: [GREEN_ARTIFACT],
      fromAgent: 'revisora',
    });
    const t = createTask({ title: 'Feature' });
    updateTask(t.id, { status: 'done' });
    recordMediaGeneratedForGamification('image', null);

    const snap = buildSnapshot();
    // 8000 (handoff_green) + 5000 (task_done) + 1000 (media) = 14000
    expect(snap.powerLevel).toBe(14_000);
    expect(snap.tier).toBe('RECRUTA');
    expect(snap.tierFloor).toBe('RECRUTA');
    expect(snap.nextTierAt).toBe(100_000);
    expect(snap.streakDays).toBe(1);
    expect(snap.shieldsLeft).toBe(2);
    expect(snap.counters.deliveries_reviewer).toBe(1);
    expect(snap.counters.media_image).toBe(1);
    expect(snap.achievements).toContain('primeira-imagem');
    expect(snap.prestige).toBe(0);
    expect(snap.prestigeReady).toBe(false);
    expect(snap.ruleVersion).toBe(1);
    expect(narrations(broadcast)).toContain('Conquista desbloqueada: Pintor Pixel.');
    // prestígio bloqueado antes de LENDA+limiar: no-op
    expect(doPrestige().prestige).toBe(0);
    // broadcast de snapshot usa o canal changed (coalescido em 1s)
    vi.advanceTimersByTime(1_100);
    const channels = broadcast.mock.calls.map(([c]) => c);
    expect(channels).toContain(GAMIFICATION_CHANNELS.changed);
    vi.useRealTimers();
    db.close();
  });
});
