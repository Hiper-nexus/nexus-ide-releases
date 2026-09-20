import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fetchKimiCodingUsageWindows,
  fetchKimiUsageWithOauth,
  KIMI_OAUTH_TOKEN_URL,
  KIMI_USAGES_URL,
  parseKimiUsagesPayload,
} from './kimi-usage';

const kfs = fs;
const kpath = path;
let tmpHome = '';

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-quota-test-'));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Live shape from Kimi CLI OAuth /usages (2026-07). */
const LIVE_USAGES = {
  user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: {
    limit: '100',
    remaining: '100',
    resetTime: '2026-07-19T20:35:00.441410Z',
  },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: {
        limit: '100',
        remaining: '100',
        resetTime: '2026-07-13T05:35:00.441410Z',
      },
    },
  ],
  totalQuota: { limit: '100', remaining: '99' },
};

describe('parseKimiUsagesPayload', () => {
  it('keeps an explicit one-day window separate from weekly quota', () => {
    const windows = parseKimiUsagesPayload({ limits: [{
      window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' },
      detail: { limit: '100', remaining: '75' },
    }] });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ kind: 'session', label: 'Diário', usedRatio: 0.25 });
  });
  it('maps weekly usage + 5h limit window (300 minutes)', () => {
    const w = parseKimiUsagesPayload(LIVE_USAGES);
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0); // 100-100
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBe(0);
    expect(w.find((x) => x.kind === 'hours')?.label).toBe('5 Horas');
    expect(w.every((x) => x.source === 'provider-api')).toBe(true);
  });

  it('computes used from remaining strings', () => {
    const w = parseKimiUsagesPayload({
      usage: { limit: '100', remaining: '40', resetTime: '2026-07-20T00:00:00Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '50', remaining: '10' },
        },
      ],
    });
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBeCloseTo(0.6);
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBeCloseTo(0.8);
  });

  it('names TIME_UNIT_WEEK windows as weekly (Codenotch live shape)', () => {
    const w = parseKimiUsagesPayload({
      limits: [
        {
          window: { duration: 1, timeUnit: 'TIME_UNIT_WEEK' },
          detail: { limit: '200', used: '50', remaining: '150' },
        },
      ],
    });
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBeCloseTo(0.25);
  });
});

describe('fetchKimiUsageWithOauth', () => {
  it('refreshes expired token then hits /usages', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'fresh-at',
            refresh_token: 'fresh-rt',
            expires_in: 900,
          }),
          text: async (): Promise<string> => '',
        };
      }
      if (String(url).includes('/usages')) {
        return {
          ok: true,
          status: 200,
          json: async () => LIVE_USAGES,
          text: async (): Promise<string> => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async (): Promise<string> => '' };
    });

    const w = await fetchKimiUsageWithOauth(
      {
        accessToken: 'stale',
        refreshToken: 'rt',
        expiresAt: 1,
      },
      {
        fetchImpl: fetchImpl as never,
        allowRefresh: true,
        persistRefresh: false,
        now: Date.now(),
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_OAUTH_TOKEN_URL,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_USAGES_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fresh-at',
        }),
      }),
    );
    expect(w?.some((x) => x.kind === 'hours')).toBe(true);
    expect(w?.some((x) => x.kind === 'weekly')).toBe(true);
  });

  it('não rotaciona o grant nativo — access expirado usa o token atual', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        throw new Error('quota probe must not refresh native kimi-code');
      }
      if (String(url).includes('/usages')) {
        return {
          ok: true,
          status: 200,
          json: async () => LIVE_USAGES,
          text: async (): Promise<string> => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async (): Promise<string> => '' };
    });

    const w = await fetchKimiUsageWithOauth(
      {
        accessToken: 'stale-but-cli-owned',
        refreshToken: 'rt-must-not-be-spent',
        expiresAt: 1,
      },
      { fetchImpl: fetchImpl as never, now: Date.now() },
    );

    expect(fetchImpl).not.toHaveBeenCalledWith(
      KIMI_OAUTH_TOKEN_URL,
      expect.anything(),
    );
    expect(w?.some((x) => x.kind === 'weekly')).toBe(true);
  });

  it('allowRefresh sem rotação: refresca em memória e não toca ~/.kimi-code', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'mem-only-at',
            expires_in: 900,
          }),
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => LIVE_USAGES,
        text: async (): Promise<string> => '',
      };
    });
    const writeSpy = vi.spyOn(kfs, 'writeFileSync');

    const w = await fetchKimiUsageWithOauth(
      {
        accessToken: 'expired-at',
        refreshToken: 'rt-still-valid',
        expiresAt: 1,
      },
      {
        fetchImpl: fetchImpl as never,
        allowRefresh: true,
        persistRefresh: false,
        home: tmpHome,
        now: Date.now(),
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_USAGES_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer mem-only-at' }),
      }),
    );
    expect(w?.some((x) => x.kind === 'weekly')).toBe(true);
    // Sem rotação na resposta → grant do CLI intocado, nenhum write.
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('rotação na resposta: devolve o grant novo ao ficheiro do CLI', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'rotated-at',
            refresh_token: 'rotated-rt',
            expires_in: 900,
          }),
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => LIVE_USAGES,
        text: async (): Promise<string> => '',
      };
    });

    const w = await fetchKimiUsageWithOauth(
      {
        accessToken: 'expired-at',
        refreshToken: 'rt-being-rotated',
        expiresAt: 1,
      },
      {
        fetchImpl: fetchImpl as never,
        allowRefresh: true,
        persistRefresh: false,
        persistOnRotation: true,
        home: tmpHome,
        now: Date.now(),
      },
    );

    expect(w?.length).toBeGreaterThan(0);
    const blob = kfs.readFileSync(
      kpath.join(tmpHome, '.kimi-code', 'credentials', 'kimi-code.json'),
      'utf8',
    );
    const parsed = JSON.parse(blob) as { access_token?: string; refresh_token?: string };
    expect(parsed.access_token).toBe('rotated-at');
    expect(parsed.refresh_token).toBe('rotated-rt');
  });

  it('rotação sem persistOnRotation: não escreve (testes ficam puros)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'rotated-at',
            refresh_token: 'rotated-rt',
          }),
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => LIVE_USAGES,
        text: async (): Promise<string> => '',
      };
    });
    const writeSpy = vi.spyOn(kfs, 'writeFileSync');

    await fetchKimiUsageWithOauth(
      { accessToken: 'expired-at', refreshToken: 'rt', expiresAt: 1 },
      {
        fetchImpl: fetchImpl as never,
        allowRefresh: true,
        persistRefresh: false,
        home: tmpHome,
        now: Date.now(),
      },
    );

    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

describe('fetchKimiCodingUsageWindows', () => {
  it('calls /usages with Bearer key', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => LIVE_USAGES,
      text: async (): Promise<string> => '',
    }));
    const w = await fetchKimiCodingUsageWindows('sk-kimi-test', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_USAGES_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-kimi-test',
        }),
      }),
    );
    expect(w?.length).toBeGreaterThan(0);
  });
});
