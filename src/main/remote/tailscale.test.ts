// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: @effect/vitest →
// vitest; fake de execFile (argv, timeout, SIGKILL, maxBuffer, LANG=C) no
// lugar do ChildProcessSpawner/TestClock; alvo https+insecure, serve status,
// resolução de binário e probe.

import { describe, expect, it } from 'vitest';
import {
  buildTailscaleHttpsBaseUrl,
  classifyTailscaleServePort,
  disableTailscaleServe,
  ensureTailscaleServe,
  isTailscaleIpv4Address,
  parseTailscaleServeConfig,
  parseTailscaleStatus,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
  resolveTailscaleBinary,
  tailscaleBinaryCandidates,
  TAILSCALE_MAX_BUFFER_BYTES,
  TAILSCALE_STATUS_TIMEOUT_MS,
  type TailscaleCli,
  type TailscaleExecError,
  type TailscaleExecOptions,
} from './tailscale';

const SECRET = 'tskey-auth-secret-token-value';

/**
 * Asserts nothing reachable from `value` contains `secret`. Recurses through
 * nested objects, arrays, and `cause` chains rather than checking only
 * top-level strings: a leak one level down is just as visible in a log.
 */
function assertCarriesNoSecret(value: unknown, secret: string): void {
  const seen = new WeakSet<object>();
  const walk = (current: unknown, path: string): void => {
    if (typeof current === 'string') {
      expect(current, `${path} leaked stderr`).not.toContain(secret);
      return;
    }
    if (typeof current !== 'object' || current === null || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    walk((current as { message?: unknown }).message, `${path}.message`);
    walk((current as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(current)) walk(nested, `${path}.${key}`);
  };
  walk(value, 'value');
  expect(JSON.stringify(value)).not.toContain(secret);
}

const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;
const tailscaleStatusWithSingleIpJson = `{"BackendState":"Running","Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.90.1.2"]}}`;

interface ExecCall {
  file: string;
  args: readonly string[];
  options: TailscaleExecOptions;
}

type FakeResult =
  | { stdout?: string; stderr?: string; code?: number }
  | { error: TailscaleExecError & { message?: string }; stdout?: string; stderr?: string };

/** Fake de execFile: grava argv/opções e responde como o callback do Node. */
function fakeCli(handler: (args: readonly string[]) => FakeResult): {
  cli: TailscaleCli;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const cli: TailscaleCli = {
    binary: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    execFile: (file, args, options, callback) => {
      calls.push({ file, args: [...args], options });
      const result = handler(args);
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      queueMicrotask(() => {
        if ('error' in result) {
          callback(result.error, stdout, stderr);
          return;
        }
        const code = result.code ?? 0;
        if (code === 0) {
          callback(null, stdout, stderr);
          return;
        }
        // Como o Node: a mensagem do erro cita o comando E o stderr inteiro.
        const error = Object.assign(
          new Error(`Command failed: ${file} ${args.join(' ')}\n${stderr}`),
          { code, killed: false, signal: null },
        );
        callback(error, stdout, stderr);
      });
      return undefined;
    },
  };
  return { cli, calls };
}

describe('tailscale', () => {
  it('detects Tailnet IPv4 addresses', () => {
    expect(isTailscaleIpv4Address('100.64.0.1')).toBe(true);
    expect(isTailscaleIpv4Address('100.127.255.254')).toBe(true);
    expect(isTailscaleIpv4Address('100.128.0.1')).toBe(false);
    expect(isTailscaleIpv4Address('100.63.255.255')).toBe(false);
    expect(isTailscaleIpv4Address('192.168.1.44')).toBe(false);
    expect(isTailscaleIpv4Address('100.64.0')).toBe(false);
  });

  it('parses status facts', () => {
    expect(parseTailscaleStatus(tailscaleStatusJson)).toEqual({
      ok: true,
      status: {
        magicDnsName: 'desktop.tail.ts.net',
        tailnetIpv4Addresses: ['100.100.100.100'],
        backendState: null,
      },
    });
    expect(parseTailscaleStatus('{}')).toEqual({
      ok: true,
      status: { magicDnsName: null, tailnetIpv4Addresses: [], backendState: null },
    });
  });

  it('preserves status decoding failures without exposing cause text', () => {
    const failure = parseTailscaleStatus('{not-json');
    expect(failure).toEqual({ ok: false, reason: 'parse' });
    expect(parseTailscaleStatus('{"Self":"x"}')).toEqual({ ok: false, reason: 'parse' });
  });

  it('builds clean HTTPS base URLs', () => {
    expect(buildTailscaleHttpsBaseUrl({ magicDnsName: 'desktop.tail.ts.net' })).toBe(
      'https://desktop.tail.ts.net/',
    );
    expect(
      buildTailscaleHttpsBaseUrl({ magicDnsName: 'desktop.tail.ts.net', servePort: 8443 }),
    ).toBe('https://desktop.tail.ts.net:8443/');
  });

  it('reads tailscale status through execFile with bounded, shell-free options', async () => {
    const { cli, calls } = fakeCli((args) => {
      expect(args).toEqual(['status', '--json']);
      return { stdout: tailscaleStatusWithSingleIpJson };
    });

    const status = await readTailscaleStatus(cli);

    expect(status).toEqual({
      ok: true,
      status: {
        magicDnsName: 'desktop.tail.ts.net',
        tailnetIpv4Addresses: ['100.90.1.2'],
        backendState: 'Running',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(calls[0]!.options).toMatchObject({
      timeout: TAILSCALE_STATUS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: TAILSCALE_MAX_BUFFER_BYTES,
      shell: false,
      encoding: 'utf8',
    });
    expect(TAILSCALE_STATUS_TIMEOUT_MS).toBe(1_500);
    expect(TAILSCALE_MAX_BUFFER_BYTES).toBe(1024 * 1024);
    expect(calls[0]!.options.env.LANG).toBe('C');
  });

  it('turns async spawn failures into typed spawn failures without the cause text', async () => {
    const { cli } = fakeCli(() => ({
      error: Object.assign(new Error(`spawn private executable lookup detail ${SECRET}`), {
        code: 'ENOENT',
      }),
    }));

    const failure = await readTailscaleStatus(cli);

    expect(failure).toEqual({ ok: false, reason: 'spawn', subcommand: 'status', argumentCount: 2 });
    assertCarriesNoSecret(failure, SECRET);
  });

  it('turns synchronous spawn throws (ENOTDIR) into typed spawn failures', async () => {
    const cli: TailscaleCli = {
      binary: '/usr/bin/tailscale',
      execFile: () => {
        throw Object.assign(new Error('spawn tailscale ENOTDIR'), { code: 'ENOTDIR' });
      },
    };

    await expect(readTailscaleStatus(cli)).resolves.toEqual({
      ok: false,
      reason: 'spawn',
      subcommand: 'status',
      argumentCount: 2,
    });
    await expect(ensureTailscaleServe(cli, { localPort: 13773, servePort: 8443 })).resolves.toEqual(
      { ok: false, reason: 'spawn', subcommand: 'serve', argumentCount: 4 },
    );
  });

  it('keeps nonzero exit diagnostics structured', async () => {
    const { cli } = fakeCli(() => ({ code: 7, stderr: `not logged in ${SECRET}` }));

    const failure = await readTailscaleStatus(cli);

    expect(failure).toEqual({
      ok: false,
      reason: 'exit',
      subcommand: 'status',
      argumentCount: 2,
      exitCode: 7,
      stdoutLength: 0,
      stderrLength: 43,
      stderrDiagnostic: 'not-logged-in',
    });
    expect(failure).not.toHaveProperty('stderr');
    expect(failure).not.toHaveProperty('command');
    assertCarriesNoSecret(failure, SECRET);
  });

  it('classifies unrecognized stderr without quoting it', async () => {
    const { cli } = fakeCli(() => ({
      code: 3,
      stderr: `something novel went wrong for node fluffy-badger ${SECRET}`,
    }));

    const failure = await readTailscaleStatus(cli);

    // Unmatched stderr degrades to "unknown" rather than passing text through.
    expect(failure).toMatchObject({ reason: 'exit', stderrDiagnostic: 'unknown' });
    assertCarriesNoSecret(failure, SECRET);
    assertCarriesNoSecret(failure, 'fluffy-badger');
  });

  it('reports execFile timeouts (SIGKILL) as typed timeouts', async () => {
    const { cli } = fakeCli(() => ({
      error: { code: null, killed: true, signal: 'SIGKILL' },
    }));

    await expect(readTailscaleStatus(cli)).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      subcommand: 'status',
      argumentCount: 2,
      timeoutMs: 1_500,
    });
  });

  it('reports maxBuffer overflow as an output failure', async () => {
    const { cli } = fakeCli(() => ({
      error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGKILL' },
    }));

    await expect(readTailscaleStatus(cli)).resolves.toMatchObject({ ok: false, reason: 'output' });
  });

  it('configures tailscale serve toward the TLS bridge with the exact argv', async () => {
    const { cli, calls } = fakeCli(() => ({}));

    await expect(ensureTailscaleServe(cli, { localPort: 13773, servePort: 8443 })).resolves.toEqual({
      ok: true,
    });
    await ensureTailscaleServe(cli, { localPort: 13773 });

    expect(calls.map((call) => call.args)).toEqual([
      ['serve', '--bg', '--https=8443', 'https+insecure://127.0.0.1:13773'],
      ['serve', '--bg', '--https=443', 'https+insecure://127.0.0.1:13773'],
    ]);
    expect(calls[0]!.options).toMatchObject({ timeout: 10_000, killSignal: 'SIGKILL' });
  });

  it('retains tailscale serve exit diagnostics', async () => {
    const { cli } = fakeCli(() => ({ code: 1, stderr: `serve permission denied ${SECRET}` }));

    const failure = await ensureTailscaleServe(cli, { localPort: 13773, servePort: 8443 });

    expect(failure).toEqual({
      ok: false,
      reason: 'exit',
      subcommand: 'serve',
      argumentCount: 4,
      exitCode: 1,
      stdoutLength: 0,
      stderrLength: 53,
      stderrDiagnostic: 'permission-denied',
    });
    assertCarriesNoSecret(failure, SECRET);
  });

  it('disables tailscale serve and treats a missing handler as success', async () => {
    const { cli, calls } = fakeCli(() => ({}));
    await expect(disableTailscaleServe(cli, { servePort: 8443 })).resolves.toEqual({ ok: true });
    expect(calls.map((call) => call.args)).toEqual([['serve', '--https=8443', 'off']]);

    const missing = fakeCli(() => ({
      code: 1,
      stderr: 'error: failed to remove web serve: handler does not exist',
    }));
    await expect(disableTailscaleServe(missing.cli)).resolves.toEqual({ ok: true });
    expect(missing.calls[0]!.args).toEqual(['serve', '--https=443', 'off']);

    const denied = fakeCli(() => ({ code: 1, stderr: 'Access denied: serve config denied' }));
    await expect(disableTailscaleServe(denied.cli)).resolves.toMatchObject({
      ok: false,
      stderrDiagnostic: 'permission-denied',
    });
  });

  it('resolves the binary only from fixed absolute candidates', () => {
    const mac = tailscaleBinaryCandidates('darwin');
    expect(mac[0]).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(mac.every((candidate) => candidate.startsWith('/'))).toBe(true);
    expect(tailscaleBinaryCandidates('linux').every((c) => c.startsWith('/'))).toBe(true);
    expect(tailscaleBinaryCandidates('win32', { ProgramFiles: 'relative\\dir' })).toEqual([
      'C:\\Program Files\\Tailscale\\tailscale.exe',
    ]);
    expect(
      resolveTailscaleBinary(['/nope/tailscale', '/usr/local/bin/tailscale'], (candidate) =>
        candidate === '/usr/local/bin/tailscale',
      ),
    ).toBe('/usr/local/bin/tailscale');
    expect(resolveTailscaleBinary(['/nope/tailscale'], () => false)).toBeNull();
  });

  it('classifies who owns the serve port without touching foreign handlers', () => {
    const ours = 'https+insecure://127.0.0.1:52000';
    const config = (proxy: string, mount = '/') => {
      const parsed = parseTailscaleServeConfig(
        JSON.stringify({
          TCP: { '443': { HTTPS: true } },
          Web: { 'box.tail1234.ts.net:443': { Handlers: { [mount]: { Proxy: proxy } } } },
        }),
      );
      if (!parsed.ok) throw new Error('fixture must parse');
      return parsed.config;
    };
    const empty = parseTailscaleServeConfig('{}');
    if (!empty.ok) throw new Error('empty config must parse');

    expect(classifyTailscaleServePort(empty.config, 443, ours)).toBe('free');
    expect(classifyTailscaleServePort(config(ours), 443, ours)).toBe('ours');
    expect(classifyTailscaleServePort(config(ours), 8443, ours)).toBe('free');
    expect(classifyTailscaleServePort(config('http://127.0.0.1:3000'), 443, ours)).toBe('foreign');
    expect(classifyTailscaleServePort(config(ours, '/api'), 443, ours)).toBe('foreign');
    expect(classifyTailscaleServePort(config(ours), 443, null)).toBe('foreign');
    const tcpForward = parseTailscaleServeConfig('{"TCP":{"443":{"TCPForward":"127.0.0.1:22"}}}');
    if (!tcpForward.ok) throw new Error('tcp fixture must parse');
    expect(classifyTailscaleServePort(tcpForward.config, 443, ours)).toBe('foreign');
    expect(parseTailscaleServeConfig('[]')).toEqual({ ok: false, reason: 'parse' });
  });

  it('probes the public bridge route with redirect:error and a timeout', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await expect(
      probeTailscaleHttpsEndpoint({ baseUrl: 'https://box.tail1234.ts.net/', fetchImpl: okFetch }),
    ).resolves.toBe(true);
    expect(seen[0]!.url).toBe('https://box.tail1234.ts.net/manifest.webmanifest');
    expect(seen[0]!.init?.redirect).toBe('error');
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);

    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      probeTailscaleHttpsEndpoint({ baseUrl: 'https://box.tail1234.ts.net/', fetchImpl: failing }),
    ).resolves.toBe(false);
    const notFound = (async () => new Response('no', { status: 502 })) as typeof fetch;
    await expect(
      probeTailscaleHttpsEndpoint({ baseUrl: 'https://box.tail1234.ts.net/', fetchImpl: notFound }),
    ).resolves.toBe(false);
  });
});
