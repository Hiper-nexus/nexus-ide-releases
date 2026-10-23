import { describe, expect, it } from 'vitest';
import { migrateModelId } from './model-defaults';
import { buildPtySpawnRequest } from '../renderer/terminal/spawn-request';
import { balanceSquadRosterCli } from '../renderer/orch/squad-roster';
import type { SquadAgent } from './orch-types';

const retired = 'minimax/MiniMax-M3.1-Flash-Preview';
const ga = 'minimax/MiniMax-M3.1-Flash';

describe('F-1649: MiniMax retired alias at real consumers', () => {
  it('migrates only the exact scoped Preview id and is idempotent', () => {
    expect(migrateModelId(retired)).toBe(ga);
    expect(migrateModelId(` ${retired} `)).toBe(ga);
    expect(migrateModelId(migrateModelId(retired))).toBe(ga);
    for (const id of [ga, 'minimax/MiniMax-M3', 'minimax/MiniMax-M2.7',
      'minimax/MiniMax-M2.7-highspeed', 'MiniMax-M3.1-Flash-Preview',
      'other/MiniMax-M3.1-Flash-Preview', `${retired}-custom`]) {
      expect(migrateModelId(id)).toBe(id);
    }
    expect(migrateModelId(undefined)).toBeUndefined();
  });

  it('migrates a saved pane spawn without changing its account or input object', () => {
    const pane = { kind: 'cli-agent' as const, id: 'fixture-pane', adapterId: 'minimax-code',
      model: retired, accountId: 'fixture-account', cwd: '/fixture' };
    const request = buildPtySpawnRequest({ pane, cols: 80, rows: 24,
      resume: false, resumeLatestOnly: false, restorePersistedAuthority: false });
    expect(request).toMatchObject({ adapterId: 'minimax-code', model: ga, accountId: 'fixture-account' });
    expect(pane.model).toBe(retired);
  });

  it('migrates a saved squad model through roster preparation, without changing CLI or grants', () => {
    const agent: SquadAgent = { id: 'fixture-worker', agentName: 'fixture-worker', category: 'executor',
      cli: 'minimax-code', model: retired, allowedTools: ['fixture-tool'], effort: 'medium' };
    const [prepared] = balanceSquadRosterCli([agent], [{ id: 'minimax-code', installed: true,
      enabled: true, autonomousWorkspaceWriteCapable: true, taskHandoffCapable: true }]);
    expect(prepared).toEqual({ ...agent, model: ga });
    expect(agent.model).toBe(retired);
  });
});
