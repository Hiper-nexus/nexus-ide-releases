import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyGuestWriteToken } from '../src/main/remote/relay/room-link';
import {
  importRoomKey,
  open,
  packEnvelope,
  seal,
  unpackEnvelope,
} from '../src/vendor/omp/wire/codec';

function companionSource(): string {
  return readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
}

function companionAppScript(): string {
  // Checkout Windows (autocrlf) traz CRLF: a regex aceita as duas formas.
  const match =
    /const APP_JS = String\.raw`([\s\S]*?)`;\r?\n\r?\nconst MANIFEST/.exec(companionSource());
  if (!match) throw new Error('companion APP_JS not found');
  return match[1];
}

function companionIndexHtml(): string {
  const match = /const INDEX_HTML = String\.raw`([\s\S]*?)`;\r?\n/.exec(companionSource());
  if (!match) throw new Error('companion INDEX_HTML not found');
  return match[1];
}

describe('companion pairing secret lifecycle', () => {
  it('consome o fragmento uma vez, remove-o da URL e mantém a rota WSS capturada', async () => {
    const room = '0123456789abcdef0123456789abcdef';
    const secret = Buffer.alloc(32, 7).toString('base64url');
    const relay = `wss://relay.nexuside.app/r/${room}#${secret}`;
    const dom = new JSDOM(
      [
        '<div id="status"></div>',
        '<div id="pairError"></div>',
        '<div id="message"></div>',
        '<button id="refresh"></button>',
        '<select id="panes"></select>',
        '<button id="send"></button>',
        '<input id="command">',
        '<pre id="terminal"></pre>',
      ].join(''),
      {
        url: `https://app.nexuside.app/#${encodeURIComponent(relay)}`,
        runScripts: 'outside-only',
      },
    );
    const opened: string[] = [];
    class FakeWebSocket {
      static readonly OPEN = 1;
      readonly url: string;
      readyState = 0;
      binaryType = '';
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;

      constructor(url: string) {
        this.url = url;
        opened.push(url);
      }

      send = vi.fn();
    }
    Object.defineProperty(dom.window, 'crypto', {
      configurable: true,
      value: {
        subtle: {
          importKey: vi.fn(async () => ({})),
        },
      },
    });
    Object.defineProperty(dom.window, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    });

    dom.window.eval(companionAppScript());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(dom.window.location.hash).toBe('');
    expect(opened).toEqual([`wss://relay.nexuside.app/r/${room}?role=guest`]);
    dom.window.close();
  });
});

// F-1472: textos que o cliente leigo vê no celular.
const MSG = {
  connecting: 'Conectando ao computador…',
  server:
    'Não conseguimos falar com o servidor do Nexus. Verifique a internet do celular e tente de novo em alguns instantes.',
  stale:
    'Este QR não está mais ativo. No computador, toque em Parar, depois em Iniciar, e escaneie o QR novo.',
  silent:
    'O computador não respondeu. Confira se o NexusIDE está aberto e com o acesso pelo celular ligado.',
  ended: 'O computador encerrou a sessão. Gere um QR novo para conectar de novo.',
  full: 'Muitos aparelhos já estão conectados. Desconecte um e tente de novo.',
  badQr:
    'Este QR está incompleto ou foi copiado errado. Escaneie o QR direto da tela do computador.',
  version:
    'Seu NexusIDE e esta página estão em versões diferentes. Atualize o NexusIDE e gere um QR novo.',
  viewOnly: 'Você está só assistindo. Para enviar comandos, use o QR de controle.',
};

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => Promise<void> | void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => Promise<void> | void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const ROOM = '0123456789abcdef0123456789abcdef';
const ROOM_KEY = Buffer.alloc(32, 7);
const WRITE_TOKEN = Buffer.from('fbefbeff'.repeat(4), 'hex');

/** Sobe o app.js real sobre o index.html real, com WebCrypto do Node e WebSocket falso. */
async function bootCompanion(
  secret: Buffer,
  { fakeTimers = false }: { fakeTimers?: boolean } = {},
): Promise<{ dom: JSDOM; sockets: FakeSocket[] }> {
  const relay = `wss://relay.nexuside.app/r/${ROOM}#${secret.toString('base64url')}`;
  const dom = new JSDOM(companionIndexHtml(), {
    url: `https://app.nexuside.app/#${encodeURIComponent(relay)}`,
    runScripts: 'outside-only',
  });
  const sockets: FakeSocket[] = [];
  class FakeWebSocket implements FakeSocket {
    static readonly OPEN = 1;
    readonly url: string;
    readyState = 0;
    binaryType = '';
    onopen: FakeSocket['onopen'] = null;
    onclose: FakeSocket['onclose'] = null;
    onerror: FakeSocket['onerror'] = null;
    onmessage: FakeSocket['onmessage'] = null;
    send = vi.fn();
    close = vi.fn();

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
  }
  const define = (name: string, value: unknown) =>
    Object.defineProperty(dom.window, name, { configurable: true, value });
  define('crypto', webcrypto);
  define('TextEncoder', TextEncoder);
  define('TextDecoder', TextDecoder);
  define('WebSocket', FakeWebSocket);
  if (fakeTimers) {
    define('setTimeout', globalThis.setTimeout);
    define('clearTimeout', globalThis.clearTimeout);
  }
  dom.window.eval(companionAppScript());
  // importKey é assíncrono: espera o socket nascer (sem depender de timers).
  for (let i = 0; i < 50 && sockets.length === 0; i++) {
    await webcrypto.subtle.digest('SHA-256', new Uint8Array(1));
  }
  return { dom, sockets };
}

async function openSocket(socket: FakeSocket): Promise<void> {
  socket.readyState = 1;
  await socket.onopen?.();
}

async function hostFrame(frame: unknown): Promise<ArrayBuffer> {
  const sealed = await seal(await importRoomKey(new Uint8Array(ROOM_KEY)), frame);
  const envelope = packEnvelope(0, sealed);
  return envelope.buffer.slice(
    envelope.byteOffset,
    envelope.byteOffset + envelope.byteLength,
  ) as ArrayBuffer;
}

function el(dom: JSDOM, id: string): HTMLElement {
  const node = dom.window.document.getElementById(id);
  if (!node) throw new Error(`#${id} ausente`);
  return node as HTMLElement;
}

/** Visível = nenhum ancestral com `.hidden` (display:none); devolve o texto. */
function visibleText(dom: JSDOM, id: string): string | null {
  let node: HTMLElement | null = el(dom, id);
  while (node) {
    if (node.classList.contains('hidden')) return null;
    node = node.parentElement;
  }
  return el(dom, id).textContent;
}

describe('F-1472: pareamento pelo QR', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('QR Full: o hello abre com o codec do desktop e o writeToken é aceito pelo host', async () => {
    const { dom, sockets } = await bootCompanion(Buffer.concat([ROOM_KEY, WRITE_TOKEN]));
    const socket = sockets[0]!;
    await openSocket(socket);
    expect(socket.send).toHaveBeenCalledTimes(1);

    const envelope = unpackEnvelope(new Uint8Array(socket.send.mock.calls[0]![0] as Uint8Array));
    expect(envelope).not.toBeNull();
    const hello = (await open(
      await importRoomKey(new Uint8Array(ROOM_KEY)),
      envelope!.payload,
    )) as { t: string; proto: number; writeToken?: string };
    expect(hello).toMatchObject({ t: 'hello', proto: 1 });
    expect(hello.writeToken).not.toMatch(/[=+/]/);
    expect(verifyGuestWriteToken(new Uint8Array(WRITE_TOKEN), hello.writeToken)).toBe(true);
    dom.window.close();
  });

  it('mostra "Conectando ao computador…" num elemento visível e só diz "conectado" depois do welcome', async () => {
    const { dom, sockets } = await bootCompanion(Buffer.concat([ROOM_KEY, WRITE_TOKEN]));
    expect(visibleText(dom, 'pairError')).toBe(MSG.connecting);

    await openSocket(sockets[0]!);
    expect(el(dom, 'status').textContent).not.toBe('conectado');
    expect(visibleText(dom, 'session')).toBeNull();

    // Sem await: depois do welcome o app pede panes.list e espera o RPC.
    void sockets[0]!.onmessage?.({
      data: await hostFrame({ t: 'welcome', proto: 1, readOnly: false, sessionName: 'nexus' }),
    });
    await vi.waitFor(() => expect(el(dom, 'status').textContent).toBe('conectado'));
    expect(visibleText(dom, 'session')).not.toBeNull();
    expect(visibleText(dom, 'pair')).toBeNull();
    dom.window.close();
  });

  it.each([
    [4004, MSG.stale],
    [4001, MSG.ended],
    [4029, MSG.full],
    [1006, MSG.server],
  ])('fechamento %i antes do welcome vira mensagem PT-BR visível', async (code, text) => {
    const { dom, sockets } = await bootCompanion(ROOM_KEY);
    sockets[0]!.onclose?.({ code, reason: '' });
    expect(visibleText(dom, 'pairError')).toBe(text);
    expect(el(dom, 'status').textContent).toBe('desconectado');
    dom.window.close();
  });

  it('socket aberto sem welcome em 8 s: diz que o computador não respondeu', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { dom, sockets } = await bootCompanion(ROOM_KEY, { fakeTimers: true });
    await openSocket(sockets[0]!);

    vi.advanceTimersByTime(7_999);
    expect(visibleText(dom, 'pairError')).toBe(MSG.connecting);
    vi.advanceTimersByTime(1);
    expect(visibleText(dom, 'pairError')).toBe(MSG.silent);
    expect(sockets[0]!.close).toHaveBeenCalled();
    // O close que vem depois não troca a explicação.
    sockets[0]!.onclose?.({ code: 1005 });
    expect(visibleText(dom, 'pairError')).toBe(MSG.silent);
    dom.window.close();
  });

  it('socket que nunca abre: teto de 25 s diz que não falou com o servidor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { dom } = await bootCompanion(ROOM_KEY, { fakeTimers: true });

    vi.advanceTimersByTime(24_999);
    expect(visibleText(dom, 'pairError')).toBe(MSG.connecting);
    vi.advanceTimersByTime(1);
    expect(visibleText(dom, 'pairError')).toBe(MSG.server);
    dom.window.close();
  });

  it('protocolo diferente vira a mensagem de versão', async () => {
    const { dom, sockets } = await bootCompanion(ROOM_KEY);
    await openSocket(sockets[0]!);
    await sockets[0]!.onmessage?.({
      data: await hostFrame({
        t: 'error',
        message: 'protocol mismatch: host speaks v2, guest sent v1',
      }),
    });
    expect(visibleText(dom, 'pairError')).toBe(MSG.version);
    dom.window.close();
  });

  it('QR com chave de tamanho errado: pede para escanear direto da tela', async () => {
    const { dom, sockets } = await bootCompanion(ROOM_KEY.subarray(0, 31));
    expect(sockets).toHaveLength(0);
    expect(visibleText(dom, 'pairError')).toBe(MSG.badQr);
    dom.window.close();
  });

  it('QR somente leitura conectado avisa que é só para assistir; 4001 depois encerra com aviso', async () => {
    const { dom, sockets } = await bootCompanion(ROOM_KEY);
    await openSocket(sockets[0]!);
    void sockets[0]!.onmessage?.({
      data: await hostFrame({ t: 'welcome', proto: 1, readOnly: true }),
    });
    await vi.waitFor(() => expect(visibleText(dom, 'message')).toBe(MSG.viewOnly));
    expect(el(dom, 'status').textContent).toBe('conectado');
    expect(visibleText(dom, 'inputRow')).toBeNull();

    sockets[0]!.onclose?.({ code: 4001, reason: 'room closed' });
    expect(visibleText(dom, 'message')).toBe(MSG.ended);
    dom.window.close();
  });
});
