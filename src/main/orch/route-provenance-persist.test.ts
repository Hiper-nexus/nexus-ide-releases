import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DECISION_GRACE_MS,
  MISSIONLESS_WINDOW_MS,
  ROUTE_USE_PRUNE_WINDOW_MS,
  clearRouteProvenance,
  configureMissionlessPersistence,
  flushRouteProvenance,
  listDurableRouteUses,
  missionlessRouteCountsByAdapterSince,
  recordAgentSpawn,
  recordMissionlessRouteDecision,
} from './route-provenance';

// F-1421: o revezamento visual sem missão sobrevive a reinício.
describe('persistência da memória de rotas sem missão (F-1421)', () => {
  let dir: string;
  const file = () => path.join(dir, 'missionless-route-uses.json');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-prov-'));
    configureMissionlessPersistence(dir);
  });
  afterEach(() => {
    configureMissionlessPersistence(undefined);
    clearRouteProvenance();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reinício simulado mantém a contagem por modelo', async () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude', model: 'opus', specialty: 'visual' }, now - 1000);
    recordMissionlessRouteDecision({ adapterId: 'claude', model: 'opus', specialty: 'visual' }, now - 500);
    recordMissionlessRouteDecision({ adapterId: 'kimi', model: 'k3', specialty: 'visual' }, now - 100);
    await flushRouteProvenance();
    configureMissionlessPersistence(dir); // reinício: memória zera, disco fica
    expect(missionlessRouteCountsByAdapterSince(now - 60_000)).toEqual(
      new Map([['visual:', 0], ['claude', 2], ['visual:claude:opus', 2], ['kimi', 1], ['visual:kimi:k3', 1]]),
    );
  });

  it('arquivo corrompido, não-array ou gigante vira vazio e a gravação seguinte recupera', async () => {
    for (const bad of ['{{not json', '{"a":1}', 'x'.repeat(1024 * 1024 + 1)]) {
      fs.writeFileSync(file(), bad);
      configureMissionlessPersistence(dir);
      expect(missionlessRouteCountsByAdapterSince(0)).toEqual(new Map([['visual:', 0]]));
    }
    recordMissionlessRouteDecision({ adapterId: 'codex' });
    await flushRouteProvenance();
    configureMissionlessPersistence(dir);
    expect(missionlessRouteCountsByAdapterSince(0).get('codex')).toBe(1);
  });

  it('entradas com mais de 30 dias expiram e entradas inválidas são descartadas', async () => {
    const now = Date.now();
    fs.writeFileSync(
      file(),
      JSON.stringify([
        { adapterId: 'claude', at: now - ROUTE_USE_PRUNE_WINDOW_MS - 1000 },
        { adapterId: 'kimi', at: now - 1000 },
        { adapterId: 42, at: now },
      ]),
    );
    configureMissionlessPersistence(dir);
    expect(missionlessRouteCountsByAdapterSince(0)).toEqual(new Map([['visual:', 0], ['kimi', 1]]));
    recordMissionlessRouteDecision({ adapterId: 'codex' });
    await flushRouteProvenance();
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as Array<{ adapterId: string }>;
    expect(saved.map((u) => u.adapterId)).toEqual(['kimi', 'codex']);
  });

  it('entradas com mais de 7 dias são preservadas em disco mas filtradas na consulta de 7d', async () => {
    const now = Date.now();
    // 10 dias atrás: > 7d (fora da janela do fair-share), mas < 30d (dentro do prune)
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    recordAgentSpawn({ adapterId: 'claude', sessionId: 's-old' }, tenDaysAgo);
    recordAgentSpawn({ adapterId: 'kimi', sessionId: 's-fresh' }, now - 1000);

    await flushRouteProvenance();
    configureMissionlessPersistence(dir); // simula reinício
    // Janela de 7 dias ignora o evento de 10 dias
    const counts7d = missionlessRouteCountsByAdapterSince(now - MISSIONLESS_WINDOW_MS);
    expect(counts7d.get('claude')).toBeUndefined();
    expect(counts7d.get('kimi')).toBe(1);

    // Consulta irrestrita (sinceMs = 0) ainda vê ambos pois não foram podados do disco
    const countsAll = missionlessRouteCountsByAdapterSince(0);
    expect(countsAll.get('claude')).toBe(1);
    expect(countsAll.get('kimi')).toBe(1);
  });

  it('arquivo anterior sem `kind` carrega: sessionId = spawn, sem sessionId = decisão', () => {
    const now = Date.now();
    fs.writeFileSync(
      file(),
      JSON.stringify([
        { adapterId: 'claude', model: 'claude-opus-5-5', sessionId: 'legacy-spawn', at: now - 1000 },
        { adapterId: 'kimi', at: now - DECISION_GRACE_MS - 1000 },
        { adapterId: 'codex', at: now - 1000 },
      ]),
    );
    configureMissionlessPersistence(dir);

    // spawn legado continua contando; decisão legada vencida some
    const counts = missionlessRouteCountsByAdapterSince(0);
    expect(counts.get('claude')).toBe(1);
    expect(counts.get('kimi')).toBeUndefined();
    expect(counts.get('codex')).toBe(1);

    // a decisão legada ainda dentro da validade é consumível pelo spawn
    recordAgentSpawn({ adapterId: 'codex', sessionId: 'fresh' }, now);
    const after = listDurableRouteUses();
    expect(after).toHaveLength(3);
    expect(after[2]?.sessionId).toBe('fresh');
    expect(after[2]?.kind).toBe('spawn');
    expect(missionlessRouteCountsByAdapterSince(0).get('codex')).toBe(1);
  });
});
