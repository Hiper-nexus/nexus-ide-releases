/**
 * Ponta a ponta no workerd real com a configuração de produção (wrangler.jsonc):
 * o `CompanionRelayHost` do desktop cria a sala e o PWA de verdade
 * (`companion/worker.js`, rodando em JSDOM com WebCrypto do Node) entra pelo QR
 * de controle, recebe o welcome, lista e lê terminais e recebe saída ao vivo.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import {
  CompanionRelayHost,
  type CompanionDispatchMessage,
} from '../../src/main/remote/relay/companion-relay-transport';
import { APP_ORIGIN, ipHeaders, startRelay, type Relay } from './harness';

const PROD_RELAY = 'wss://relay.nexuside.app';

const projectScope = {
  version: 1 as const,
  installationId: 'install-test',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
};

function companionSource(): string {
  return readFileSync(new URL('../../companion/worker.js', import.meta.url), 'utf8');
}

function companionAppScript(): string {
  const match = /const APP_JS = String\.raw`([\s\S]*?)`;\r?\n\r?\nconst MANIFEST/.exec(companionSource());
  if (!match) throw new Error('companion APP_JS not found');
  return match[1]!;
}

function companionIndexHtml(): string {
  const match = /const INDEX_HTML = String\.raw`([\s\S]*?)`;\r?\n/.exec(companionSource());
  if (!match) throw new Error('companion INDEX_HTML not found');
  return match[1]!;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout esperando ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('companion ponta a ponta pelo relay Cloudflare', () => {
  let relay: Relay;
  before(async () => {
    relay = await startRelay({});
  });
  after(async () => {
    await relay?.stop();
  });

  it('QR de controle: PWA conecta, ganha controle, lê o terminal e recebe saída ao vivo; Parar encerra o celular', { timeout: 60_000 }, async () => {
    const dispatched: CompanionDispatchMessage[] = [];
    const host = new CompanionRelayHost({
      relayUrl: relay.wsBase,
      scope: projectScope,
      sessionName: 'Projeto A',
      dispatch: async (message) => {
        dispatched.push(message);
        if (message.type === 'panes.list') return [{ paneId: 'p1', title: 'Terminal 1' }];
        if (message.type === 'pane.read') return { output: 'saída lida do desktop\n' };
        throw new Error(`rpc inesperado: ${message.type}`);
      },
    });
    let dom: JSDOM | undefined;
    try {
      const info = await host.start();
      await until(() => host.info().connected, 'host conectado ao relay');
      // O QR aponta para wss://relay.nexuside.app; o socket do "navegador" é
      // redirecionado para o workerd local e manda o Origin do PWA.
      const link = info.fullLink!.replace(relay.wsBase, PROD_RELAY);
      const relayBase = relay.wsBase;
      class BrowserWebSocket extends WebSocket {
        constructor(url: string) {
          super(url.replace(PROD_RELAY, relayBase), {
            origin: APP_ORIGIN,
            headers: ipHeaders(),
          });
        }
      }
      dom = new JSDOM(companionIndexHtml(), {
        url: `${APP_ORIGIN}/#${encodeURIComponent(link)}`,
        runScripts: 'outside-only',
      });
      const window = dom.window;
      const define = (name: string, value: unknown) =>
        Object.defineProperty(window, name, { configurable: true, value });
      define('crypto', webcrypto);
      define('TextEncoder', TextEncoder);
      define('TextDecoder', TextDecoder);
      define('WebSocket', BrowserWebSocket);
      const text = (id: string) => window.document.getElementById(id)?.textContent ?? '';

      window.eval(companionAppScript());
      // O segredo saiu da barra de endereço assim que foi lido.
      assert.equal(window.location.hash, '');
      await until(() => text('terminal').includes('saída lida do desktop'), 'terminal lido no celular');
      assert.match(text('status'), /conectado/);
      assert.equal(text('mode'), 'controle permitido');
      assert.equal(text('sessionName'), 'Projeto A');
      assert.equal(host.info().guestCount, 1);
      assert.ok(host.hasWritablePeer(), 'o writeToken do QR de controle foi aceito pelo desktop');
      assert.deepEqual(
        dispatched.map((message) => message.type),
        ['panes.list', 'pane.read'],
      );

      host.pushPaneOutput('p1', 'session-e2e', 'saída ao vivo\n');
      await until(() => text('terminal').includes('saída ao vivo'), 'saída ao vivo no celular');

      host.stop();
      await until(
        () => text('message').includes('O computador encerrou a sessão.'),
        'aviso de sessão encerrada no celular',
      );
    } finally {
      host.stop();
      dom?.window.close();
    }
  });
});
