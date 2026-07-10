import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { generate } from 'selfsigned';
import type { ProxyConfig } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessBrowserUrl } from './url-policy';
import {
  installPinnedBrowserProxy,
  resolvePinnedBrowserTarget,
  startPinnedBrowserProxy,
  type PinnedBrowserProxy,
} from './browser-network-proxy';

const openServers: Array<{ close: (callback?: (error?: Error) => void) => void }> = [];
const openProxies: PinnedBrowserProxy[] = [];

function listen(
  server: net.Server | http.Server,
  host = '127.0.0.1',
): Promise<number> {
  openServers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('test server has no TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(
  server: { close: (callback?: (error?: Error) => void) => void },
): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function requestThroughProxy(
  proxyPort: number,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: targetUrl,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function openTunnel(proxyPort: number, authority: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let response = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const boundary = response.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      socket.off('data', onData);
      const head = response.subarray(0, boundary).toString('utf8');
      if (!head.startsWith('HTTP/1.1 200')) {
        reject(new Error(`CONNECT rejected: ${head}`));
        socket.destroy();
        return;
      }
      const trailing = response.subarray(boundary + 4);
      if (trailing.length > 0) socket.unshift(trailing);
      resolve(socket);
    };
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      );
    });
    socket.on('data', onData);
  });
}

async function startProxy(
  options: Parameters<typeof startPinnedBrowserProxy>[0],
): Promise<PinnedBrowserProxy> {
  const proxy = await startPinnedBrowserProxy(options);
  openProxies.push(proxy);
  return proxy;
}

afterEach(async () => {
  await Promise.all(openProxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe('pinned browser network proxy', () => {
  it('returns only numeric addresses that the connection layer can pin', async () => {
    const target = await resolvePinnedBrowserTarget('https://example.test/path', {
      resolver: async () => ['93.184.216.34', '2606:2800:220:1::34'],
      privateTargetAddresses: () => undefined,
      isTrustedPrivateUrl: () => false,
    });

    expect(target.hostname).toBe('example.test');
    expect(target.port).toBe(443);
    expect(target.addresses).toEqual([
      '93.184.216.34',
      '2606:2800:220:1::34',
    ]);
  });

  it('blocks a rebound address at the actual connection boundary', async () => {
    let internalHits = 0;
    const internal = http.createServer((_request, response) => {
      internalHits += 1;
      response.end('internal');
    });
    const internalPort = await listen(internal);
    const resolver = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['127.0.0.1']);
    const targetUrl = `http://rebind.test:${internalPort}/secret`;

    await expect(assessBrowserUrl(targetUrl, { resolver })).resolves.toMatchObject({
      allowed: true,
    });
    const proxy = await startProxy({
      resolver,
      privateTargetAddresses: () => undefined,
      isTrustedPrivateUrl: () => false,
    });

    await expect(requestThroughProxy(proxy.port, targetUrl)).resolves.toMatchObject({
      status: 403,
    });
    expect(internalHits).toBe(0);
  });

  it('connects to the approved IP while preserving the original HTTP Host', async () => {
    let receivedHost = '';
    const origin = http.createServer((request, response) => {
      receivedHost = request.headers.host ?? '';
      response.end('pinned-ok');
    });
    const originPort = await listen(origin);
    const targetUrl = `http://service.test:${originPort}/resource`;
    const proxy = await startProxy({
      resolver: async () => ['127.0.0.1'],
      privateTargetAddresses: (key) =>
        key === `service.test:${originPort}`
          ? new Set(['127.0.0.1'])
          : undefined,
      isTrustedPrivateUrl: () => false,
    });

    await expect(requestThroughProxy(proxy.port, targetUrl)).resolves.toEqual({
      status: 200,
      body: 'pinned-ok',
    });
    expect(receivedHost).toBe(`service.test:${originPort}`);
  });

  it('keeps trusted Nexus loopback previews working', async () => {
    const preview = http.createServer((_request, response) => response.end('preview'));
    const previewPort = await listen(preview);
    const origin = `http://127.0.0.1:${previewPort}`;
    const proxy = await startProxy({
      resolver: async () => {
        throw new Error('literal IPs must not require DNS');
      },
      privateTargetAddresses: () => undefined,
      isTrustedPrivateUrl: (url) => url.origin === origin,
    });

    await expect(requestThroughProxy(proxy.port, `${origin}/index.html`)).resolves.toEqual({
      status: 200,
      body: 'preview',
    });
  });

  it('preserves TLS SNI through CONNECT for HTTPS and secure WebSockets', async () => {
    const certificate = await generate(
      [{ name: 'commonName', value: 'secure.test' }],
      { keySize: 2048, algorithm: 'sha256' },
    );
    let receivedServername = '';
    const origin = tls.createServer(
      { key: certificate.private, cert: certificate.cert },
      (socket) => {
        receivedServername = socket.servername || '';
        socket.end('secure-ok');
      },
    );
    const originPort = await listen(origin);
    const proxy = await startProxy({
      resolver: async () => ['127.0.0.1'],
      privateTargetAddresses: (key) =>
        key === `secure.test:${originPort}`
          ? new Set(['127.0.0.1'])
          : undefined,
      isTrustedPrivateUrl: () => false,
    });
    const tunnel = await openTunnel(proxy.port, `secure.test:${originPort}`);
    const secureSocket = tls.connect({
      socket: tunnel,
      servername: 'secure.test',
      rejectUnauthorized: false,
    });

    await once(secureSocket, 'secureConnect');
    const [payload] = (await once(secureSocket, 'data')) as [Buffer];
    expect(payload.toString('utf8')).toBe('secure-ok');
    expect(receivedServername).toBe('secure.test');
    secureSocket.destroy();
  });

  it('forwards WebSocket upgrade handshakes through the pinned address', async () => {
    let receivedHost = '';
    let receivedPath = '';
    const origin = http.createServer();
    origin.on('upgrade', (request, socket) => {
      receivedHost = request.headers.host ?? '';
      receivedPath = request.url ?? '';
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Connection: Upgrade\r\n' +
          'Upgrade: nexus-test\r\n\r\nupgraded',
      );
    });
    const originPort = await listen(origin);
    const proxy = await startProxy({
      resolver: async () => ['127.0.0.1'],
      privateTargetAddresses: (key) =>
        key === `socket.test:${originPort}`
          ? new Set(['127.0.0.1'])
          : undefined,
      isTrustedPrivateUrl: () => false,
    });
    const client = net.connect({ host: '127.0.0.1', port: proxy.port });
    const response = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      client.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      client.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      client.once('error', reject);
    });
    await once(client, 'connect');
    client.write(
      `GET ws://socket.test:${originPort}/events?cursor=1 HTTP/1.1\r\n` +
        `Host: socket.test:${originPort}\r\n` +
        'Connection: Upgrade\r\n' +
        'Upgrade: nexus-test\r\n\r\n',
    );

    await expect(response).resolves.toContain('101 Switching Protocols');
    expect(receivedHost).toBe(`socket.test:${originPort}`);
    expect(receivedPath).toBe('/events?cursor=1');
  });

  it('revalidates every request and never lets a private grant include metadata', async () => {
    let internalHits = 0;
    const internal = http.createServer((_request, response) => {
      internalHits += 1;
      response.end('first');
    });
    const internalPort = await listen(internal);
    const resolver = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['127.0.0.1'])
      .mockResolvedValueOnce(['169.254.169.254']);
    const targetUrl = `http://changing.test:${internalPort}/asset`;
    const proxy = await startProxy({
      resolver,
      privateTargetAddresses: (key) =>
        key === `changing.test:${internalPort}`
          ? new Set(['127.0.0.1'])
          : undefined,
      isTrustedPrivateUrl: () => false,
    });

    await expect(requestThroughProxy(proxy.port, targetUrl)).resolves.toMatchObject({
      status: 200,
    });
    await expect(requestThroughProxy(proxy.port, targetUrl)).resolves.toMatchObject({
      status: 403,
    });
    expect(internalHits).toBe(1);
  });

  it('pins a private grant to the approved addresses, not only hostname and port', async () => {
    const resolver = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['127.0.0.1'])
      .mockResolvedValueOnce(['127.0.0.2']);
    const targetUrl = 'http://private-grant.test:8080/resource';
    const approved = new Set(['127.0.0.1']);
    const policy = {
      resolver,
      privateTargetAddresses: () => approved,
      isTrustedPrivateUrl: () => false,
    };

    await expect(resolvePinnedBrowserTarget(targetUrl, policy)).resolves.toMatchObject({
      addresses: ['127.0.0.1'],
    });
    await expect(resolvePinnedBrowserTarget(targetUrl, policy)).rejects.toThrow(
      /private-network/,
    );
  });

  it('installs a fail-closed session proxy before dropping pooled connections', async () => {
    const order: string[] = [];
    const setProxy = vi.fn(async (_config: ProxyConfig) => {
      order.push('proxy');
    });
    const session = {
      setProxy,
      closeAllConnections: vi.fn(async () => {
        order.push('connections');
      }),
    };
    const proxy = await installPinnedBrowserProxy(session, {
      resolver: async () => ['93.184.216.34'],
      privateTargetAddresses: () => undefined,
      isTrustedPrivateUrl: () => false,
    });
    openProxies.push(proxy);

    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: `http://127.0.0.1:${proxy.port}`,
      proxyBypassRules: '<-loopback>',
    });
    expect(String(setProxy.mock.calls[0]?.[0]?.proxyRules)).not.toContain(
      'direct://',
    );
    expect(order).toEqual(['proxy', 'connections']);
  });
});
