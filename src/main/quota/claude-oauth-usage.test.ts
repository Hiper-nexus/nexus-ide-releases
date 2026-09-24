import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pathMocks = vi.hoisted(() => ({
  resolveCliBinary: vi.fn((): { binPath: string; effectivePath: string; source: 'process-path' } | null => null),
}));
vi.mock('../path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../path-resolver')>()),
  resolveCliBinary: pathMocks.resolveCliBinary,
}));
import {
  CLAUDE_CLI_USAGE_ARGS,
  CLAUDE_CLI_USAGE_TIMEOUT_MS,
  CLAUDE_OAUTH_BETA,
  CLAUDE_OAUTH_USAGE_URL,
  extractClaudeAccessToken,
  fetchClaudeCliUsageWindows,
  fetchClaudeOauthUsageWindows,
  parseClaudeCliResetDate,
  parseClaudeCliUsage,
  parseClaudeOauthUsage,
  windowsClaudeExecutable,
} from './claude-oauth-usage';
const accessSync = fs.accessSync;

/** Fixture shaped like live Anthropic /api/oauth/usage (2026-07). */
const LIVE_SHAPE = {
  five_hour: {
    utilization: 2.0,
    resets_at: '2026-07-13T05:30:00.097620+00:00',
  },
  seven_day: {
    utilization: 50.0,
    resets_at: '2026-07-15T04:00:00.097642+00:00',
  },
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false },
  limits: [
    { kind: 'session', percent: 2 },
    { kind: 'weekly_all', percent: 50 },
  ],
};

describe('extractClaudeAccessToken', () => {
  it('reads claudeAiOauth.accessToken from credential blob', () => {
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test',
        refreshToken: 'refresh',
      },
    });
    expect(extractClaudeAccessToken(blob)).toBe('sk-ant-oat01-test');
  });

  it('returns null for empty/invalid blobs without throwing', () => {
    expect(extractClaudeAccessToken('')).toBeNull();
    expect(extractClaudeAccessToken('not-json')).toBeNull();
    expect(extractClaudeAccessToken('{}')).toBeNull();
    expect(
      extractClaudeAccessToken(JSON.stringify({ claudeAiOauth: {} })),
    ).toBeNull();
  });
});

describe('parseClaudeOauthUsage', () => {
  const NOW = Date.parse('2026-07-12T12:00:00.000Z');

  it('maps five_hour + seven_day to 5h/weekly with provider-api source', () => {
    const windows = parseClaudeOauthUsage(LIVE_SHAPE, NOW);
    expect(windows).toHaveLength(2);

    const hours = windows.find((w) => w.kind === 'hours');
    expect(hours).toMatchObject({
      label: '5 Horas',
      usedRatio: 0.02,
      source: 'provider-api',
      confidence: 'high',
    });
    expect(hours?.resetsAt).toBe(Date.parse(LIVE_SHAPE.five_hour.resets_at));
    expect(hours?.remainingLabel).toBeTruthy();

    const weekly = windows.find((w) => w.kind === 'weekly');
    expect(weekly).toMatchObject({
      label: 'Semanal',
      usedRatio: 0.5,
      source: 'provider-api',
      confidence: 'high',
    });
    expect(weekly?.resetsAt).toBe(Date.parse(LIVE_SHAPE.seven_day.resets_at));
  });

  it('treats utilization 0 as real 0% (not unknown null)', () => {
    const windows = parseClaudeOauthUsage(
      {
        five_hour: { utilization: 0, resets_at: '2026-07-13T00:00:00Z' },
        seven_day: { utilization: 0, resets_at: '2026-07-15T00:00:00Z' },
      },
      NOW,
    );
    expect(windows.every((w) => w.usedRatio === 0)).toBe(true);
    expect(windows.every((w) => w.source === 'provider-api')).toBe(true);
  });

  it('scales 0–100 percent (1 → 1%, not 100%) and clamps above 100', () => {
    const high = parseClaudeOauthUsage(
      { five_hour: { utilization: 150 }, seven_day: { utilization: 100 } },
      NOW,
    );
    expect(high.find((w) => w.kind === 'hours')?.usedRatio).toBe(1);
    expect(high.find((w) => w.kind === 'weekly')?.usedRatio).toBe(1);

    const onePct = parseClaudeOauthUsage(
      { five_hour: { utilization: 1 }, seven_day: { utilization: 0.5 } },
      NOW,
    );
    expect(onePct.find((w) => w.kind === 'hours')?.usedRatio).toBeCloseTo(0.01);
    expect(onePct.find((w) => w.kind === 'weekly')?.usedRatio).toBeCloseTo(0.005);
  });

  it('returns empty when body lacks usable buckets (honest unknown upstream)', () => {
    expect(parseClaudeOauthUsage(null)).toEqual([]);
    expect(parseClaudeOauthUsage({})).toEqual([]);
    expect(parseClaudeOauthUsage({ five_hour: null, seven_day: null })).toEqual(
      [],
    );
    expect(
      parseClaudeOauthUsage({
        five_hour: { utilization: 'nope' },
        seven_day: { utilization: NaN },
      }),
    ).toEqual([]);
  });
});

describe('fetchClaudeOauthUsageWindows', () => {
  it('calls Anthropic OAuth usage with Bearer + beta header', async () => {
    const fetchImpl = vi.fn(
      async (
        _input: string,
        _init?: {
          method?: string;
          headers?: Record<string, string>;
          signal?: AbortSignal;
        },
      ) => ({
        ok: true,
        status: 200,
        json: async () => LIVE_SHAPE,
        text: async () => JSON.stringify(LIVE_SHAPE),
      }),
    );

    const windows = await fetchClaudeOauthUsageWindows('sk-ant-oat01-x', {
      fetchImpl,
      now: Date.parse('2026-07-12T12:00:00.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      CLAUDE_OAUTH_USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-ant-oat01-x',
          'anthropic-beta': CLAUDE_OAUTH_BETA,
        }),
      }),
    );
    expect(windows?.find((w) => w.kind === 'weekly')?.usedRatio).toBe(0.5);
  });

  it('returns null on HTTP error / network throw / empty token (no fake %)', async () => {
    expect(await fetchClaudeOauthUsageWindows('')).toBeNull();
    expect(
      await fetchClaudeOauthUsageWindows('tok', {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          json: async () => ({}),
          text: async () => 'nope',
        }),
      }),
    ).toBeNull();
    expect(
      await fetchClaudeOauthUsageWindows('tok', {
        fetchImpl: async () => {
          throw new Error('network down');
        },
      }),
    ).toBeNull();
  });
});

describe('parseClaudeCliUsage', () => {
  const NOW = Date.parse('2026-09-08T12:00:00Z');

  it('parses session + week lines with resets (Codenotch fixture)', () => {
    const text = [
      'Claude usage',
      '',
      'Current session: 38% used · resets Sep 7 at 2:59pm (Asia/Jakarta)',
      'Current week (all models): 4% used · resets Sep 14 at 5:59am (Asia/Jakarta)',
      '',
      'Current session is low because you have not used Opus recently.',
    ].join('\n');
    const w = parseClaudeCliUsage(text, NOW);
    expect(w).toHaveLength(2);

    const session = w.find((x) => x.kind === 'session');
    expect(session).toMatchObject({
      label: 'Sessão',
      usedRatio: 0.38,
      source: 'provider-api',
    });
    expect(session?.resetsAt).toBe(
      // 2:59pm em Jakarta (UTC+7) = 07:59Z.
      Date.parse('2026-09-07T07:59:00Z'),
    );
    expect(session?.remainingLabel).toBeTruthy();

    const weekly = w.find((x) => x.kind === 'weekly');
    expect(weekly).toMatchObject({ label: 'Semanal', usedRatio: 0.04 });
    // 5:59am de 14/09 em Jakarta = 22:59Z de 13/09.
    expect(weekly?.resetsAt).toBe(Date.parse('2026-09-13T22:59:00Z'));
  });

  it('reads on-the-hour resets without minutes and named weeks', () => {
    const w = parseClaudeCliUsage(
      [
        'Current session: 12% used',
        'Current week (Opus): 9% used · resets Sep 14 at 6pm (UTC)',
      ].join('\n'),
      NOW,
    );
    const session = w.find((x) => x.kind === 'session');
    expect(session?.usedRatio).toBe(0.12);
    const opus = w.find((x) => x.label === 'Semanal (Opus)');
    expect(opus?.usedRatio).toBe(0.09);
    expect(opus?.resetsAt).toBe(Date.parse('2026-09-14T18:00:00Z'));
  });

  it('returns empty for garbage without inventing windows', () => {
    expect(parseClaudeCliUsage('', NOW)).toEqual([]);
    expect(parseClaudeCliUsage('not a usage table', NOW)).toEqual([]);
    expect(parseClaudeCliUsage('Current session: banana% used', NOW)).toEqual(
      [],
    );
  });
});

describe('parseClaudeCliResetDate', () => {
  const NOW = Date.parse('2026-09-08T12:00:00Z');

  it('picks the nearest year around now', () => {
    // Jan 2 lido em Setembro → é do ano que vem.
    expect(
      parseClaudeCliResetDate('Jan 2 at 3am (Asia/Jakarta)', NOW),
    ).toBe(Date.parse('2027-01-02T03:00:00+07:00'));
    // Dec 31 lido em Janeiro → é do ano passado.
    expect(
      parseClaudeCliResetDate('Dec 31 at 11pm (America/Sao_Paulo)', Date.parse('2026-01-02T12:00:00Z')),
    ).toBe(Date.parse('2025-12-31T23:00:00-03:00'));
  });

  it('keeps the printed zone and drops the minutes when they are zero', () => {
    expect(parseClaudeCliResetDate('Jul 4 at 3pm (UTC)', NOW)).toBe(
      Date.parse('2026-07-04T15:00:00Z'),
    );
  });

  it('returns undefined for unparseable stamps instead of throwing', () => {
    expect(parseClaudeCliResetDate('tomorrow maybe', NOW)).toBeUndefined();
    expect(parseClaudeCliResetDate('', NOW)).toBeUndefined();
  });
});

describe('fetchClaudeCliUsageWindows', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'accessSync').mockImplementation((file, mode) => {
      if (!/(?:^|[/\\])claude$/.test(String(file))) accessSync(file, mode);
    });
    // No Windows o CLI vem do PATH (F-640); o teste não depende do PC.
    pathMocks.resolveCliBinary.mockReturnValue({
      binPath: path.join(os.tmpdir(), 'claude.exe'), effectivePath: '', source: 'process-path',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not fabricate usage when no CLI binary is installed', async () => {
    vi.mocked(fs.accessSync).mockImplementation((file, mode) => {
      if (/(?:^|[/\\])claude$/.test(String(file))) throw new Error('missing CLI');
      accessSync(file, mode);
    });
    pathMocks.resolveCliBinary.mockReturnValue(null);
    const runImpl = vi.fn(async () => ({ code: 0, stdout: CLI_TEXT }));
    expect(await fetchClaudeCliUsageWindows({ runImpl })).toBeNull();
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('no Windows acha o CLI pelo PATH, onde nenhum candidato POSIX existe (F-640)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(fs.accessSync).mockImplementation((file, mode) => {
      if (/(?:^|[/\\])claude$/.test(String(file))) throw new Error('POSIX candidate');
      accessSync(file, mode);
    });
    const exe = path.join(os.tmpdir(), 'claude.exe');
    pathMocks.resolveCliBinary.mockReturnValue({ binPath: exe, effectivePath: '', source: 'process-path' });
    const runImpl = vi.fn(async () => ({ code: 0, stdout: CLI_TEXT }));
    try {
      const windows = await fetchClaudeCliUsageWindows({ runImpl, now: Date.parse('2026-09-08T12:00:00Z') });
      expect(runImpl).toHaveBeenCalledWith(exe, CLAUDE_CLI_USAGE_ARGS, expect.any(String), undefined);
      expect(windows?.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
  it('spawna print-only: sem sessão persistida, sem MCP, stdin fechado', () => {
    // Contrato ToS/higiene (Codenotch): só --print evita gravar
    // ~/.claude/projects e diálogos de trust; --strict-mcp-config sem
    // --mcp-config impede MCP servers no probe.
    expect(CLAUDE_CLI_USAGE_ARGS).toEqual([
      '--print',
      '--no-session-persistence',
      '--strict-mcp-config',
      '/usage',
    ]);
    expect(CLAUDE_CLI_USAGE_TIMEOUT_MS).toBe(20_000);
  });

  const CLI_TEXT = [
    'Current session: 38% used · resets Sep 7 at 2:59pm (Asia/Jakarta)',
    'Current week (all models): 4% used · resets Sep 14 at 5:59am (Asia/Jakarta)',
  ].join('\n');

  it('parses the CLI print into windows', async () => {
    const w = await fetchClaudeCliUsageWindows({
      runImpl: async () => ({ code: 0, stdout: CLI_TEXT }),
      now: Date.parse('2026-09-08T12:00:00Z'),
    });
    expect(w?.find((x) => x.kind === 'session')?.usedRatio).toBe(0.38);
    expect(w?.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.04);
  });

  it('returns null when the CLI declines (exit != 0 → precisa de login)', async () => {
    const windows = await fetchClaudeCliUsageWindows({
      runImpl: async () => ({ code: 1, stdout: '' }),
    });
    expect(windows).toBeNull();
  });

  it('returns null on empty output even with exit 0', async () => {
    expect(
      await fetchClaudeCliUsageWindows({ runImpl: async () => ({ code: 0, stdout: '' }) }),
    ).toBeNull();
  });
});

describe('windowsClaudeExecutable (F-640)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-win-bin-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function npmShim(target: string): string {
    const cmd = path.join(root, 'claude.cmd');
    fs.writeFileSync(cmd, ['@ECHO off', 'SET dp0=%~dp0', `"%dp0%\\${target}"   %*`].join('\r\n'));
    return cmd;
  }

  it('troca o shim do npm pelo claude.exe que ele lança (spawn sem shell não roda .cmd)', () => {
    const exe = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
    const cmd = npmShim('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
    expect(windowsClaudeExecutable(cmd)).toBe(fs.realpathSync(exe));
  });

  it('mantém o exe do instalador nativo como está', () => {
    const exe = path.join(root, 'claude.exe');
    fs.writeFileSync(exe, 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
    expect(windowsClaudeExecutable(exe)).toBe(exe);
  });

  it('recusa shim que não aponta para um exe (script JS, ou nada resolvido)', () => {
    const js = path.join(root, 'cli.js');
    fs.writeFileSync(js, 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
    expect(windowsClaudeExecutable(npmShim('cli.js'))).toBeNull();
    expect(windowsClaudeExecutable(npmShim('missing\\claude.exe'))).toBeNull();
    expect(windowsClaudeExecutable(null)).toBeNull();
  });
});
