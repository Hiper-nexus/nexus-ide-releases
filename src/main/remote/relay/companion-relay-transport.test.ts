import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { startRelayServer } from '../../../../server/src/relay/server';
import {
  COMPANION_RELAY_PROTO,
  type CompanionHostFrame,
} from '../../../shared/companion-relay-types';
import {
  importRoomKey,
  open,
  packEnvelope,
  seal,
  unpackEnvelope,
} from '../../../vendor/omp/wire/codec';
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from '../../../shared/terminal-stream-protocol';
import { clearRemoteTerminalStreams } from '../remote-terminal-streams';
import { startBlindRelay, type BlindRelay } from './blind-relay';
import { parseRelayRoomLink } from './room-link';
import { formatCompanionWebUrl } from './companion-web-link';
import {
  CompanionRelayHost,
  type CompanionDispatchMessage,
} from './companion-relay-transport';

const projectScope = {
  version: 1 as const,
  installationId: 'install-test',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
};

interface TestGuest {
  ws: WebSocket;
  writeToken: string | undefined;
  send(frame: unknown): Promise<void>;
  next(timeoutMs?: number): Promise<CompanionHostFrame>;
  close(): void;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Simula um guest mobile: WebSocket cru + codec vendorado (mesma wire). */
async function connectGuest(link: string): Promise<TestGuest> {
  const parsed = parseRelayRoomLink(link);
  if ('error' in parsed) throw new Error(parsed.error);
  const key = await importRoomKey(parsed.roomKey);
  const ws = new WebSocket(`${parsed.wsUrl}?role=guest`);
  ws.binaryType = 'nodebuffer';
  const queue: CompanionHostFrame[] = [];
  const waiters: Array<(frame: CompanionHostFrame) => void> = [];
  // Serializa open() para preservar a ordem de chegada dos frames.
  let recvChain: Promise<void> = Promise.resolve();
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) return; // Controle TEXT (room-closed) fora do escopo aqui.
    const envelope = unpackEnvelope(new Uint8Array(toBuffer(data)));
    if (!envelope) return;
    recvChain = recvChain.then(async () => {
      const frame = (await open(key, envelope.payload)) as CompanionHostFrame;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    writeToken: parsed.writeToken
      ? Buffer.from(parsed.writeToken).toString('base64url')
      : undefined,
    async send(frame: unknown): Promise<void> {
      const sealed = await seal(key, frame);
      ws.send(packEnvelope(0, sealed));
    },
    next(timeoutMs = 5_000): Promise<CompanionHostFrame> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('frame timeout')),
          timeoutMs,
        );
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
    close(): void {
      try {
        ws.terminate();
      } catch {
        // Já fechado.
      }
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('companion-relay-transport', () => {
  let relay: BlindRelay | null = null;
  let transport: CompanionRelayHost | null = null;
  const guests: TestGuest[] = [];

  afterEach(async () => {
    for (const guest of guests.splice(0)) guest.close();
    transport?.stop();
    transport = null;
    await relay?.stop();
    relay = null;
    clearRemoteTerminalStreams();
  });

  async function startTransport(
    dispatch: (
      msg: CompanionDispatchMessage,
    ) => Promise<unknown> = async (msg) => ({ echo: msg.type }),
  ): Promise<{
    dispatchSpy: ReturnType<typeof vi.fn>;
    fullLink: string;
    viewLink: string;
  }> {
    relay = await startBlindRelay();
    const dispatchSpy = vi.fn(
      async (msg: CompanionDispatchMessage, _scope: unknown) => dispatch(msg),
    );
    transport = new CompanionRelayHost({
      relayUrl: relay.url,
      scope: projectScope,
      dispatch: dispatchSpy,
      sessionName: 'nexus-test',
    });
    const info = await transport.start();
    expect(info.running).toBe(true);
    expect(info.fullLink).toBeDefined();
    expect(info.viewLink).toBeDefined();
    expect(info.qrSvgFull).toContain('<svg');
    expect(info.qrSvgView).toContain('<svg');
    // Espera o socket host→relay abrir para a sala existir no relay.
    await waitFor(() => transport!.info().connected);
    return {
      dispatchSpy,
      fullLink: info.fullLink!,
      viewLink: info.viewLink!,
    };
  }

  async function joinGuest(link: string, name: string): Promise<TestGuest> {
    const guest = await connectGuest(link);
    guests.push(guest);
    await guest.send({
      t: 'hello',
      proto: COMPANION_RELAY_PROTO,
      name,
      ...(guest.writeToken ? { writeToken: guest.writeToken } : {}),
    });
    return guest;
  }

  it('links full/view apontam para a mesma sala; QR presente', async () => {
    const { fullLink, viewLink } = await startTransport();
    const full = parseRelayRoomLink(fullLink);
    const view = parseRelayRoomLink(viewLink);
    if ('error' in full || 'error' in view) throw new Error('link inválido');
    expect(full.roomId).toBe(view.roomId);
    expect(full.writeToken).toBeDefined();
    expect(view.writeToken).toBeUndefined();
    expect(Buffer.from(full.roomKey)).toEqual(Buffer.from(view.roomKey));
  });

  it('F-1472: expõe a MESMA URL https do PWA que o QR codifica (não o wss cru)', async () => {
    const { fullLink, viewLink } = await startTransport();
    const info = transport!.info();
    expect(info.fullWebUrl).toBe(formatCompanionWebUrl(fullLink));
    expect(info.viewWebUrl).toBe(formatCompanionWebUrl(viewLink));
    expect(info.fullWebUrl).toMatch(/^https:\/\/app\.nexuside\.app\/#/);
  });

  it('F-1472: relay respondendo 404 ao upgrade grava o motivo transitório sem segredo e mantém o QR', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(404).end();
    });
    server.on('upgrade', (_request, socket: Duplex) => {
      // O que o Railway devolve quando o serviço do relay não existe.
      socket.end(
        'HTTP/1.1 404 Not Found\r\nX-Railway-Fallback: true\r\nContent-Length: 0\r\n\r\n',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      transport = new CompanionRelayHost({
        relayUrl: `ws://127.0.0.1:${port}`,
        scope: projectScope,
        dispatch: vi.fn(async () => ({})),
      });
      const started = await transport.start();
      await waitFor(() => transport!.info().lastError !== undefined, 3_000);
      const info = transport.info();
      expect(info).toMatchObject({ running: true, connected: false });
      expect(info.lastError).toMatch(/404/);
      const fragment = started.fullLink!.split('#')[1]!;
      const viewFragment = started.viewLink!.split('#')[1]!;
      for (const secret of [started.roomId!, fragment, viewFragment]) {
        expect(info.lastError).not.toContain(secret);
      }
      expect(info.lastError).not.toMatch(/wss?:\/\//);
      // Queda transitória: a sala volta com o mesmo id, então o QR não muda.
      expect(info.fullLink).toBe(started.fullLink);
    } finally {
      transport?.stop();
      transport = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('F-1472: close reason com URL da sala chega à UI redigido (sem sala nem chave)', async () => {
    let closeReason = '';
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    fake.on('connection', (socket) => {
      socket.close(1011, closeReason || 'upstream down');
    });
    await new Promise<void>((resolve) => fake.once('listening', () => resolve()));
    const { port } = fake.address() as AddressInfo;
    try {
      transport = new CompanionRelayHost({
        relayUrl: `ws://127.0.0.1:${port}`,
        scope: projectScope,
        dispatch: vi.fn(async () => ({})),
      });
      const started = await transport.start();
      // Um relay/proxy hostil devolvendo o próprio link da sala no close reason.
      closeReason = `up ${started.viewLink!}`;
      await waitFor(() => transport!.info().lastError?.includes('<relay>') === true, 5_000);
      const lastError = transport.info().lastError!;
      expect(lastError).not.toContain(started.roomId!);
      expect(lastError).not.toContain(started.viewLink!.split('#')[1]!);
      expect(lastError).not.toMatch(/wss?:\/\//);
      expect(transport.info().fullLink).toBe(started.fullLink);
    } finally {
      transport?.stop();
      transport = null;
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });

  it('F-1472: queda transitória esquece os guests (sem guestCount inflado nem respondente fantasma)', async () => {
    const { fullLink } = await startTransport();
    const guest = await joinGuest(fullLink, 'phone');
    expect(await guest.next()).toMatchObject({ t: 'welcome', readOnly: false });
    expect(transport!.info().guestCount).toBe(1);
    expect(transport!.hasWritablePeer()).toBe(true);

    // O relay cai: expulsa o guest e fecha o host com 1001 (transitório).
    await relay!.stop();
    relay = null;
    await waitFor(() => !transport!.info().connected);
    expect(transport!.info().guestCount).toBe(0);
    expect(transport!.hasWritablePeer()).toBe(false);
    expect(transport!.info().fullLink).toBe(fullLink);
  });

  it('F-1472: relay de produção (server.ts) fecha o host pelo TTL e o desktop apaga o QR', async () => {
    const production = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      allowedOrigins: new Set(),
      maxRooms: 4,
      maxPeersPerRoom: 2,
      maxFrameBytes: 256 * 1024,
      roomTtlMs: 150,
      heartbeatMs: 60_000,
      maxUpgradesPerIpPerMinute: 100,
    });
    try {
      transport = new CompanionRelayHost({
        relayUrl: `ws://127.0.0.1:${production.port}`,
        scope: projectScope,
        dispatch: vi.fn(async () => ({})),
      });
      await transport.start();
      await waitFor(() => transport!.info().connected);
      await waitFor(() => transport!.info().lastError !== undefined, 3_000);
      // Estado que a UI traduz em "A sala do celular foi encerrada" + "Gerar novo QR".
      expect(transport.info()).toEqual({
        running: true,
        connected: false,
        relayUrl: `ws://127.0.0.1:${production.port}`,
        guestCount: 0,
        lastError: 'room closed',
      });
    } finally {
      transport?.stop();
      transport = null;
      production.stop();
    }
  });

  it('F-1472: sala encerrada pelo relay (TTL → 4001) apaga QR e links velhos', async () => {
    relay = await startBlindRelay({ roomTtlMs: 100, sweepIntervalMs: 20 });
    transport = new CompanionRelayHost({
      relayUrl: relay.url,
      scope: projectScope,
      dispatch: vi.fn(async () => ({})),
    });
    await transport.start();
    await waitFor(() => transport!.info().connected);
    await waitFor(() => transport!.info().lastError !== undefined, 3_000);
    const info = transport.info();
    expect(info).toMatchObject({
      running: true,
      connected: false,
      lastError: 'room closed',
      guestCount: 0,
    });
    expect(info.roomId).toBeUndefined();
    expect(info.fullLink).toBeUndefined();
    expect(info.viewLink).toBeUndefined();
    expect(info.fullWebUrl).toBeUndefined();
    expect(info.qrSvgFull).toBeUndefined();
    expect(info.qrSvgView).toBeUndefined();

    // "Gerar novo QR" passa por Parar + Iniciar: Parar não deixa motivo velho.
    expect(transport.stop().lastError).toBeUndefined();
  });

  it('guest com writeToken recebe welcome com escrita e RPC é despachado', async () => {
    const { dispatchSpy, fullLink } = await startTransport();
    const guest = await joinGuest(fullLink, 'phone');
    const welcome = await guest.next();
    expect(welcome).toMatchObject({
      t: 'welcome',
      proto: COMPANION_RELAY_PROTO,
      readOnly: false,
      sessionName: 'nexus-test',
    });
    await guest.send({ t: 'rpc', rpc: { id: 'r1', type: 'panes.list' } });
    const result = await guest.next();
    expect(result).toEqual({
      t: 'rpc-result',
      id: 'r1',
      ok: true,
      result: { echo: 'panes.list' },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls[0]![0]).toEqual({ type: 'panes.list' });
    expect(dispatchSpy.mock.calls[0]![1]).toEqual(projectScope);
  });

  it('guest view-only: welcome read-only, RPC mutante rejeitado ANTES do dispatch', async () => {
    const { dispatchSpy, viewLink } = await startTransport();
    const guest = await joinGuest(viewLink, 'viewer');
    const welcome = await guest.next();
    expect(welcome).toMatchObject({ t: 'welcome', readOnly: true });

    await guest.send({
      t: 'rpc',
      rpc: { id: 'w1', type: 'pane.input', paneId: 'p1', data: 'rm -rf /' },
    });
    const rejected = await guest.next();
    expect(rejected).toMatchObject({ t: 'rpc-result', id: 'w1', ok: false });
    expect((rejected as { error?: string }).error).toMatch(/read-only/);
    expect(dispatchSpy).not.toHaveBeenCalled();

    // RPC read-only continua liberado para view-only (policy decide depois).
    await guest.send({ t: 'rpc', rpc: { id: 'w2', type: 'ops.snapshot' } });
    const allowed = await guest.next();
    expect(allowed).toMatchObject({ t: 'rpc-result', id: 'w2', ok: true });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('writeToken forjado (mesmo tamanho) não dá escrita', async () => {
    const { dispatchSpy, viewLink } = await startTransport();
    const guest = await connectGuest(viewLink);
    guests.push(guest);
    await guest.send({
      t: 'hello',
      proto: COMPANION_RELAY_PROTO,
      name: 'forger',
      writeToken: Buffer.alloc(16, 7).toString('base64url'),
    });
    const welcome = await guest.next();
    expect(welcome).toMatchObject({ t: 'welcome', readOnly: true });
    await guest.send({
      t: 'rpc',
      rpc: { id: 'f1', type: 'pane.input', data: 'x' },
    });
    const rejected = await guest.next();
    expect(rejected).toMatchObject({ t: 'rpc-result', id: 'f1', ok: false });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('frame indecifrável de guest não derruba a sessão do host (view-only DoS)', async () => {
    const { fullLink } = await startTransport();
    const guest = await joinGuest(fullLink, 'phone');
    await guest.next(); // welcome

    // Um guest hostil/quebrado injeta um envelope com payload que passa o
    // formato mínimo (IV 12B + tag) mas falha o GCM. O relay cego encaminha ao
    // host sem poder verificar. O host deve dropar só esse frame, não a sessão.
    const garbage = new Uint8Array(28);
    garbage.set([9, 9, 9], 12); // bytes não-nulos após o IV → tag inválida
    guest.ws.send(packEnvelope(0, garbage));
    await new Promise((r) => setTimeout(r, 30));

    // Sessão continua viva: um novo output de pane ainda flui ao guest legítimo.
    transport!.pushPaneOutput('pane-alive', 'session-alive', 'still-here');
    const frame = await guest.next();
    expect(frame.t).toBe('pty');
    expect((frame as Extract<CompanionHostFrame, { t: 'pty' }>).pane).toBe(
      'pane-alive',
    );
    expect(transport!.info().running).toBe(true);
  });

  it('frame pty selado chega ao guest e abre corretamente', async () => {
    const { fullLink } = await startTransport();
    const guest = await joinGuest(fullLink, 'phone');
    await guest.next(); // welcome
    transport!.pushPaneOutput('pane-7', 'session-7', 'hello-pty');
    const frame = await guest.next();
    expect(frame.t).toBe('pty');
    const pty = frame as Extract<CompanionHostFrame, { t: 'pty' }>;
    expect(pty.pane).toBe('pane-7');
    expect(typeof pty.seq).toBe('number');
    const decoded = decodeTerminalStreamFrame(
      new Uint8Array(Buffer.from(pty.data, 'base64')),
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.opcode).toBe(TerminalStreamOpcode.Output);
    expect(new TextDecoder().decode(decoded!.payload)).toBe('hello-pty');
  });

  it('view-only também recebe streams pty (estado flui; mutação não)', async () => {
    const { viewLink } = await startTransport();
    const guest = await joinGuest(viewLink, 'viewer');
    await guest.next(); // welcome
    transport!.pushPaneOutput('pane-9', 'session-9', 'observa');
    const frame = await guest.next();
    expect(frame).toMatchObject({ t: 'pty', pane: 'pane-9' });
  });

  it('RPC antes do hello é rejeitado', async () => {
    const { dispatchSpy, fullLink } = await startTransport();
    const guest = await connectGuest(fullLink);
    guests.push(guest);
    await guest.send({ t: 'rpc', rpc: { id: 'n1', type: 'panes.list' } });
    const rejected = await guest.next();
    expect(rejected).toMatchObject({ t: 'rpc-result', id: 'n1', ok: false });
    expect((rejected as { error?: string }).error).toMatch(/hello required/);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('hello com protocolo errado recebe erro e não vira peer', async () => {
    const { dispatchSpy, fullLink } = await startTransport();
    const guest = await connectGuest(fullLink);
    guests.push(guest);
    await guest.send({ t: 'hello', proto: 999, name: 'future' });
    const error = await guest.next();
    expect(error.t).toBe('error');
    expect((error as { message: string }).message).toMatch(/protocol mismatch/);
    await guest.send({ t: 'rpc', rpc: { id: 'p1', type: 'panes.list' } });
    const rejected = await guest.next();
    expect(rejected).toMatchObject({ t: 'rpc-result', ok: false });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('ping responde pong sem passar pelo dispatch', async () => {
    const { dispatchSpy, fullLink } = await startTransport();
    const guest = await joinGuest(fullLink, 'phone');
    await guest.next(); // welcome
    await guest.send({ t: 'rpc', rpc: { id: 'pg', type: 'ping' } });
    const result = await guest.next();
    expect(result).toEqual({
      t: 'rpc-result',
      id: 'pg',
      ok: true,
      result: { pong: true },
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('erro do dispatch vira rpc-result ok:false (nunca derruba o transporte)', async () => {
    const { fullLink } = await startTransport(async () => {
      throw new Error('not authorized: destructive-confirmation-required');
    });
    const guest = await joinGuest(fullLink, 'phone');
    await guest.next(); // welcome
    await guest.send({
      t: 'rpc',
      rpc: { id: 'd1', type: 'git.push' },
    });
    const result = await guest.next();
    expect(result).toEqual({
      t: 'rpc-result',
      id: 'd1',
      ok: false,
      error: 'not authorized: destructive-confirmation-required',
    });
    expect(transport!.info().running).toBe(true);
  });

  it('frame malformado recebe error sem derrubar o host', async () => {
    const { fullLink } = await startTransport();
    const guest = await connectGuest(fullLink);
    guests.push(guest);
    await guest.send({ t: 'nonsense', payload: 1 });
    const error = await guest.next();
    expect(error).toMatchObject({ t: 'error', message: 'malformed frame' });
    expect(transport!.info().running).toBe(true);
  });
});
