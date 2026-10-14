/**
 * Sobe o Worker real em `wrangler dev` (workerd local, Durable Objects e
 * limitador nativo simulados pelo Miniflare) e dá clientes `ws` para falar com
 * ele. Com RELAY_TEST_URL definido, usa esse relay em vez de subir um.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { type RawData } from 'ws';

export const WORKER_DIR = fileURLToPath(new URL('..', import.meta.url));
export const APP_ORIGIN = 'https://app.nexuside.app';

export interface Relay {
  /** ws://127.0.0.1:porta (sem barra no fim). Muda depois de restart(). */
  wsBase: string;
  httpBase: string;
  /**
   * Mata o workerd sem fechar nada (como um deploy ou uma queda) e sobe de novo
   * com o mesmo estado persistido. Só no relay local.
   */
  restart?(): Promise<void>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

async function spawnDev(vars: Record<string, string>, persistTo: string): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const inspectorPort = await freePort();
  const args = [
    '--yes',
    'wrangler@latest',
    'dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--inspector-port',
    String(inspectorPort),
    '--persist-to',
    persistTo,
    '--show-interactive-dev-session=false',
    '--log-level',
    'warn',
    ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
  ];
  const child = spawn('npx', args, {
    cwd: WORKER_DIR,
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev saiu (${child.exitCode}):\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status === 404) return { child, port };
    } catch {
      // Ainda subindo.
    }
    if (Date.now() > deadline) {
      killTree(child);
      throw new Error(`wrangler dev não ficou pronto:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function startRelay(vars: Record<string, string>): Promise<Relay> {
  const external = process.env.RELAY_TEST_URL?.replace(/\/+$/, '');
  if (external) {
    return {
      wsBase: external,
      httpBase: external.replace(/^ws/, 'http'),
      stop: async () => {},
    };
  }
  const persistTo = mkdtempSync(join(tmpdir(), 'nexus-relay-test-'));
  let dev = await spawnDev(vars, persistTo);
  const relay: Relay = {
    wsBase: `ws://127.0.0.1:${dev.port}`,
    httpBase: `http://127.0.0.1:${dev.port}`,
    async restart() {
      killTree(dev.child);
      await new Promise((resolve) => setTimeout(resolve, 500));
      dev = await spawnDev(vars, persistTo);
      relay.wsBase = `ws://127.0.0.1:${dev.port}`;
      relay.httpBase = `http://127.0.0.1:${dev.port}`;
    },
    async stop() {
      killTree(dev.child);
      await new Promise((resolve) => setTimeout(resolve, 200));
      rmSync(persistTo, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return relay;
}

let roomCounter = 0;
/** Sala sintética nova (nunca um link real). */
export function newRoom(): string {
  roomCounter += 1;
  return `test${Date.now().toString(36)}${roomCounter.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

let ipCounter = 0;
/**
 * O limitador conta por CF-Connecting-IP. Localmente o header passa como veio,
 * então cada cliente de teste ganha um IP sintético e o teste de 429 tem o seu.
 */
export function syntheticIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

/** Na borda real o header vindo do cliente é recusado (403): só vai ao workerd local. */
export function ipHeaders(ip = syntheticIp()): Record<string, string> {
  return process.env.RELAY_TEST_URL ? {} : { 'CF-Connecting-IP': ip };
}

export interface Closed {
  code: number;
  reason: string;
}

export class TestClient {
  readonly ws: WebSocket;
  readonly texts: string[] = [];
  readonly frames: Uint8Array[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<Closed>;
  /** Status HTTP quando o upgrade é recusado. */
  readonly rejected: Promise<number>;
  #waiters: Array<() => void> = [];

  constructor(url: string, options: { origin?: string; ip?: string; autoPong?: boolean } = {}) {
    this.ws = new WebSocket(url, {
      headers: ipHeaders(options.ip),
      ...(options.origin ? { origin: options.origin } : {}),
      autoPong: options.autoPong ?? true,
    });
    this.ws.binaryType = 'nodebuffer';
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        // O workerd local só encerra logo o TCP de quem já mandou alguma coisa
        // (sem isto o close chega na hora e o evento 'close' leva ~10 s). Cliente
        // real sempre manda: o PWA abre com hello e o desktop com frames e ping.
        // TEXT que não é ping o relay ignora: não encaminha, não renova o TTL.
        this.ws.send('{"t":"hello-test"}');
        resolve();
      });
      this.ws.once('error', reject);
    });
    this.opened.catch(() => {});
    this.rejected = new Promise((resolve) => {
      this.ws.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
        this.ws.terminate();
      });
    });
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString('utf8') }));
    });
    this.ws.on('message', (data: RawData, isBinary: boolean) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) this.frames.push(new Uint8Array(bytes));
      else this.texts.push(bytes.toString('utf8'));
      for (const wake of this.#waiters.splice(0)) wake();
    });
  }

  send(data: Uint8Array | string): void {
    this.ws.send(data);
  }

  async waitFor<T>(pick: () => T | undefined, timeoutMs = 5_000, what = 'mensagem'): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = pick();
      if (value !== undefined) return value;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout esperando ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  text(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string> {
    return this.waitFor(() => this.texts.find(predicate), timeoutMs, 'TEXT');
  }

  frame(index: number, timeoutMs?: number): Promise<Uint8Array> {
    return this.waitFor(() => this.frames[index], timeoutMs, `frame #${index}`);
  }

  close(): void {
    this.ws.close(1000);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

export function envelope(peerId: number, payload: number[] | Uint8Array): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(body, 4);
  return out;
}

export function peerOf(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
}

/** Resolve com 'open' se nada fechar o socket dentro de `ms`. */
export function staysOpen(client: TestClient, ms: number): Promise<'open' | Closed> {
  return Promise.race([client.closed, new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), ms))]);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pedido de upgrade cru: devolve o status HTTP (101 quando o upgrade aconteceu). */
export function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
        ...ipHeaders(),
        ...headers,
      },
    });
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.once('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
  });
}
