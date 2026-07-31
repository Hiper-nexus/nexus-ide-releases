#!/usr/bin/env node
// Runtime.evaluate no renderer dev (porta CDP_PORT ?? 9223) e imprime o valor.
// Sem reload, sem emulation — seguro para inspecionar estado ao vivo.
//   node scripts/spikes/cdp-eval-dev.mjs "<JS>" [--match localhost]
import WebSocket from 'ws';

const expr = process.argv[2] ?? 'location.href';
const matchIndex = process.argv.indexOf('--match');
const match = matchIndex > -1 ? process.argv[matchIndex + 1] : 'localhost';
const PORT = process.env.CDP_PORT ?? 9223;

const res = await fetch(`http://127.0.0.1:${PORT}/json`);
const targets = await res.json();
const page = targets.find(
  (t) => t.type === 'page' && t.url.includes(match) && !t.url.includes('pet.html'),
);
if (!page) {
  console.error('sem page target');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl, {
  maxPayload: 256 * 1024 * 1024,
});
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
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
const result = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
});
if (result.exceptionDetails) {
  console.error('EXCECAO:', JSON.stringify(result.exceptionDetails).slice(0, 800));
  process.exit(2);
}
console.log(JSON.stringify(result.result?.value, null, 2));
ws.close();
process.exit(0);
