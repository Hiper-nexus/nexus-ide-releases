import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function companionAppScript(): string {
  const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const match =
    /const APP_JS = String\.raw`([\s\S]*?)`;\n\nconst MANIFEST/.exec(source);
  if (!match) throw new Error('companion APP_JS not found');
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
