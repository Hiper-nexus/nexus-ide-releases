import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../persistence/account-store', () => ({
  listAccountInfos: () => [
    { id: 'a1', adapterId: 'claude', label: 'main', hasCredential: true, needsRelogin: false },
    { id: 'b1', adapterId: 'codex', label: 'pano', hasCredential: true, needsRelogin: false },
  ],
}));
const state = { snapshot: null as unknown };
vi.mock('./quota-service', () => ({
  requireQuotaService: () => ({ lastSnapshot: () => state.snapshot }),
}));

import { computeAccountPick } from './account-pick';

const NOW = Date.now();

function setSnapshot(entries: Array<Record<string, unknown>>): void {
  state.snapshot = {
    updatedAt: NOW,
    worstUsedRatio: 0.6,
    highUsageCount: 0,
    unknownCount: 0,
    entries: entries.map((e) => ({
      installed: true,
      onCooldown: false,
      windows: [],
      updatedAt: NOW,
      ...e,
    })),
  };
}

describe('computeAccountPick', () => {
  beforeEach(() => {
    state.snapshot = null;
  });

  it('sem snapshot responde disponível=false e nunca inventa conta', async () => {
    const answer = await computeAccountPick();
    expect(answer.available).toBe(false);
    expect(answer.pick).toBeUndefined();
  });

  it('escolhe a conta com mais folga e devolve ranking como plano B', async () => {
    setSnapshot([
      {
        id: 'claude:a1',
        adapterId: 'claude',
        accountId: 'a1',
        label: 'Claude · main',
        windows: [
          { kind: 'hours', label: '5h', usedRatio: 0.6, source: 'provider-api', confidence: 'high' },
        ],
      },
      {
        id: 'codex:b1',
        adapterId: 'codex',
        accountId: 'b1',
        label: 'Codex · pano',
        windows: [
          { kind: 'hours', label: '5h', usedRatio: 0.1, source: 'provider-api', confidence: 'high' },
        ],
      },
    ]);
    const answer = await computeAccountPick();
    expect(answer.available).toBe(true);
    expect(answer.adapterId).toBe('codex');
    expect(answer.pick?.entryId).toBe('codex:b1');
    expect(answer.pick?.headroomPct).toBe(90);
    expect(answer.pick?.accountId).toBe('b1');
    expect(answer.alternatives.map((r) => r.entryId)).toEqual(['claude:a1']);
    expect(answer.decidedBy).toBe('scorer');
    expect(JSON.stringify(answer)).not.toContain('main');
  });

  it('respeita o filtro de adapter e responde honesto quando não há elegível', async () => {
    setSnapshot([
      {
        id: 'claude:a1',
        adapterId: 'claude',
        accountId: 'a1',
        label: 'Claude · main',
        windows: [
          { kind: 'hours', label: '5h', usedRatio: 0.6, source: 'provider-api', confidence: 'high' },
        ],
      },
    ]);
    const answer = await computeAccountPick({ adapterId: 'claude' });
    expect(answer.pick?.entryId).toBe('claude:a1');
    const none = await computeAccountPick({ adapterId: 'kimi' });
    expect(none.available).toBe(true);
    expect(none.pick).toBeUndefined();
    expect(none.reason).toContain('kimi');
  });

  it('conta em cooldown fica fora da disputa', async () => {
    setSnapshot([
      {
        id: 'claude:a1',
        adapterId: 'claude',
        accountId: 'a1',
        label: 'Claude · main',
        onCooldown: true,
        windows: [
          { kind: 'hours', label: '5h', usedRatio: 0.0, source: 'provider-api', confidence: 'high' },
        ],
      },
    ]);
    const answer = await computeAccountPick();
    expect(answer.pick).toBeUndefined();
    expect(answer.reason).toContain('no eligible account');
  });

  it('F-1292: conta excluída aparece com o motivo (plano B visível)', async () => {
    setSnapshot([
      {
        id: 'codex:b1',
        adapterId: 'codex',
        accountId: 'b1',
        label: 'Codex · pano',
        windows: [
          { kind: 'hours', label: '5h', usedRatio: 0.1, source: 'provider-api', confidence: 'high' },
        ],
      },
      {
        id: 'codex:b2',
        adapterId: 'codex',
        accountId: 'b2',
        label: 'Codex · reserva',
        windows: [
          { kind: 'hours', label: '5h', usedRatio: null, source: 'provider-api', confidence: 'low' },
          { kind: 'daily', label: '24h', usedRatio: null, source: 'provider-api', confidence: 'low' },
        ],
      },
    ]);
    const answer = await computeAccountPick({ adapterId: 'codex' });
    expect(answer.pick?.entryId).toBe('codex:b1');
    expect(answer.excluded).toMatchObject([
      { entryId: 'codex:b2', adapterId: 'codex', excludedReason: 'unknown-usage' },
    ]);
    // Só ids opacos e motivo — rótulo/e-mail nunca cruzam.
    expect(JSON.stringify(answer)).not.toContain('reserva');
  });

  it('F-1292: excluída aparece mesmo sem elegível (não some sem motivo)', async () => {
    setSnapshot([
      {
        id: 'claude:a1',
        adapterId: 'claude',
        accountId: 'a1',
        label: 'Claude · main',
        onCooldown: true,
        windows: [
          { kind: 'hours', label: '5h', usedRatio: 0.0, source: 'provider-api', confidence: 'high' },
        ],
      },
    ]);
    const answer = await computeAccountPick({ adapterId: 'claude' });
    expect(answer.pick).toBeUndefined();
    expect(answer.excluded).toMatchObject([
      { entryId: 'claude:a1', excludedReason: 'cooldown' },
    ]);
  });

  it('nunca deixa Jev substituir o scorer — decidedBy é scorer quando há elegível', async () => {
    setSnapshot([
      {
        id: 'claude:a1',
        adapterId: 'claude',
        accountId: 'a1',
        label: 'Claude · main',
        windows: [
          { kind: 'hours', label: '5h', usedRatio: 0.2, source: 'provider-api', confidence: 'high' },
        ],
      },
      {
        id: 'codex:b1',
        adapterId: 'codex',
        accountId: 'b1',
        label: 'Codex · pano',
        windows: [
          { kind: 'hours', label: '5h', usedRatio: 0.9, source: 'provider-api', confidence: 'high' },
        ],
      },
    ]);
    const answer = await computeAccountPick();
    expect(answer.decidedBy).toBe('scorer');
    expect(answer.pick?.entryId).toBe('claude:a1');
    expect(JSON.stringify(answer)).not.toMatch(/"jev"/);
  });
});
