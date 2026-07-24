// Driver CDP do Nexus dev (porta 9223): eval JS no renderer + screenshot.
// Uso: node drive.mjs "<expressao JS>" [--shot out.png] [--wait 1500]
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const expr = process.argv[2] ?? 'location.href';
const shotIdx = process.argv.indexOf('--shot');
const shot = shotIdx > -1 ? process.argv[shotIdx + 1] : null;
const waitIdx = process.argv.indexOf('--wait');
const waitMs = waitIdx > -1 ? Number(process.argv[waitIdx + 1]) : 1200;

const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(
  (t) => t.type === 'page' && !t.url.includes('pet.html'),
);
if (!page) {
  console.log('SEM_PAGE', targets.map((t) => `${t.type} ${t.url}`).join(' | '));
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
await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
const result = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
});
console.log(
  'RESULT:',
  JSON.stringify(result.result?.value ?? result, null, 1).slice(0, 3000),
);
if (result.exceptionDetails) {
  console.log('EXC:', JSON.stringify(result.exceptionDetails).slice(0, 800));
}
await new Promise((r) => setTimeout(r, waitMs));
if (shot) {
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shot, Buffer.from(cap.data, 'base64'));
  console.log('SHOT:', shot);
}
ws.close();
