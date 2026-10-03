import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLicensedAccessMock } from '../__tests__/licensed-access';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
beforeEach(resetLicensedAccessMock);
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { ScopedMissionStore } from './mission-store';
import {
  ROUTE_DECISION_MAX_ROWS,
  ROUTE_DECISION_RETENTION_MS,
} from './route-decision-ledger';
import { clearRouteLog, recentRouteLog, recordRouteLog } from './route-log';

// F-773 (G6): o nexus_route_log era memória com teto de 50 e voltava vazio a
// cada boot. A linha agora persiste na tabela route_decisions do checkout.
describe('log de rota persistente (F-773)', () => {
  const scope = testProjectScope();
  let baseDir = '';
  let clock = 0;
  let runtimes: ProjectRuntimeManager[] = [];

  const open = () => {
    const runtime = new ProjectRuntimeManager({
      baseDir: path.join(baseDir, 'runtime'),
      appVersion: 'f773-route-log',
    });
    runtimes.push(runtime);
    return { runtime, store: new ScopedMissionStore(runtime, scope, { now: () => clock }) };
  };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f773-route-log-'));
    clock = 1_000 * 24 * 60 * 60 * 1000;
    clearRouteLog();
  });

  afterEach(() => {
    for (const runtime of runtimes) runtime.closeAll();
    runtimes = [];
    clearRouteLog();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('recordRouteLog persiste e recentRouteLog lê depois de recarregar o store', () => {
    const first = open();
    const missionId = first.store.create({
      title: 'Rota auditável',
      intentState: 'dispatched',
      intentVersion: 1,
      orchestratorSessionId: 'orch-session',
    }).id;
    recordRouteLog(
      {
        task: 'corrigir o parser de datas',
        tier: 'medium',
        adapterId: 'kimi',
        model: 'kimi-code/k3',
        effort: 'medium',
        reason: 'medium; multi-score; sucesso 14d: kimi:kimi-code/k3 0,90 (10), grok:grok-4.7 0,20 (10)',
        classifierSource: 'jev',
        confidence: { tier: 0.82 },
        ruleChoice: { adapterId: 'grok', model: 'grok-4.7' },
        missionId,
        alternatives: [{ adapterId: 'grok', model: 'grok-4.7' }, { adapterId: 'glm', model: 'glm-5.3' }],
      },
      first.store.routeDecisions,
    );
    clock += 1_000;
    recordRouteLog(
      { task: 'fan-out sem missão', tier: 'easy', adapterId: 'glm', reason: 'easy; sugestão livre' },
      first.store.routeDecisions,
    );
    first.runtime.closeAll();

    // Restart: a memória some; o checkout guarda.
    clearRouteLog();
    expect(recentRouteLog()).toEqual([]);
    const reloaded = open();
    const decisions = recentRouteLog(10, reloaded.store.routeDecisions);

    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ adapterId: 'glm', tier: 'easy', at: clock });
    expect(decisions[0]).not.toHaveProperty('missionId');
    expect(decisions[1]).toMatchObject({
      adapterId: 'kimi',
      model: 'kimi-code/k3',
      effort: 'medium',
      missionId,
      classifierSource: 'jev',
      confidence: { tier: 0.82 },
      ruleChoice: { adapterId: 'grok', model: 'grok-4.7' },
      alternatives: [{ adapterId: 'grok', model: 'grok-4.7' }, { adapterId: 'glm', model: 'glm-5.3' }],
      at: clock - 1_000,
    });
    expect(decisions[1]!.reason).toContain('sucesso 14d');
    expect(decisions[0]!.seq).toBeGreaterThan(decisions[1]!.seq);
    expect(recentRouteLog(1, reloaded.store.routeDecisions)).toHaveLength(1);
  });

  it('retenção: o que passou de 30 dias sai na próxima escrita', () => {
    const { store } = open();
    recordRouteLog({ task: 'antiga', tier: 'easy', adapterId: 'grok', reason: 'r' }, store.routeDecisions);
    clock += ROUTE_DECISION_RETENTION_MS + 1;
    recordRouteLog({ task: 'nova', tier: 'easy', adapterId: 'kimi', reason: 'r' }, store.routeDecisions);
    expect(recentRouteLog(10, store.routeDecisions).map((entry) => entry.taskPreview)).toEqual(['nova']);
  });

  it('teto de linhas: a escrita mantém só as últimas 5.000', () => {
    const { runtime, store } = open();
    const db = runtime.open(scope).db;
    const insert = db.prepare(
      `INSERT INTO route_decisions (task_preview, tier, adapter_id, reason, created_at)
       VALUES (?, 'easy', 'grok', 'r', ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < ROUTE_DECISION_MAX_ROWS; index += 1) insert.run(`t${index}`, clock);
    })();
    recordRouteLog({ task: 'a mais nova', tier: 'easy', adapterId: 'kimi', reason: 'r' }, store.routeDecisions);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM route_decisions`).get()).toEqual({
      count: ROUTE_DECISION_MAX_ROWS,
    });
    expect(recentRouteLog(1, store.routeDecisions)[0]).toMatchObject({ taskPreview: 'a mais nova' });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM route_decisions WHERE task_preview = 't0'`).get(),
    ).toEqual({ count: 0 });
  });

  it('JSON ruim numa linha não cega a leitura: o campo some, a linha fica', () => {
    const { runtime, store } = open();
    runtime
      .open(scope)
      .db.prepare(
        `INSERT INTO route_decisions
           (task_preview, tier, adapter_id, reason, confidence_json, alternatives_json, created_at)
         VALUES ('editada à mão', 'easy', 'grok', 'r', '{quebrado', '[{"adapterId":"kimi","segredo":"x"}]', ?)`,
      )
      .run(clock);
    const [entry] = recentRouteLog(5, store.routeDecisions);
    expect(entry).toMatchObject({ taskPreview: 'editada à mão', alternatives: [{ adapterId: 'kimi' }] });
    expect(entry).not.toHaveProperty('confidence');
    expect(JSON.stringify(entry)).not.toContain('segredo');
  });

  it('missão inexistente: a escrita falha, a rota não, e a memória guarda a linha', () => {
    const { store } = open();
    const entry = recordRouteLog(
      { task: 't', tier: 'easy', adapterId: 'grok', reason: 'r', missionId: 'mission-fantasma' },
      store.routeDecisions,
    );
    expect(entry.adapterId).toBe('grok');
    expect(recentRouteLog(5, store.routeDecisions)).toEqual([]);
    expect(recentRouteLog(5)).toMatchObject([{ adapterId: 'grok' }]);
  });
});
