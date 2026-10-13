import crypto, { type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

// F-1478: a porta do "Celular na rede local" não pode mudar a cada início, e
// iniciar/parar/trocar de host precisa deixar um só listener vivo.
// Os mesmos stubs de remote-bridge.test.ts: só rede, sem electron.
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
let home: string;
let previousHome: string | undefined;
const scope = {
  version: 1 as const,
  installationId: 'install-test',
  projectId: 'project-port',
  checkoutId: 'checkout-port',
  rootRealPath: '/workspace/port',
  identitySource: 'manifest' as const,
};
const UI = { persistPort: true } as const;
const LAN_IP = '192.168.77.5';

function portFile(): string {
  return path.join(home, '.nexus', 'remote-bridge', 'port.json');
}

function savedPort(): unknown {
  return (JSON.parse(fs.readFileSync(portFile(), 'utf8')) as { port?: unknown }).port;
}

function writePortFile(content: string): void {
  fs.mkdirSync(path.dirname(portFile()), { recursive: true });
  fs.writeFileSync(portFile(), content);
}

function occupy(host = '127.0.0.1'): Promise<net.Server> {
  const blocker = net.createServer();
  return new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, host, () => resolve(blocker));
  });
}

function portOf(server: net.Server): number {
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no port');
  return addr.port;
}

function release(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Uma porta livre do SO, não a 47820 que as suítes paralelas disputam. */
async function seedFreePort(): Promise<number> {
  const probe = await occupy();
  const free = portOf(probe);
  await release(probe);
  writePortFile(JSON.stringify({ port: free }));
  return free;
}

/** 'open' se algo ainda aceita conexão na porta; senão o código do erro. */
function probe(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve('open');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
  });
}

function fakeLan() {
  return vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    lo: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
    ],
    eth0: [
      {
        address: LAN_IP,
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '02:00:00:00:00:01',
        internal: false,
        cidr: `${LAN_IP}/24`,
      },
    ],
  });
}

// --- Cliente real (pareia e autentica como o app do celular) ---
interface Device {
  deviceId: string;
  publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  privateKey: KeyObject;
  token?: string;
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

function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function sign(privateKey: KeyObject, message: string): string {
  return crypto
    .sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
}

function newDevice(): Device {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    deviceId: crypto.randomBytes(24).toString('base64url'),
    publicKey: { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y) },
    privateKey,
  };
}

async function pair(port: number, code: string, device: Device): Promise<void> {
  const socket = await connect(port);
  const paired = await rpc(socket, {
    id: 'pair',
    type: 'pair',
    code,
    deviceId: device.deviceId,
    devicePublicKey: device.publicKey,
    deviceProof: sign(device.privateKey, `nexus-remote-pair-v1:${code}`),
  });
  socket.close();
  const token = (paired.result as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string') throw new Error(`pairing failed: ${JSON.stringify(paired)}`);
  device.token = token;
}

async function authenticate(port: number, device: Device): Promise<WebSocket> {
  const socket = await connect(port);
  const requested = await rpc(socket, {
    id: 'challenge',
    type: 'auth.challenge',
    token: device.token,
    deviceId: device.deviceId,
  });
  const challenge = requested.result as { challenge: string; challengeId: string };
  const response = await rpc(socket, {
    id: 'auth',
    type: 'auth',
    token: device.token,
    deviceId: device.deviceId,
    challengeId: challenge.challengeId,
    signature: sign(device.privateKey, challenge.challenge),
  });
  if (response.ok !== true) throw new Error(`auth failed: ${JSON.stringify(response)}`);
  return socket;
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-port-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  bridge = await import('./remote-bridge');
});

afterEach(async () => {
  bridge.stopRemoteBridge();
  fs.rmSync(portFile(), { force: true });
  (await import('./remote-device-token-store')).revokeRemoteDeviceTokens(scope);
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('F-1478: porta do bridge persistida entre inícios', () => {
  it('dois inícios pela tela abrem na mesma porta, salva em port.json', async () => {
    // Sem arquivo: tenta a 47820 (outra suíte em paralelo pode estar nela).
    const fresh = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
    expect(fresh.port === 47820 || fresh.portFallbackFrom === 47820).toBe(true);
    bridge.stopRemoteBridge(scope);

    const seeded = await seedFreePort();
    const first = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
    expect(first.port).toBe(seeded);
    expect(first.portFallbackFrom).toBeUndefined();
    bridge.stopRemoteBridge(scope);

    const second = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
    expect(second.port).toBe(seeded);
    expect(second.urls).toEqual(first.urls);
    expect(savedPort()).toBe(seeded);
  });

  it('início sem a tela (ferramenta MCP) usa a porta salva mas não grava port.json', async () => {
    const started = await bridge.startRemoteBridge({}, scope);
    expect(started.running).toBe(true);
    expect(fs.existsSync(portFile())).toBe(false);
  });

  it('port.json ilegível ou fora da faixa: volta para a 47820', async () => {
    for (const content of ['{not json', JSON.stringify({ port: 80 }), JSON.stringify({ port: 70000 })]) {
      writePortFile(content);
      const info = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
      expect(info.port === 47820 || info.portFallbackFrom === 47820).toBe(true);
      bridge.stopRemoteBridge(scope);
    }
  });

  it('porta salva ocupada (EADDRINUSE): abre noutra só desta vez, avisa, e não grava a efêmera', async () => {
    const blocker = await occupy();
    const taken = portOf(blocker);
    try {
      writePortFile(JSON.stringify({ port: taken }));
      const fallback = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
      expect(fallback.running).toBe(true);
      expect(fallback.port).not.toBe(taken);
      expect(fallback.portFallbackFrom).toBe(taken);
      expect(savedPort()).toBe(taken);
      const stopped = bridge.stopRemoteBridge(scope);
      expect(stopped.portFallbackFrom).toBeUndefined();
    } finally {
      await release(blocker);
    }
    // Livre de novo: volta para a salva.
    const again = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
    expect(again.port).toBe(taken);
    expect(again.portFallbackFrom).toBeUndefined();
  });

  it('porta salva reservada (EACCES, faixa excluída do Windows): também abre noutra e avisa', async () => {
    const seeded = await seedFreePort();
    const listen = vi.spyOn(net.Server.prototype, 'listen').mockImplementationOnce(function (
      this: net.Server,
    ) {
      process.nextTick(() =>
        this.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })),
      );
      return this;
    });
    try {
      const info = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
      expect(info.running).toBe(true);
      expect(info.portFallbackFrom).toBe(seeded);
      expect(info.port).not.toBe(seeded);
      expect(savedPort()).toBe(seeded);
    } finally {
      listen.mockRestore();
    }
  });

  it('porta pedida explicitamente e ocupada continua falhando, sem tocar a salva', async () => {
    const blocker = await occupy();
    try {
      await expect(
        bridge.startRemoteBridge({ host: '127.0.0.1', port: portOf(blocker) }, scope, UI),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(fs.existsSync(portFile())).toBe(false);
      expect(bridge.getRemoteBridgeInfo(scope).running).toBe(false);
    } finally {
      await release(blocker);
    }
  });
});

describe('F-1478: trocar de host com o bridge no ar', () => {
  it('127.0.0.1 → rede local → 127.0.0.1: mesma porta, socket antigo cai e o aparelho reautentica sem parear de novo', async () => {
    const interfaces = fakeLan();
    try {
      const seeded = await seedFreePort();
      const local = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
      expect(local.port).toBe(seeded);
      expect(local.urls).not.toContain(`wss://${LAN_IP}:${seeded}`);
      const device = newDevice();
      await pair(seeded, local.pairingCode!, device);
      const before = await authenticate(seeded, device);
      const closed = new Promise<number>((resolve) => before.once('close', (code) => resolve(code)));
      expect(bridge.getRemoteBridgeInfo(scope).devices?.[0]).toMatchObject({
        connected: true,
        connectedUrl: `https://127.0.0.1:${seeded}`,
      });

      const lan = await bridge.startRemoteBridge({ host: '0.0.0.0' }, scope, UI);
      expect(await closed).toBe(1001);
      expect(lan.running).toBe(true);
      expect(lan.port).toBe(seeded);
      expect(lan.endpoints).toContainEqual({ url: `wss://${LAN_IP}:${seeded}`, label: 'Rede local' });
      expect(lan.pairingCode).toBeTruthy();
      expect(lan.pairingCode).not.toBe(local.pairingCode);
      expect(lan.tokenCount).toBe(1);
      const after = await authenticate(seeded, device);
      expect(bridge.getRemoteBridgeInfo(scope).devices?.[0]?.connected).toBe(true);
      after.close();

      // Sem host (ou o mesmo): nada muda.
      const same = await bridge.startRemoteBridge({}, scope, UI);
      expect(same.pairingCode).toBe(lan.pairingCode);

      // E de volta: "Iniciar neste computador" desexpõe da rede local.
      const back = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
      expect(back.port).toBe(seeded);
      expect(back.urls).not.toContain(`wss://${LAN_IP}:${seeded}`);
      expect(back.endpoints).toEqual([{ url: `wss://127.0.0.1:${seeded}`, label: 'Este computador' }]);
    } finally {
      interfaces.mockRestore();
    }
  }, 30_000);

  it('rebind que falha (porta explícita ocupada) restaura o bridge anterior com o mesmo código', async () => {
    const seeded = await seedFreePort();
    const local = await bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
    // Bloqueio no wildcard: no Windows 127.0.0.1:Q e 0.0.0.0:Q convivem; dois 0.0.0.0:Q não.
    const blocker = await occupy('0.0.0.0');
    try {
      await expect(
        bridge.startRemoteBridge({ host: '0.0.0.0', port: portOf(blocker) }, scope, UI),
      ).rejects.toMatchObject({
        code: 'EADDRINUSE',
        message: expect.stringContaining(`o bridge anterior continua em 127.0.0.1:${seeded}`),
      });
    } finally {
      await release(blocker);
    }
    const restored = bridge.getRemoteBridgeInfo(scope);
    expect(restored.running).toBe(true);
    expect(restored.port).toBe(seeded);
    expect(restored.pairingCode).toBe(local.pairingCode);
    expect(await probe(seeded)).toBe('open');
  }, 20_000);
});

describe('F-1478: início, parada e rebind em série', () => {
  it('dois inícios ao mesmo tempo deixam um só listener, e parar fecha tudo', async () => {
    const seeded = await seedFreePort();
    const [a, b] = await Promise.all([
      bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI),
      bridge.startRemoteBridge({ host: '127.0.0.1' }, scope),
    ]);
    expect(a.port).toBe(seeded);
    expect(b.port).toBe(seeded);
    expect(b.pairingCode).toBe(a.pairingCode);

    bridge.stopRemoteBridge(scope);
    const ports = [...new Set([a.port!, b.port!])];
    expect(await Promise.all(ports.map(probe))).toEqual(ports.map(() => 'ECONNREFUSED'));
  }, 20_000);

  it('parar no meio de um início cancela o início: nada fica escutando', async () => {
    const seeded = await seedFreePort();
    const pending = bridge.startRemoteBridge({ host: '127.0.0.1' }, scope, UI);
    bridge.stopRemoteBridge(scope);
    await expect(pending).rejects.toThrow('remote bridge stopped while starting');
    expect(bridge.getRemoteBridgeInfo(scope).running).toBe(false);
    expect(await probe(seeded)).toBe('ECONNREFUSED');
  }, 20_000);
});
