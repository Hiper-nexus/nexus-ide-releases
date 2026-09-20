import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CURSOR_USAGE_SUMMARY_URL,
  cursorAgentSession,
  cursorSessionFromEditorStore,
  cursorWorkosCookie,
  fetchCursorUsageWindows,
  parseCursorUsageSummary,
} from './cursor-usage';

// O better-sqlite3 do checkout é compilado para o ABI do Electron; nos testes
// (Node do vitest) não carrega — mesma convenção de usage-store.test.ts.
let sqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as new (file: string) => {
    close(): void;
  };
  new Database(':memory:').close();
} catch {
  sqliteAvailable = false;
}

let tmpHome = '';

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-quota-test-'));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Live shape, conta free com uso real (Codenotch CursorUsage.swift). */
const FREE_SHAPE = {
  billingCycleStart: '2026-08-24T03:32:15.933Z',
  billingCycleEnd: '2026-09-24T03:32:15.933Z',
  membershipType: 'free',
  isUnlimited: false,
  individualUsage: {
    plan: {
      enabled: true,
      used: 0,
      limit: 0,
      remaining: 0,
      breakdown: { included: 0, bonus: 19, total: 19 },
      autoPercentUsed: 42.5,
      apiPercentUsed: 19,
      totalPercentUsed: 9.5,
    },
    onDemand: { enabled: false, used: 0, limit: null },
  },
};

describe('parseCursorUsageSummary', () => {
  const NOW = Date.parse('2026-09-20T12:00:00Z');
  const RESETS = Date.parse('2026-09-24T03:32:15.933Z');

  it('anel = autoPercentUsed (0 é leitura real), API à parte, total ignorado', () => {
    const w = parseCursorUsageSummary(FREE_SHAPE, NOW);
    const auto = w.find((x) => x.label === 'Mensal');
    expect(auto).toMatchObject({
      kind: 'monthly',
      usedRatio: 0.425,
      source: 'provider-api',
      confidence: 'high',
    });
    expect(auto?.resetsAt).toBe(RESETS);

    const api = w.find((x) => x.label === 'Uso API');
    expect(api?.usedRatio).toBeCloseTo(0.19, 4);

    // totalPercentUsed é mistura — nunca vira janela.
    expect(w.find((x) => x.label === 'Total')).toBeUndefined();
    // NUNCA plan.used/limit: 0/0 no free com uso real no bonus.
    expect(FREE_SHAPE.individualUsage.plan.used).toBe(0);
    expect(auto?.usedRatio).toBe(0.425);
  });

  it('enterprise: sem percentagens, overall.used/limit é a leitura', () => {
    const w = parseCursorUsageSummary(
      {
        billingCycleEnd: '2026-09-24T03:32:15.933Z',
        membershipType: 'enterprise',
        limitType: 'team',
        individualUsage: {
          overall: { enabled: true, used: 6907, limit: 45000, remaining: 38093 },
        },
        teamUsage: {
          onDemand: { enabled: true, used: 0, limit: 1_000_000 },
        },
      },
      NOW,
    );
    const overall = w.find((x) => x.label === 'Mensal');
    expect(overall?.usedRatio).toBeCloseTo(6907 / 45000, 4);
    // Team on demand zerado não entra.
    expect(w.find((x) => x.label === 'On demand')).toBeUndefined();
  });

  it('sem plan e sem overall → vazio (nada inventado)', () => {
    expect(parseCursorUsageSummary({ individualUsage: {} })).toEqual([]);
    expect(parseCursorUsageSummary(null)).toEqual([]);
    expect(
      parseCursorUsageSummary(
        {
          membershipType: 'free',
          individualUsage: {
            plan: { enabled: true, used: 3, limit: 5 },
          },
        },
        NOW,
      ),
    ).toEqual([]); // sem auto/api percent → nada a pintar
  });

  it('autoPercentUsed 0 num plano fresco é 0% real, não ausência', () => {
    const w = parseCursorUsageSummary(
      {
        individualUsage: {
          plan: { enabled: true, autoPercentUsed: 0, apiPercentUsed: 0 },
        },
      },
      NOW,
    );
    const auto = w.find((x) => x.label === 'Mensal');
    expect(auto?.usedRatio).toBe(0);
  });
});

describe('cursorWorkosCookie', () => {
  it('monta o par accountID::token', () => {
    expect(
      cursorWorkosCookie({ accountId: 'usr_123', accessToken: 'eyJ.x.y' }),
    ).toBe('WorkosCursorSessionToken=usr_123::eyJ.x.y');
  });
});

describe.skipIf(!sqliteAvailable)('cursorSessionFromEditorStore', () => {
  it('lê accessToken + authId do state.vscdb', async () => {
    const { default: Database } = await import('better-sqlite3');
    const dbPath = path.join(tmpHome, 'state.vscdb');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'cursorAuth/accessToken',
      'editor-jwt',
    );
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'cursorAuth/stripeMembershipAuthId',
      'usr_editor',
    );
    db.close();

    const session = await cursorSessionFromEditorStore(dbPath);
    expect(session).toEqual({ accountId: 'usr_editor', accessToken: 'editor-jwt' });
  });

  it('ficheiro inexistente → null', async () => {
    expect(await cursorSessionFromEditorStore('/não/existe.vscdb')).toBeNull();
  });
});

describe('cursorAgentSession', () => {
  it('authId do cli-config prevalece; cai no JWT sub', async () => {
    const cfg = path.join(tmpHome, 'cli-config.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({ authInfo: { email: 'a@b.c', authId: 'usr_cfg' } }),
    );
    const jwt = `x.${Buffer.from(
      JSON.stringify({ sub: 'usr_sub', exp: Math.floor(Date.now() / 1000) + 3600 }),
    )
      .toString('base64url')
      .toString()}.sig`;
    const session = await cursorAgentSession(jwt, cfg);
    expect(session?.accountId).toBe('usr_cfg');
    expect(session?.accessToken).toBe(jwt);

    fs.writeFileSync(cfg, JSON.stringify({ authInfo: { email: 'a@b.c' } }));
    expect((await cursorAgentSession(jwt, cfg))?.accountId).toBe('usr_sub');
  });

  it('JWT expirado → null', async () => {
    const cfg = path.join(tmpHome, 'cli-config2.json');
    fs.writeFileSync(cfg, JSON.stringify({ authInfo: { authId: 'u1' } }));
    const expired = `x.${Buffer.from(
      JSON.stringify({ sub: 's', exp: 1 }),
    ).toString('base64url')}.sig`;
    expect(await cursorAgentSession(expired, cfg)).toBeNull();
  });
});

describe('fetchCursorUsageWindows', () => {
  it('GET com cookie Workos + parse', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => FREE_SHAPE,
      text: async () => JSON.stringify(FREE_SHAPE),
    }));
    const w = await fetchCursorUsageWindows(
      { accountId: 'usr_1', accessToken: 'tok' },
      { fetchImpl: fetchImpl as never, now: Date.parse('2026-09-20T12:00:00Z') },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      CURSOR_USAGE_SUMMARY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'WorkosCursorSessionToken=usr_1::tok',
        }),
      }),
    );
    expect(w?.length).toBeGreaterThan(0);
  });

  it('401/403 → null; sessão ausente → null', async () => {
    const fail = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '',
    }));
    expect(
      await fetchCursorUsageWindows(
        { accountId: 'a', accessToken: 't' },
        { fetchImpl: fail as never },
      ),
    ).toBeNull();
    expect(await fetchCursorUsageWindows(null)).toBeNull();
    expect(
      await fetchCursorUsageWindows({ accountId: '', accessToken: 't' }),
    ).toBeNull();
  });
});
