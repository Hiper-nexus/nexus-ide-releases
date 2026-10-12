import { describe, expect, it, vi } from 'vitest';

const state = { snapshot: null as unknown };
vi.mock('../quota/quota-service', () => ({
  requireQuotaService: () => ({ lastSnapshot: () => state.snapshot }),
}));

import { accountWindowsTool } from './tools-account-windows';

const NOW = Date.now();

function ctx(role: 'user' | 'worker' | 'orchestrator' = 'user', providerId?: string) {
  return {
    role,
    sessionId: 's1',
    missionId: null,
    providerId,
    allowedTools: null,
    scope: { rootRealPath: '/tmp', projectId: 'p', checkoutId: 'c', version: '1' },
  } as never;
}

describe('nexus_account_windows', () => {
  it('reports missing snapshot honestly (missing ≠ zero)', async () => {
    state.snapshot = null;
    const out = (await accountWindowsTool.handler({}, ctx(), undefined)) as {
      available: boolean;
      reason: string;
    };
    expect(out.available).toBe(false);
    expect(out.reason).toContain('missing');
  });

  it('lists windows with status and reading age', async () => {
    state.snapshot = {
      updatedAt: NOW - 60_000,
      worstUsedRatio: 0.75,
      highUsageCount: 0,
      unknownCount: 0,
      entries: [
        {
          id: 'claude:a1',
          adapterId: 'claude',
          accountId: 'a1',
          installed: true,
          onCooldown: false,
          updatedAt: NOW,
          windows: [
            { kind: 'hours', label: '5h', usedRatio: 0.75, source: 'provider-api', confidence: 'high', resetsAt: NOW + 3_600_000 },
            { kind: 'weekly', label: 'semana', usedRatio: 0.1, source: 'cli', confidence: 'med' },
          ],
        },
        {
          id: 'codex:b1',
          adapterId: 'codex',
          accountId: 'b1',
          installed: true,
          onCooldown: true,
          updatedAt: NOW,
          windows: [],
        },
      ],
    };
    const out = (await accountWindowsTool.handler({}, ctx(), undefined)) as {
      available: boolean;
      readingAgeMs: number;
      accounts: Array<{ entryId: string; status: string; usedPctWorst: number | null; windows: unknown[] }>;
      avisos: Array<{ status: string }>;
    };
    expect(out.available).toBe(true);
    expect(out.readingAgeMs).toBeGreaterThanOrEqual(59_000);
    const claude = out.accounts.find((a) => a.entryId === 'claude:a1');
    expect(claude?.status).toBe('ok');
    expect(claude?.usedPctWorst).toBe(75);
    expect(claude?.windows).toHaveLength(2);
    const codex = out.accounts.find((a) => a.entryId === 'codex:b1');
    expect(codex?.status).toBe('queimada');
    expect(out.avisos.some((a) => a.status === 'queimada')).toBe(true);
  });

  it('F-1329: unmeasured window is null, never 0% — and the account is not "ok"', async () => {
    state.snapshot = {
      updatedAt: NOW,
      worstUsedRatio: null,
      highUsageCount: 0,
      unknownCount: 2,
      entries: [
        {
          id: 'codex:b1',
          adapterId: 'codex',
          accountId: 'b1',
          installed: true,
          onCooldown: false,
          updatedAt: NOW,
          windows: [
            { kind: 'hours', label: '5h', usedRatio: null, source: 'none', confidence: 'none' },
            { kind: 'weekly', label: 'semana', usedRatio: null, source: 'none', confidence: 'none' },
          ],
        },
        {
          // known 10% on one window, null on the other: worst = 10, still "ok".
          id: 'codex:b2',
          adapterId: 'codex',
          accountId: 'b2',
          installed: true,
          onCooldown: false,
          updatedAt: NOW,
          windows: [
            { kind: 'hours', label: '5h', usedRatio: 0.1, source: 'provider-api', confidence: 'high' },
            { kind: 'weekly', label: 'semana', usedRatio: null, source: 'none', confidence: 'none' },
          ],
        },
      ],
    };
    const out = (await accountWindowsTool.handler({}, ctx(), undefined)) as {
      accounts: Array<{
        entryId: string;
        status: string;
        usedPctWorst: number | null;
        windows: Array<{ kind: string; usedPct: number | null }>;
      }>;
      avisos: Array<{ entryId: string; status: string }>;
    };
    const unmeasured = out.accounts.find((a) => a.entryId === 'codex:b1');
    expect(unmeasured?.status).toBe('sem leitura');
    expect(unmeasured?.usedPctWorst).toBeNull();
    expect(unmeasured?.windows.every((w) => w.usedPct === null)).toBe(true);
    // the missing reading must surface as an aviso, not a silent "ok"
    expect(out.avisos.some((a) => a.entryId === 'codex:b1')).toBe(true);
    // partial reading: worst is the known one, never 0 from the null sibling
    const partial = out.accounts.find((a) => a.entryId === 'codex:b2');
    expect(partial?.usedPctWorst).toBe(10);
    expect(partial?.status).toBe('ok');
  });

  it('F-1330: worker asking for another adapter is refused, not silently swapped', async () => {
    state.snapshot = {
      updatedAt: NOW,
      entries: [
        {
          id: 'claude:a1',
          adapterId: 'claude',
          accountId: 'a1',
          installed: true,
          onCooldown: false,
          updatedAt: NOW,
          windows: [{ kind: 'hours', label: '5h', usedRatio: 0.1, source: 'cli', confidence: 'high' }],
        },
      ],
    };
    const out = (await accountWindowsTool.handler(
      { adapterId: 'codex' },
      ctx('worker', 'claude'),
      undefined,
    )) as { available: boolean; reason: string; accounts: unknown[] };
    expect(out.available).toBe(false);
    expect(out.reason).toContain('codex');
    expect(out.reason).toContain('claude');
    expect(out.accounts).toEqual([]);
  });

  it('worker without provider identity never widens to the fleet', async () => {
    state.snapshot = { updatedAt: NOW, entries: [] };
    const out = (await accountWindowsTool.handler({}, ctx('worker'), undefined)) as {
      available: boolean;
      reason: string;
    };
    expect(out.available).toBe(false);
    expect(out.reason).toContain('refusing to widen');
  });
});
