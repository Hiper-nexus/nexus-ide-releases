// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: os casos do
// tailscaleEndpointProvider.test (endpoint MagicDNS available só com Serve +
// probe) rodam contra a Remote Bridge real com um tailscaled falso; somam-se
// stop/off, órfão no boot, handler alheio, tskey fora de log/IPC e Origin.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { TailscaleCli, TailscaleExecOptions } from './tailscale';

const SECRET = 'tskey-auth-secret-token-value';
const MAGIC_DNS = 'box.tail1234.ts.net';

type FakeResult = { code?: number; stdout?: string; stderr?: string };

/** tailscaled falso: guarda o handler da porta 443 entre comandos. */
const fake = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ file: string; args: string[]; options: TailscaleExecOptions }>,
    fetches: [] as Array<{ url: string; init: RequestInit | undefined }>,
    statusJson: '',
    serveTarget: null as string | null,
    foreignProxy: null as string | null,
    serveFailure: null as FakeResult | null,
  };
  const serveStatus = (): string => {
    const proxy = state.foreignProxy ?? state.serveTarget;
    if (!proxy) return '{}';
    return JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: { 'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } },
    });
  };
  const respond = (args: string[]): FakeResult => {
    const command = args.join(' ');
    if (command === 'status --json') return { stdout: state.statusJson };
    if (command === 'serve status --json') return { stdout: serveStatus() };
    if (args[0] === 'serve' && args[1] === '--bg') {
      if (state.serveFailure) return state.serveFailure;
      state.serveTarget = args[3] ?? null;
      return {};
    }
    if (command === 'serve --https=443 off') {
      if (!state.serveTarget && !state.foreignProxy) {
        return { code: 1, stderr: 'error: failed to remove web serve: handler does not exist' };
      }
      state.serveTarget = null;
      state.foreignProxy = null;
      return {};
    }
    return { code: 64, stderr: `unexpected ${command}` };
  };
  const cli: TailscaleCli = {
    binary: '/fake/Tailscale.app/Contents/MacOS/Tailscale',
    execFile: (file, args, options, callback) => {
      state.calls.push({ file, args: [...args], options });
      const result = respond([...args]);
      queueMicrotask(() => {
        const code = result.code ?? 0;
        if (code === 0) {
          callback(null, result.stdout ?? '', result.stderr ?? '');
          return;
        }
        // Como o Node: a mensagem do erro carrega o stderr inteiro.
        callback(
          Object.assign(new Error(`Command failed: ${file}\n${result.stderr ?? ''}`), {
            code,
            killed: false,
            signal: null,
          }),
          result.stdout ?? '',
          result.stderr ?? '',
        );
      });
      return undefined;
    },
  };
  return { state, cli };
});

vi.mock('./tailscale', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tailscale')>()),
  resolveTailscaleCli: () => fake.cli,
}));
// The bridge pulls orchestration/pty modules that transitively need electron;
// stub them so this stays a pure network test.
vi.mock('../orch/project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({ missions: { list: () => [] } }),
}));
vi.mock('../orch/pane-registry', () => ({
  getPaneAuthzInfo: () => null,
  listVisiblePaneSnapshots: () => [],
  readSessionOutput: () => '',
  requestPaneClose: () => true,
}));
vi.mock('../orch/pane-authz', () => ({
  authorizePaneAccess: () => ({ allow: true }),
}));
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: () => true,
  orchResizeSession: () => true,
  tapSessionData: () => () => undefined,
}));

type Bridge = typeof import('./remote-bridge');
let bridge: Bridge;
let resetDetection: () => void;
let home: string;
let previousHome: string | undefined;
const projectScope = {
  version: 1 as const,
  installationId: 'install-test',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
};

function markerPath(): string {
  return path.join(home, '.nexus', 'remote-bridge', 'tailscale-serve.json');
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function openSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function ping(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout')), 10_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.send(JSON.stringify({ id: 'p', type: 'ping' }));
  });
}

function serveCalls(): string[][] {
  return fake.state.calls.map((call) => call.args).filter((args) => args[0] === 'serve');
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ts-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  bridge = await import('./remote-bridge');
  resetDetection = (await import('./remote-bridge-tailscale')).resetRemoteBridgeTailscaleDetection;
});

beforeEach(() => {
  fake.state.calls.length = 0;
  fake.state.fetches.length = 0;
  fake.state.statusJson = JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: `${MAGIC_DNS}.`, TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
  });
  fake.state.serveTarget = null;
  fake.state.foreignProxy = null;
  fake.state.serveFailure = null;
  resetDetection();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      fake.state.fetches.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(async () => {
  bridge.stopRemoteBridge();
  await bridge.settleRemoteBridgeTailscale(5_000);
  vi.unstubAllGlobals();
  fs.rmSync(markerPath(), { force: true });
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('remote bridge no tailnet (Tailscale Serve)', () => {
  it('publica via Serve com argv exato e anuncia https://<magicdns>/ primeiro', async () => {
    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );

    expect(info.tailscale).toEqual({
      magicDnsName: MAGIC_DNS,
      httpsUrl: `https://${MAGIC_DNS}/`,
      status: 'available',
    });
    expect(info.urls[0]).toBe(`wss://${MAGIC_DNS}`);
    expect(info.endpoints?.[0]).toEqual({ url: `wss://${MAGIC_DNS}`, label: 'Tailscale HTTPS' });
    expect(info.urls).toContain(`wss://127.0.0.1:${info.port}`);

    const serve = fake.state.calls.find((call) => call.args[1] === '--bg');
    expect(serve?.file).toBe('/fake/Tailscale.app/Contents/MacOS/Tailscale');
    expect(serve?.args).toEqual([
      'serve',
      '--bg',
      '--https=443',
      `https+insecure://127.0.0.1:${info.port}`,
    ]);
    expect(serve?.options).toMatchObject({
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      shell: false,
    });
    expect(serve?.options.env.LANG).toBe('C');
    // Nunca sobrescreve sem antes ler quem ocupa a porta.
    expect(serveCalls()[0]).toEqual(['serve', 'status', '--json']);
    expect(fake.state.fetches).toHaveLength(1);
    expect(fake.state.fetches[0]!.url).toBe(`https://${MAGIC_DNS}/manifest.webmanifest`);
    expect(fake.state.fetches[0]!.init?.redirect).toBe('error');
    expect(JSON.parse(fs.readFileSync(markerPath(), 'utf8'))).toMatchObject({
      servePort: 443,
      target: `https+insecure://127.0.0.1:${info.port}`,
      pid: process.pid,
    });
  });

  it('stop desliga o Serve (off) e some com o marcador', async () => {
    await bridge.startRemoteBridge({ host: '127.0.0.1', tailscale: true }, projectScope);
    fake.state.calls.length = 0;

    const stopped = bridge.stopRemoteBridge(projectScope);
    await bridge.settleRemoteBridgeTailscale(5_000);

    expect(stopped.tailscale).toBeUndefined();
    expect(serveCalls()).toEqual([
      ['serve', 'status', '--json'],
      ['serve', '--https=443', 'off'],
    ]);
    expect(fake.state.serveTarget).toBeNull();
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  it('marca o probe falho como requires-configuration sem esconder a URL do Serve', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));

    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );

    expect(info.tailscale).toEqual({
      magicDnsName: MAGIC_DNS,
      httpsUrl: `https://${MAGIC_DNS}/`,
      status: 'requires-configuration',
      diagnostic: 'probe-failed',
    });
  });

  it('stderr com tskey nunca chega a log, IPC nem status do aparelho', async () => {
    fake.state.serveFailure = {
      code: 1,
      stderr: `serve permission denied ${SECRET} for node fluffy-badger`,
    };
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    );

    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );
    const status = await bridge.getRemoteBridgeStatus(projectScope);

    expect(info.tailscale).toEqual({
      magicDnsName: MAGIC_DNS,
      status: 'requires-configuration',
      diagnostic: 'permission-denied',
    });
    expect(info.urls[0]).toBe(`wss://127.0.0.1:${info.port}`);
    for (const payload of [info, status, bridge.redactRemoteBridgeSecrets(info)]) {
      expect(JSON.stringify(payload)).not.toContain(SECRET);
      expect(JSON.stringify(payload)).not.toContain('fluffy-badger');
    }
    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) {
        expect(args.map((arg) => String(arg)).join(' ')).not.toContain(SECRET);
      }
      spy.mockRestore();
    }
    // Saída com erro = nada aplicado: sem marcador, e o stop não roda `off`.
    expect(fs.existsSync(markerPath())).toBe(false);
    fake.state.calls.length = 0;
    bridge.stopRemoteBridge(projectScope);
    await bridge.settleRemoteBridgeTailscale(5_000);
    expect(serveCalls()).toEqual([]);
  });

  it('não sobrescreve nem desliga um handler alheio na porta 443', async () => {
    fake.state.foreignProxy = 'http://127.0.0.1:3000';

    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );
    bridge.stopRemoteBridge(projectScope);
    await bridge.settleRemoteBridgeTailscale(5_000);

    expect(info.tailscale).toMatchObject({
      status: 'requires-configuration',
      diagnostic: 'port-in-use',
    });
    expect(serveCalls().some((args) => args[1] === '--bg' || args.includes('off'))).toBe(false);
    expect(fake.state.foreignProxy).toBe('http://127.0.0.1:3000');
  });

  it('recusa Origin forjada por cabeçalhos do proxy e aceita a página servida pelo tailnet', async () => {
    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );
    const url = `wss://127.0.0.1:${info.port}`;

    const forged = new WebSocket(url, {
      rejectUnauthorized: false,
      headers: {
        Origin: `https://${MAGIC_DNS}`,
        'X-Forwarded-Host': MAGIC_DNS,
        'X-Forwarded-Proto': 'https',
        'Tailscale-User-Login': 'alice@example.com',
        'Tailscale-User-Name': 'Alice',
      },
    });
    forged.on('error', () => undefined);
    await expect(waitForClose(forged)).resolves.toEqual({
      code: 1008,
      reason: 'origin not allowed',
    });

    // Via Serve o Host é preservado: a página *.ts.net é same-origin.
    const viaServe = new WebSocket(url, {
      rejectUnauthorized: false,
      headers: { Host: MAGIC_DNS, Origin: `https://${MAGIC_DNS}` },
    });
    await openSocket(viaServe);
    await expect(ping(viaServe)).resolves.toMatchObject({ ok: true });
    // Tailnet é transporte, não autenticação: o pareamento segue obrigatório.
    const unauth = await new Promise<Record<string, unknown>>((resolve) => {
      viaServe.once('message', (data) => resolve(JSON.parse(data.toString())));
      viaServe.send(JSON.stringify({ id: 'x', type: 'panes.list' }));
    });
    expect(unauth).toMatchObject({ ok: false, error: 'auth required' });
    viaServe.close();
  });

  it('sem pedido explícito não roda Serve; o status só detecta (status --json)', async () => {
    const info = await bridge.startRemoteBridge({ host: '127.0.0.1' }, projectScope);
    expect(info.tailscale).toBeUndefined();
    expect(fake.state.calls).toEqual([]);

    const status = await bridge.getRemoteBridgeStatus(projectScope);
    expect(status.tailscale).toEqual({ magicDnsName: MAGIC_DNS, status: 'requires-configuration' });
    expect(fake.state.calls.map((call) => call.args)).toEqual([['status', '--json']]);
  });

  it('detecta CLI deslogada como unavailable', async () => {
    fake.state.statusJson = JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } });
    await expect(bridge.getRemoteBridgeStatus()).resolves.toMatchObject({
      tailscale: { magicDnsName: null, status: 'unavailable', diagnostic: 'not-logged-in' },
    });
  });

  it('boot remove o handler órfão nosso — e só o nosso', async () => {
    const orphan = 'https+insecure://127.0.0.1:45555';
    const writeMarker = (pid: number) =>
      fs.writeFileSync(
        markerPath(),
        JSON.stringify({ version: 1, servePort: 443, target: orphan, pid, createdAt: 1 }),
      );
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true });

    // Dono vivo (outra instância do Nexus): não toca.
    writeMarker(process.ppid);
    fake.state.serveTarget = orphan;
    await bridge.cleanupRemoteBridgeTailscaleOrphan();
    expect(fake.state.calls).toEqual([]);
    expect(fs.existsSync(markerPath())).toBe(true);

    // Dono morto (crash): remove.
    writeMarker(2_147_483_000);
    await bridge.cleanupRemoteBridgeTailscaleOrphan();
    expect(serveCalls()).toEqual([
      ['serve', 'status', '--json'],
      ['serve', '--https=443', 'off'],
    ]);
    expect(fake.state.serveTarget).toBeNull();
    expect(fs.existsSync(markerPath())).toBe(false);

    // Handler trocado por outra configuração: só descarta o marcador.
    fake.state.calls.length = 0;
    writeMarker(2_147_483_000);
    fake.state.foreignProxy = 'http://127.0.0.1:3000';
    await bridge.cleanupRemoteBridgeTailscaleOrphan();
    expect(serveCalls()).toEqual([['serve', 'status', '--json']]);
    expect(fake.state.foreignProxy).toBe('http://127.0.0.1:3000');
    expect(fs.existsSync(markerPath())).toBe(false);

    // Sem marcador: nenhum spawn.
    fake.state.calls.length = 0;
    await bridge.cleanupRemoteBridgeTailscaleOrphan();
    expect(fake.state.calls).toEqual([]);
  });
});
