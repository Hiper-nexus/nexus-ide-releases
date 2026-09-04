import { describe, expect, it } from 'vitest';
import { buildPtySpawnRequest } from './spawn-request';

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
