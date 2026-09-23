import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEVIN_GET_USER_STATUS_URL,
  devinApiKeyFromToml,
  fetchDevinUsageWindows,
  parseDevinUserStatus,
  resolveDevinApiKey,
} from './devin-usage';

let tmpHome = '';

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-quota-test-'));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Shape real do GetUserStatus (protobuf JSON): 64-bit como STRING. */
const LIVE_STATUS = {
  userStatus: {
    planStatus: {
      dailyQuotaRemainingPercent: '95.5',
      dailyQuotaResetAtUnix: '1757563200',
      weeklyQuotaRemainingPercent: '80',
      weeklyQuotaResetAtUnix: '1757995200',
      overageBalanceMicros: '12340000',
    },
  },
};

describe('parseDevinUserStatus', () => {
  const NOW = Date.parse('2026-09-08T12:00:00Z');

  it('restante vira usado; timestamps string viram ms', () => {
    const w = parseDevinUserStatus(LIVE_STATUS, NOW);
    expect(w).toHaveLength(2);

    const daily = w.find((x) => x.label === 'Diário');
    expect(daily).toMatchObject({
      kind: 'session',
      usedRatio: expect.closeTo(0.045, 4),
      source: 'provider-api',
      confidence: 'high',
    });
    expect(daily?.resetsAt).toBe(1_757_563_200_000);

    const weekly = w.find((x) => x.label === 'Semanal');
    expect(weekly?.usedRatio).toBeCloseTo(0.2, 4);
    expect(weekly?.resetsAt).toBe(1_757_995_200_000);
  });

  it('percent omitido + reset presente = 100% usado, não «sem cota»', () => {
    const w = parseDevinUserStatus(
      {
        userStatus: {
          planStatus: {
            dailyQuotaResetAtUnix: '1757563200',
          },
        },
      },
      NOW,
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: 'session', usedRatio: 1 });
    expect(w[0]?.resetsAt).toBe(1_757_563_200_000);
  });

  it('hideDailyQuota esconde a janela diária', () => {
    const w = parseDevinUserStatus(
      {
        userStatus: {
          planStatus: {
            hideDailyQuota: true,
            weeklyQuotaRemainingPercent: 40,
            weeklyQuotaResetAtUnix: 1_757_995_200,
          },
        },
      },
      NOW,
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe('weekly');
    expect(w[0]?.usedRatio).toBeCloseTo(0.6, 4);
  });

  it('sem percent E sem reset não inventa janela', () => {
    expect(parseDevinUserStatus({ userStatus: { planStatus: {} } })).toEqual(
      [],
    );
    expect(parseDevinUserStatus(null)).toEqual([]);
    expect(parseDevinUserStatus({})).toEqual([]);
    // Reset <= 0 não é reset.
    expect(
      parseDevinUserStatus({
        userStatus: { planStatus: { dailyQuotaResetAtUnix: '0' } },
      }),
    ).toEqual([]);
  });

  it('percent fora de 0–100 não é lido', () => {
    expect(
      parseDevinUserStatus({
        userStatus: {
          planStatus: { dailyQuotaRemainingPercent: '140' },
        },
      }),
    ).toEqual([]);
  });
});

describe('devinApiKeyFromToml', () => {
  it('lê windsurf_api_key do TOML plano', () => {
    expect(
      devinApiKeyFromToml('a = 1\nwindsurf_api_key = "wc-abcd"\n'),
    ).toBe('wc-abcd');
    expect(devinApiKeyFromToml("api_key = 'wc-single'\n")).toBe('wc-single');
  });

  it('devolve null sem chave', () => {
    expect(devinApiKeyFromToml('# só comentário\n')).toBeNull();
    expect(devinApiKeyFromToml('')).toBeNull();
  });
});

describe('resolveDevinApiKey', () => {
  it('lê $XDG_DATA_HOME/devin/credentials.toml', () => {
    const dir = path.join(tmpHome, 'xdg', 'devin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'credentials.toml'),
      'windsurf_api_key = "wc-xdg"\n',
    );
    expect(
      resolveDevinApiKey({ xdgDataHome: path.join(tmpHome, 'xdg') }),
    ).toBe('wc-xdg');
  });

  it('no Windows lê %APPDATA%/devin/credentials.toml', () => {
    const user = path.join(tmpHome, 'user');
    const roaming = path.join(tmpHome, 'roaming');
    fs.mkdirSync(path.join(roaming, 'devin'), { recursive: true });
    fs.writeFileSync(
      path.join(roaming, 'devin', 'credentials.toml'),
      'windsurf_api_key = "wc-win"\n',
    );
    expect(
      resolveDevinApiKey({
        home: user,
        operatorHome: user,
        platform: 'win32',
        env: { APPDATA: roaming },
      }),
    ).toBe('wc-win');
  });

  it('sem ficheiro → null', () => {
    expect(
      resolveDevinApiKey({
        xdgDataHome: path.join(tmpHome, 'missing'),
      }),
    ).toBeNull();
  });
});

describe('fetchDevinUsageWindows', () => {
  it('POST GetUserStatus com apiKey no metadata e parseia janelas', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => LIVE_STATUS,
      text: async () => JSON.stringify(LIVE_STATUS),
    }));
    const w = await fetchDevinUsageWindows('wc-key', {
      fetchImpl: fetchImpl as never,
      now: Date.parse('2026-09-08T12:00:00Z'),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      DEVIN_GET_USER_STATUS_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
        }),
      }),
    );
    const init = (fetchImpl.mock.calls as unknown as Array<
      [string, { body?: string }]
    >)[0]?.[1];
    expect(JSON.parse(init?.body ?? '{}')).toMatchObject({
      metadata: { apiKey: 'wc-key', ideName: 'windsurf' },
    });
    expect(w?.length).toBe(2);
  });

  it('401/403/429 → null (nunca inventa)', async () => {
    for (const status of [401, 403, 429, 500]) {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status,
        json: async () => ({}),
        text: async () => '',
      }));
      expect(
        await fetchDevinUsageWindows('wc-key', { fetchImpl: fetchImpl as never }),
      ).toBeNull();
    }
    expect(await fetchDevinUsageWindows('')).toBeNull();
  });
});
