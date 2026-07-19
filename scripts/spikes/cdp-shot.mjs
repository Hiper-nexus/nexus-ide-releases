#!/usr/bin/env node
/**
 * Screenshot do renderer via Chrome DevTools Protocol (dev apenas).
 * Requer o app dev rodando com `--remote-debugging-port=9222`:
 *   npm start -- -- --remote-debugging-port=9222
 *
 * Uso:
 *   node scripts/spikes/cdp-shot.mjs out.png [--eval "JS"] [--wait 1500] [--match "localhost"]
 *                                             [--keys "Escape,meta+b"]
 *
 * --eval roda JS no renderer (ex.: clicar num botão) antes do shot.
 * --keys despacha teclas REAIS via Input.dispatchKeyEvent (Escape, meta+b,
 * meta+shift+k, enter...), na sequência, antes do shot.
 * --wait espera N ms depois do eval (default 1200) para a UI assentar.
 */
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const [, , out, ...rest] = process.argv;
if (!out) {
  console.error('uso: cdp-shot.mjs out.png [--eval JS] [--wait ms] [--match substr]');
  process.exit(1);
}
const arg = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
};
const evalJs = arg('--eval', null);
const waitMs = Number(arg('--wait', 1200));
const match = arg('--match', 'localhost');
const keys = arg('--keys', null);
const viewW = Number(arg('--width', 1600));
const viewH = Number(arg('--height', 1000));
const PORT = process.env.CDP_PORT ?? 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetWs() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === 'page' && t.url.includes(match) && !t.url.includes('pet.html'),
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* server ainda não subiu */
    }
    await sleep(1000);
  }
  throw new Error(`nenhum target CDP em :${PORT} contendo "${match}"`);
}

const wsUrl = await targetWs();
const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
await new Promise((r) => ws.on('open', r));

await send('Page.enable');
await send('Runtime.enable');
// viewport generosa para capturar a UI inteira
await send('Emulation.setDeviceMetricsOverride', {
  width: viewW,
  height: viewH,
  deviceScaleFactor: 2,
  mobile: false,
});
await sleep(800);

const KEY_DEFS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  b: { key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 },
  k: { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 },
  n: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 },
  ',': { key: ',', code: 'Comma', windowsVirtualKeyCode: 188 },
  '/': { key: '/', code: 'Slash', windowsVirtualKeyCode: 191 },
};
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

async function pressKey(spec) {
  const parts = spec.toLowerCase().split('+');
  const keyName = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).reduce((m, p) => m | (MOD[p] ?? 0), 0);
  const def = KEY_DEFS[keyName] ?? {
    key: keyName,
    code: `Key${keyName.toUpperCase()}`,
    windowsVirtualKeyCode: keyName.toUpperCase().charCodeAt(0),
  };
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, modifiers, ...def });
  }
  await sleep(250);
}

if (keys) {
  for (const spec of keys.split(',')) await pressKey(spec.trim());
  await sleep(waitMs);
}

if (evalJs) {
  const result = await send('Runtime.evaluate', {
    expression: evalJs,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    console.error('eval falhou:', JSON.stringify(result.exceptionDetails).slice(0, 400));
    process.exit(2);
  }
  await sleep(waitMs);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`shot salvo em ${out}`);
ws.close();
process.exit(0);
