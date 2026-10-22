import { describe, expect, it } from 'vitest';
import { buildPtySpawnRequest } from './spawn-request';
import { spawnRequestSchema, workspaceLayoutSchema } from '../../shared/ipc';
import { chooseAccount } from '../../main/persistence/account-select';

const basePane = {
  kind: 'cli-agent' as const,
  cwd: '/workspace/proj',
  adapterId: 'muse',
  model: 'opus',
  accountId: 'acc-1',
  effort: 'high',
  orchRequestId: 'orch-1',
  id: 'pane-1',
};

describe('buildPtySpawnRequest', () => {
  const automaticPane = {
    ...basePane, adapterId: 'claude', orchRequestId: undefined,
    accountSelection: 'automatic' as const,
  };
  const fresh = { cols: 80, rows: 24, resume: false, resumeLatestOnly: false,
    restorePersistedAuthority: false };

  it('reavalia a conta automática persistida: 99% semanal cede à irmã com folga', () => {
    const layout = workspaceLayoutSchema.parse({
      root: { kind: 'leaf', id: 'leaf-1', pane: { ...automaticPane, title: 'Claude' } },
      focusedPaneId: 'pane-1',
    });
    if (layout.root.kind !== 'leaf') throw new Error('expected leaf');
    const req = buildPtySpawnRequest({ ...fresh, pane: layout.root.pane, accountId: 'acc-1' });
    const accounts = ['acc-1', 'acc-2'].map((id, createdAt) => ({
      id, createdAt, adapterId: 'claude', label: id, mode: 'subscription' as const, upstream: 'anthropic',
    }));
    const now = 1_000_000;
    const quota = new Map(accounts.map((a, i) => [a.id, {
      updatedAt: now,
      windows: [{ kind: 'weekly' as const, label: 'Semanal', usedRatio: i === 0 ? 0.99 : 0.07,
        source: 'provider-api' as const, confidence: 'high' as const }],
    }]));
    const selected = req.accountId ?? chooseAccount(accounts, 'acc-1', null, now, undefined,
      quota, { now, requireSource: 'provider-api', maxAgeMs: 600_000 })?.id;
    expect(selected).toBe('acc-2');
    expect(req.accountId).toBeUndefined();
    expect(spawnRequestSchema.safeParse(req).success).toBe(true);
  });

  it.each([
    { resume: true }, { resumeLatestOnly: true }, { restorePersistedAuthority: true }, { preserveAccount: true },
    { missionId: 'mission-1' },
    { pane: { ...automaticPane, missionId: 'mission-1' } },
    { pane: { ...automaticPane, orchRequestId: 'orch-1' } },
    { pane: { ...automaticPane, role: 'worker' as const } },
    { pane: { ...automaticPane, accountSelection: undefined } },
    { pane: { ...automaticPane, accountSelection: 'pinned' as const } },
    { pane: { ...automaticPane, adapterId: 'codex' } },
  ])('preserva conta em retomada, autoridade de missão e escolha explícita: %j', (override) => {
    expect(buildPtySpawnRequest({ ...fresh, pane: automaticPane, ...override }).accountId).toBe('acc-1');
  });

  it('preserva a substituição explícita do chamador', () => {
    expect(buildPtySpawnRequest({ ...fresh, pane: automaticPane, accountId: 'acc-2' }).accountId).toBe('acc-2');
  });

  it('monta o payload completo do pane', () => {
    expect(
      buildPtySpawnRequest({
        pane: basePane,
        cols: 120,
        rows: 30,
        shell: undefined,
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        missionId: 'mission-1',
        accountId: 'acc-1',
      }),
    ).toEqual({
      cwd: '/workspace/proj',
      shell: undefined,
      cols: 120,
      rows: 30,
      kind: 'cli-agent',
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
      paneId: 'pane-1',
      adapterId: 'muse',
      model: 'opus',
      accountId: 'acc-1',
      effort: 'high',
      orchRequestId: 'orch-1',
      missionId: 'mission-1',
    });
  });

  it('cwd do chamador (fallback workspace) vence o do pane', () => {
    const req = buildPtySpawnRequest({
      pane: { ...basePane, cwd: undefined },
      cols: 80,
      rows: 24,
      cwd: '/workspace/active',
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
    });
    expect(req.cwd).toBe('/workspace/active');
  });

  it('strings vazias viram undefined (contrato min(1) do main)', () => {
    // Adapter sem catálogo (muse: `default: ''`) gera panes com model: '' —
    // sem a limpeza o main rejeitava o spawn inteiro.
    const req = buildPtySpawnRequest({
      pane: {
        ...basePane,
        adapterId: '',
        model: '',
        accountId: '',
        effort: '',
        orchRequestId: '',
      },
      cols: 80,
      rows: 24,
      shell: '',
      resume: true,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
      missionId: '',
      accountId: '',
    });
    expect(req.adapterId).toBeUndefined();
    expect(req.model).toBeUndefined();
    expect(req.accountId).toBeUndefined();
    expect(req.effort).toBeUndefined();
    expect(req.orchRequestId).toBeUndefined();
    expect(req.missionId).toBeUndefined();
    expect(req.shell).toBeUndefined();
    expect(req.resume).toBe(true);
  });

  it('requests isolation only for new tabs and carries their stable id on resume', () => {
    const input = { pane: { ...basePane, spaceId: 'space-a' }, cols: 80, rows: 24,
      resume: true, resumeLatestOnly: false, restorePersistedAuthority: false };
    expect(buildPtySpawnRequest(input).worktreeSpaceId).toBeUndefined();
    const req = buildPtySpawnRequest({ ...input, pane: { ...input.pane, isolateSpace: true } });
    expect(req.worktreeSpaceId).toBe('space-a');
    expect(spawnRequestSchema.safeParse(req).success).toBe(true);
  });

  it('pane shell nunca viaja como cli-agent', () => {
    const req = buildPtySpawnRequest({
      pane: { ...basePane, kind: 'shell', adapterId: undefined, model: undefined },
      cols: 80,
      rows: 24,
      shell: '/bin/zsh',
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
    });
    expect(req.kind).toBe('shell');
    expect(req.shell).toBe('/bin/zsh');
    expect(req.adapterId).toBeUndefined();
  });
});
