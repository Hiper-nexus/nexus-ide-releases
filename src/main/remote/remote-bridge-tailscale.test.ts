// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: os casos do
// tailscaleEndpointProvider.test (endpoint MagicDNS available só com Serve +
// probe) rodam contra a Remote Bridge real com um tailscaled falso; somam-se
// stop/off, órfão no boot, handler alheio, tskey fora de log/IPC e Origin.

import { execFileSync } from 'node:child_process';
import crypto, { type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { TailscaleCli, TailscaleExecOptions } from './tailscale';

const SECRET = 'tskey-auth-secret-token-value';
const MAGIC_DNS = 'box.tail1234.ts.net';
const ORPHAN = 'https+insecure://127.0.0.1:45555';
const DEAD_PID = 2_147_483_000;

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
    serveStatusFailure: null as FakeResult | null,
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
    if (command === 'serve status --json') {
      return state.serveStatusFailure ?? { stdout: serveStatus() };
    }
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

interface DeviceCredential {
  token: string;
  deviceId: string;
  publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  privateKey: KeyObject;
}

function connectTo(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { rejectUnauthorized: false });
  return openSocket(socket).then(() => socket);
}

function rpc(socket: WebSocket, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout')), 10_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.send(JSON.stringify(payload));
  });
}

function newDevice(): Omit<DeviceCredential, 'token'> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    deviceId: crypto.randomBytes(24).toString('base64url'),
    publicKey: { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y) },
    privateKey,
  };
}

function sign(privateKey: KeyObject, challenge: string): string {
  return crypto
    .sign('sha256', Buffer.from(challenge), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
}

function pairMessage(device: Omit<DeviceCredential, 'token'>, code: string, id = 'pair') {
  return {
    id,
    type: 'pair',
    code,
    deviceId: device.deviceId,
    devicePublicKey: device.publicKey,
    deviceProof: sign(device.privateKey, `nexus-remote-pair-v1:${code}`),
  };
}

async function pairDevice(url: string): Promise<DeviceCredential> {
  const code = bridge.rotateRemotePairing(projectScope).pairingCode!;
  const device = newDevice();
  const socket = await connectTo(url);
  const paired = await rpc(socket, pairMessage(device, code));
  socket.close();
  return { ...device, token: (paired.result as { token: string }).token };
}

async function authenticate(url: string, device: DeviceCredential): Promise<WebSocket> {
  const socket = await connectTo(url);
  const requested = await rpc(socket, {
    id: 'challenge',
    type: 'auth.challenge',
    token: device.token,
    deviceId: device.deviceId,
  });
  const challenge = requested.result as { challenge: string; challengeId: string };
  const done = await rpc(socket, {
    id: 'auth',
    type: 'auth',
    token: device.token,
    deviceId: device.deviceId,
    challengeId: challenge.challengeId,
    signature: sign(device.privateKey, challenge.challenge),
  });
  expect(done).toMatchObject({ ok: true });
  return socket;
}

function writeOrphanMarker(file: string, pid = DEAD_PID, padding = 0): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, servePort: 443, target: ORPHAN, pid, createdAt: 1 }) +
      ' '.repeat(padding),
  );
}

function serveCalls(): string[][] {
  return fake.state.calls.map((call) => call.args).filter((args) => args[0] === 'serve');
}

function connectAs(url: string, headers: Record<string, string>): Promise<WebSocket> {
  const socket = new WebSocket(url, { rejectUnauthorized: false, headers });
  return openSocket(socket).then(() => socket);
}

async function closeAndWait(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = waitForClose(socket);
  socket.close();
  await closed;
}

/** Microtarefas + I/O real (setImmediate não é falsificado nestes testes). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Avança até a próxima tentativa e devolve quantos `serve status` ela gastou. */
async function nextRetry(delay: number): Promise<{ before: number; justBefore: number; after: number }> {
  const before = serveCalls().length;
  await vi.advanceTimersByTimeAsync(delay - 1);
  await flush();
  const justBefore = serveCalls().length;
  await vi.advanceTimersByTimeAsync(1);
  await bridge.settleRemoteBridgeTailscale(5_000);
  await flush();
  return { before, justBefore, after: serveCalls().length };
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
  fake.state.serveStatusFailure = null;
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
  // Novas tentativas armadas por um teste não podem disparar dentro de outro.
  bridge.cancelRemoteBridgeTailscaleRetries?.();
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

  it('marcador por symlink de arquivo não é seguido (O_NOFOLLOW)', async () => {
    const elsewhere = path.join(home, 'elsewhere', 'marker.json');
    writeOrphanMarker(elsewhere);
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, markerPath());
    fake.state.serveTarget = ORPHAN;

    await bridge.cleanupRemoteBridgeTailscaleOrphan();

    expect(fake.state.calls).toEqual([]);
    expect(fake.state.serveTarget).toBe(ORPHAN);
  });

  it('marcador FIFO sem escritor não pendura o Main e o publish o substitui', async () => {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', [markerPath()]);

    await bridge.cleanupRemoteBridgeTailscaleOrphan();
    expect(fake.state.calls).toEqual([]);

    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );
    expect(info.tailscale?.status).toBe('available');
    expect(fs.lstatSync(markerPath()).isFile()).toBe(true);
  });

  it('marcador gigante acima do teto é ignorado', async () => {
    writeOrphanMarker(markerPath(), DEAD_PID, 64 * 1024);
    fake.state.serveTarget = ORPHAN;

    await bridge.cleanupRemoteBridgeTailscaleOrphan();

    expect(fake.state.calls).toEqual([]);
    expect(fake.state.serveTarget).toBe(ORPHAN);
  });

  it('diretório do marcador trocado por symlink é recusado', async () => {
    const root = path.dirname(markerPath());
    const hijacked = path.join(home, 'hijacked-root');
    writeOrphanMarker(path.join(hijacked, 'tailscale-serve.json'));
    const saved = path.join(home, 'saved-root');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.renameSync(root, saved);
    fs.symlinkSync(hijacked, root);
    fake.state.serveTarget = ORPHAN;
    try {
      await bridge.cleanupRemoteBridgeTailscaleOrphan();
      expect(fake.state.calls).toEqual([]);
      expect(fake.state.serveTarget).toBe(ORPHAN);
    } finally {
      fs.rmSync(root, { force: true });
      fs.renameSync(saved, root);
    }
  });

  it('marcador por symlink para /dev/zero é recusado sem ler nada', async () => {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true, mode: 0o700 });
    fs.symlinkSync('/dev/zero', markerPath());

    await bridge.cleanupRemoteBridgeTailscaleOrphan();

    expect(fake.state.calls).toEqual([]);
  });

  it('falha de consulta do Serve não desliga nada: preserva o marcador e tenta de novo', async () => {
    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );
    const target = `https+insecure://127.0.0.1:${info.port}`;
    fake.state.serveStatusFailure = { code: 1, stderr: 'backend timeout' };
    fake.state.calls.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.stopRemoteBridge(projectScope);
      await bridge.settleRemoteBridgeTailscale(5_000);

      // Propriedade desconhecida: nenhum `off`, marcador intacto.
      expect(serveCalls()).toEqual([['serve', 'status', '--json']]);
      expect(fake.state.serveTarget).toBe(target);
      expect(JSON.parse(fs.readFileSync(markerPath(), 'utf8'))).toMatchObject({ target });

      // A consulta volta: a nova tentativa confirma que é nosso e desliga.
      fake.state.serveStatusFailure = null;
      await vi.advanceTimersByTimeAsync(5_000);
      await bridge.settleRemoteBridgeTailscale(5_000);
      expect(serveCalls().at(-1)).toEqual(['serve', '--https=443', 'off']);
      expect(fake.state.serveTarget).toBeNull();
      expect(fs.existsSync(markerPath())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('boot com consulta falha mantém o marcador órfão para o próximo boot', async () => {
    writeOrphanMarker(markerPath());
    fake.state.serveTarget = ORPHAN;
    fake.state.serveStatusFailure = { code: 1, stderr: 'backend timeout' };

    await bridge.cleanupRemoteBridgeTailscaleOrphan();

    expect(serveCalls()).toEqual([['serve', 'status', '--json']]);
    expect(fake.state.serveTarget).toBe(ORPHAN);
    expect(fs.existsSync(markerPath())).toBe(true);
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

describe('F-1000 (Tailscale Serve): limpeza do órfão no boot e no stop não desiste', () => {
  it('boot antes do Tailscale.app: repete 5 s/30 s/2 min e a cada 10 min até remover o órfão', async () => {
    writeOrphanMarker(markerPath());
    fake.state.serveTarget = ORPHAN;
    fake.state.serveStatusFailure = { code: 1, stderr: 'failed to connect to local tailscaled' };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await bridge.cleanupRemoteBridgeTailscaleOrphan();
      await flush();
      expect(serveCalls()).toEqual([['serve', 'status', '--json']]);

      for (const delay of [5_000, 30_000, 120_000, 600_000, 600_000]) {
        const round = await nextRetry(delay);
        expect(round.justBefore).toBe(round.before);
        expect(round.after).toBe(round.before + 1);
      }
      // Dono desconhecido o tempo todo: nada desligado, marcador intacto.
      expect(serveCalls().some((args) => args.includes('off'))).toBe(false);
      expect(fake.state.serveTarget).toBe(ORPHAN);
      expect(fs.existsSync(markerPath())).toBe(true);

      // O Tailscale subiu: a próxima tentativa confirma que é nosso e desliga.
      fake.state.serveStatusFailure = null;
      await nextRetry(600_000);
      expect(serveCalls().slice(-2)).toEqual([
        ['serve', 'status', '--json'],
        ['serve', '--https=443', 'off'],
      ]);
      expect(fake.state.serveTarget).toBeNull();
      expect(fs.existsSync(markerPath())).toBe(false);

      // Limpo: nada mais agendado.
      const done = fake.state.calls.length;
      await vi.advanceTimersByTimeAsync(3_600_000);
      await flush();
      expect(fake.state.calls).toHaveLength(done);
    } finally {
      vi.useRealTimers();
    }
  });

  it('para quando o marcador some e nunca desliga um Serve que virou alheio', async () => {
    writeOrphanMarker(markerPath());
    fake.state.serveTarget = ORPHAN;
    fake.state.serveStatusFailure = { code: 1, stderr: 'failed to connect to local tailscaled' };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await bridge.cleanupRemoteBridgeTailscaleOrphan();
      await flush();

      // Na volta do Tailscale a porta 443 é de outra configuração.
      fake.state.serveStatusFailure = null;
      fake.state.foreignProxy = 'http://127.0.0.1:3000';
      const round = await nextRetry(5_000);
      expect(round.after).toBe(round.before + 1);
      expect(serveCalls().some((args) => args.includes('off'))).toBe(false);
      expect(fake.state.foreignProxy).toBe('http://127.0.0.1:3000');
      expect(fs.existsSync(markerPath())).toBe(false);

      const done = fake.state.calls.length;
      await vi.advanceTimersByTimeAsync(3_600_000);
      await flush();
      expect(fake.state.calls).toHaveLength(done);

      // Marcador apagado por fora durante o backoff: a tentativa não gasta spawn.
      writeOrphanMarker(markerPath());
      fake.state.foreignProxy = null;
      fake.state.serveStatusFailure = { code: 1, stderr: 'failed to connect to local tailscaled' };
      await bridge.cleanupRemoteBridgeTailscaleOrphan();
      await flush();
      fs.rmSync(markerPath(), { force: true });
      const quiet = fake.state.calls.length;
      await vi.advanceTimersByTimeAsync(3_600_000);
      await flush();
      expect(fake.state.calls).toHaveLength(quiet);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop com a consulta falhando continua tentando depois da 3ª vez (a cada 10 min)', async () => {
    const info = await bridge.startRemoteBridge({ host: '127.0.0.1', tailscale: true }, projectScope);
    const target = `https+insecure://127.0.0.1:${info.port}`;
    fake.state.serveStatusFailure = { code: 1, stderr: 'backend timeout' };
    fake.state.calls.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.stopRemoteBridge(projectScope);
      await bridge.settleRemoteBridgeTailscale(5_000);
      await flush();
      expect(serveCalls()).toEqual([['serve', 'status', '--json']]);
      for (const delay of [5_000, 30_000, 120_000, 600_000]) {
        const round = await nextRetry(delay);
        expect(round.after).toBe(round.before + 1);
      }
      expect(fake.state.serveTarget).toBe(target);

      fake.state.serveStatusFailure = null;
      await nextRetry(600_000);
      expect(serveCalls().at(-1)).toEqual(['serve', '--https=443', 'off']);
      expect(fake.state.serveTarget).toBeNull();
      expect(fs.existsSync(markerPath())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('diretório do marcador não confiável publica sem marcador, mas avisa', async () => {
    const root = path.dirname(markerPath());
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o777);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const info = await bridge.startRemoteBridge({ host: '127.0.0.1', tailscale: true }, projectScope);
      expect(info.tailscale?.status).toBe('available');
      expect(fs.existsSync(markerPath())).toBe(false);
      const warned = warn.mock.calls.map((args) => args.map(String).join(' '));
      expect(warned.some((line) => line.includes('sem marcador'))).toBe(true);
    } finally {
      warn.mockRestore();
      fs.chmodSync(root, 0o700);
    }
  });

  it('nova tentativa enfileirada atrás de um republish na mesma porta não derruba a bridge viva', async () => {
    const first = await bridge.startRemoteBridge({ host: '127.0.0.1', tailscale: true }, projectScope);
    const fixedPort = first.port!;
    const target = `https+insecure://127.0.0.1:${fixedPort}`;
    fake.state.serveStatusFailure = { code: 1, stderr: 'backend timeout' };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.stopRemoteBridge(projectScope);
      await bridge.settleRemoteBridgeTailscale(5_000);
      await flush();

      // Republica na MESMA porta; o probe fica pendurado até a nova tentativa
      // do unpublish antigo disparar e entrar na fila atrás do publish.
      fake.state.serveStatusFailure = null;
      let releaseProbe: () => void = () => undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          fake.state.fetches.push({ url: String(url), init });
          await new Promise<void>((resolve) => {
            releaseProbe = resolve;
          });
          return new Response('{}', { status: 200 });
        }),
      );
      fake.state.calls.length = 0;
      fake.state.fetches.length = 0;
      let startError: unknown = null;
      let started: Awaited<ReturnType<Bridge['startRemoteBridge']>> | null = null;
      const restarted = bridge.startRemoteBridge(
        { host: '127.0.0.1', port: fixedPort, tailscale: true },
        projectScope,
      );
      restarted.then(
        (value) => {
          started = value;
        },
        (error: unknown) => {
          startError = error;
        },
      );
      // Laços com teto (I/O real via setImmediate): um travamento aqui não
      // pode deixar os timers falsos instalados para os testes seguintes.
      for (let i = 0; i < 500 && fake.state.fetches.length === 0 && startError === null; i += 1) {
        await flush();
      }
      expect(startError).toBeNull();
      expect(fake.state.fetches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      releaseProbe();
      for (let i = 0; i < 500 && started === null && startError === null; i += 1) await flush();
      expect(startError).toBeNull();
      const info = started as Awaited<ReturnType<Bridge['startRemoteBridge']>> | null;
      expect(info).not.toBeNull();
      if (!info) return;
      await bridge.settleRemoteBridgeTailscale(5_000);
      await flush();

      expect(info.tailscale?.status).toBe('available');
      expect(serveCalls().some((args) => args.includes('off'))).toBe(false);
      expect(fake.state.serveTarget).toBe(target);
      expect(JSON.parse(fs.readFileSync(markerPath(), 'utf8'))).toMatchObject({ target });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rate limit e pareamento atrás do proxy (todos chegam por loopback)', () => {
  it('rate limit: cliente não pareado do tailnet não esgota o bucket dos aparelhos', async () => {
    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );
    const url = `wss://127.0.0.1:${info.port}`;
    const device = await pairDevice(url);
    const authed = await authenticate(url, device);

    const intruder = await connectTo(url);
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 61; i += 1) last = await rpc(intruder, { id: `p${i}`, type: 'ping' });
    expect(last).toMatchObject({ ok: false, error: 'rate limited' });

    await expect(rpc(authed, { id: 'a', type: 'panes.list' })).resolves.toMatchObject({
      ok: true,
    });
    // Reconexão do aparelho legítimo (pré-auth com token válido) também passa.
    const again = await authenticate(url, device);
    await expect(rpc(again, { id: 'b', type: 'panes.list' })).resolves.toMatchObject({
      ok: true,
    });
    for (const socket of [authed, again, intruder]) socket.close();
  });

  it('pareamento: lockout atrás do proxy é por conexão e há teto global de tentativas', async () => {
    const info = await bridge.startRemoteBridge(
      { host: '127.0.0.1', tailscale: true },
      projectScope,
    );
    const url = `wss://127.0.0.1:${info.port}`;
    const code = info.pairingCode!;
    const attacker = await connectTo(url);
    const forger = newDevice();
    for (let i = 0; i < 8; i += 1) {
      await rpc(attacker, { ...pairMessage(forger, 'AAAAAAAA', `f${i}`), deviceProof: 'x' });
    }
    await expect(
      rpc(attacker, { ...pairMessage(forger, 'AAAAAAAA', 'locked'), deviceProof: 'x' }),
    ).resolves.toMatchObject({ ok: false, error: 'too many attempts; try again later' });

    // Outro aparelho (outra conexão pelo mesmo proxy) pareia com o código vigente.
    const honest = await connectTo(url);
    await expect(rpc(honest, pairMessage(newDevice(), code))).resolves.toMatchObject({
      ok: true,
    });

    // Força bruta distribuída em conexões novas esbarra no teto global do proxy.
    let rateLimitedAt = -1;
    let socket = await connectTo(url);
    for (let attempt = 0; attempt < 40 && rateLimitedAt < 0; attempt += 1) {
      if (attempt % 5 === 0) {
        socket.close();
        socket = await connectTo(url);
      }
      const res = await rpc(socket, {
        ...pairMessage(forger, 'BBBBBBBB', `g${attempt}`),
        deviceProof: 'x',
      });
      if (res.error === 'rate limited') rateLimitedAt = attempt;
    }
    expect(rateLimitedAt).toBeGreaterThanOrEqual(0);
    // 10 tentativas acima + estas: nunca mais que o teto (30/min) passa.
    expect(10 + rateLimitedAt).toBeLessThanOrEqual(30);
    for (const open of [socket, attacker, honest]) open.close();
  });
});

describe('F-1000 (Tailscale Serve): partição do pareamento pelo peer que o Serve carimba', () => {
  const MALLORY = { 'X-Forwarded-For': '100.64.0.9', 'Tailscale-User-Login': 'mallory@example.com' };
  const OWNER = { 'X-Forwarded-For': '100.101.102.50', 'Tailscale-User-Login': 'owner@example.com' };

  it('um peer do tailnet esgotando o próprio teto não nega o pareamento legítimo', async () => {
    const info = await bridge.startRemoteBridge({ host: '127.0.0.1', tailscale: true }, projectScope);
    const url = `wss://127.0.0.1:${info.port}`;
    const code = info.pairingCode!;
    const forger = newDevice();

    const attacker = await connectAs(url, MALLORY);
    const errors: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const res = await rpc(attacker, { ...pairMessage(forger, 'AAAAAAAA', `m${i}`), deviceProof: 'x' });
      errors.push(String(res.error));
    }
    // O teto vale para a partição dele (10/min)...
    expect(errors.slice(10).every((error) => error === 'rate limited')).toBe(true);
    await closeAndWait(attacker);

    // ...e o aparelho do dono, outra partição, pareia com o código vigente.
    const honest = await connectAs(url, OWNER);
    await expect(rpc(honest, pairMessage(newDevice(), code))).resolves.toMatchObject({ ok: true });
    await closeAndWait(honest);
  });

  it('o lockout da partição sobrevive à reconexão (não zera no close)', async () => {
    const info = await bridge.startRemoteBridge({ host: '127.0.0.1', tailscale: true }, projectScope);
    const url = `wss://127.0.0.1:${info.port}`;
    const forger = newDevice();
    const first = await connectAs(url, MALLORY);
    for (let i = 0; i < 8; i += 1) {
      await rpc(first, { ...pairMessage(forger, 'AAAAAAAA', `l${i}`), deviceProof: 'x' });
    }
    await closeAndWait(first);

    const again = await connectAs(url, MALLORY);
    await expect(
      rpc(again, { ...pairMessage(forger, 'AAAAAAAA', 'again'), deviceProof: 'x' }),
    ).resolves.toMatchObject({ ok: false, error: 'too many attempts; try again later' });
    await closeAndWait(again);
  });

  it('cabeçalhos só particionam com o Serve desta bridge publicado e X-Forwarded-For do tailnet', async () => {
    // Sem Serve publicado não há proxy: os cabeçalhos só podem ter sido forjados
    // por um processo local e caem no balde comum do loopback.
    const info = await bridge.startRemoteBridge({ host: '127.0.0.1' }, projectScope);
    const url = `wss://127.0.0.1:${info.port}`;
    const forger = newDevice();
    const spend = async (headers: Record<string, string>, count: number, tag: string) => {
      const socket = await connectAs(url, headers);
      let last: Record<string, unknown> = {};
      for (let i = 0; i < count; i += 1) {
        last = await rpc(socket, { ...pairMessage(forger, 'AAAAAAAA', `${tag}${i}`), deviceProof: 'x' });
      }
      await closeAndWait(socket);
      return last;
    };
    for (let i = 0; i < 6; i += 1) {
      await spend({ 'X-Forwarded-For': `100.64.1.${i + 1}`, 'Tailscale-User-Login': `u${i}@x.com` }, 5, `n${i}`);
    }
    await expect(spend(OWNER, 1, 'owner')).resolves.toMatchObject({ error: 'rate limited' });
    bridge.stopRemoteBridge(projectScope);
    await bridge.settleRemoteBridgeTailscale(5_000);

    // Com Serve, X-Forwarded-For fora do tailnet (ou ausente) também não particiona.
    const served = await bridge.startRemoteBridge({ host: '127.0.0.1', tailscale: true }, projectScope);
    const servedUrl = `wss://127.0.0.1:${served.port}`;
    const spendServed = async (headers: Record<string, string>, count: number, tag: string) => {
      const socket = await connectAs(servedUrl, headers);
      let last: Record<string, unknown> = {};
      for (let i = 0; i < count; i += 1) {
        last = await rpc(socket, { ...pairMessage(forger, 'AAAAAAAA', `${tag}${i}`), deviceProof: 'x' });
      }
      await closeAndWait(socket);
      return last;
    };
    for (let i = 0; i < 6; i += 1) {
      await spendServed({ 'X-Forwarded-For': `203.0.113.${i + 1}`, 'Tailscale-User-Login': `v${i}@x.com` }, 5, `w${i}`);
    }
    await expect(spendServed({ 'X-Forwarded-For': '8.8.8.8' }, 1, 'lan')).resolves.toMatchObject({
      error: 'rate limited',
    });
  });

  it('o teto global segue como rede: muitas partições não passam de 240/min', async () => {
    const info = await bridge.startRemoteBridge({ host: '127.0.0.1', tailscale: true }, projectScope);
    const url = `wss://127.0.0.1:${info.port}`;
    const forger = newDevice();
    let accepted = 0;
    let globallyLimited = false;
    for (let peer = 0; peer < 26 && !globallyLimited; peer += 1) {
      const socket = await connectAs(url, {
        'X-Forwarded-For': `100.64.2.${peer + 1}`,
        'Tailscale-User-Login': `peer${peer}@example.com`,
      });
      for (let i = 0; i < 10; i += 1) {
        const res = await rpc(socket, { ...pairMessage(forger, 'AAAAAAAA', `g${peer}-${i}`), deviceProof: 'x' });
        if (res.error === 'rate limited') {
          globallyLimited = true;
          break;
        }
        accepted += 1;
      }
      await closeAndWait(socket);
    }
    expect(globallyLimited).toBe(true);
    expect(accepted).toBeLessThanOrEqual(240);
  });
});
