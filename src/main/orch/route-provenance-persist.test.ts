import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MISSIONLESS_WINDOW_MS,
  clearRouteProvenance,
  configureMissionlessPersistence,
  missionlessRouteCountsByAdapterSince,
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

  it('reinício simulado mantém a contagem por modelo', () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude', model: 'opus', specialty: 'visual' }, now - 1000);
    recordMissionlessRouteDecision({ adapterId: 'claude', model: 'opus', specialty: 'visual' }, now - 500);
    recordMissionlessRouteDecision({ adapterId: 'kimi', model: 'k3', specialty: 'visual' }, now - 100);
    configureMissionlessPersistence(dir); // reinício: memória zera, disco fica
    expect(missionlessRouteCountsByAdapterSince(now - 60_000)).toEqual(
      new Map([['visual:', 0], ['claude', 2], ['visual:claude:opus', 2], ['kimi', 1], ['visual:kimi:k3', 1]]),
    );
  });

  it('arquivo corrompido, não-array ou gigante vira vazio e a gravação seguinte recupera', () => {
    for (const bad of ['{{not json', '{"a":1}', 'x'.repeat(70 * 1024)]) {
      fs.writeFileSync(file(), bad);
      configureMissionlessPersistence(dir);
      expect(missionlessRouteCountsByAdapterSince(0)).toEqual(new Map([['visual:', 0]]));
    }
    recordMissionlessRouteDecision({ adapterId: 'codex' });
    configureMissionlessPersistence(dir);
    expect(missionlessRouteCountsByAdapterSince(0).get('codex')).toBe(1);
  });

  it('entradas com mais de 7 dias expiram e entradas inválidas são descartadas', () => {
    const now = Date.now();
    fs.writeFileSync(
      file(),
      JSON.stringify([
        { adapterId: 'claude', at: now - MISSIONLESS_WINDOW_MS - 1000 },
        { adapterId: 'kimi', at: now - 1000 },
        { adapterId: 42, at: now },
      ]),
    );
    configureMissionlessPersistence(dir);
    expect(missionlessRouteCountsByAdapterSince(0)).toEqual(new Map([['visual:', 0], ['kimi', 1]]));
    recordMissionlessRouteDecision({ adapterId: 'codex' });
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as Array<{ adapterId: string }>;
    expect(saved.map((u) => u.adapterId)).toEqual(['kimi', 'codex']);
  });
});
