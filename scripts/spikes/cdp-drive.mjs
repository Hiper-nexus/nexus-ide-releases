// Driver CDP do Nexus dev via BROWSER WebSocket (o endpoint HTTP /json trava;
// ver memória nexus-ide-cdp-driving). Anexa à page principal com Target.*
// (flatten) e roda Runtime.evaluate; opcionalmente captura screenshot.
//
// Uso: node scripts/spikes/cdp-drive.mjs "<JS>" [--shot out.png] [--wait 1200]
//      [--log <dev log com a linha "DevTools listening on ws://...">]
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const expr = process.argv[2] ?? 'location.href';
const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : fallback;
};
const shot = arg('--shot', null);
const waitMs = Number(arg('--wait', '800'));
const logPath = arg(
  '--log',
  '/private/tmp/claude-501/-Users-cleofasrocha-dev-nexus-ide/e0c52dee-d390-4b37-bd4a-f2217a365bfc/scratchpad/dev-e2e.log',
);

const logText = readFileSync(logPath, 'utf8');
const wsUrl = logText.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
if (!wsUrl) {
  console.log('SEM_WS_URL');
  process.exit(1);
}
const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
await new Promise((r, j) => {
  ws.on('open', r);
  ws.on('error', j);
});
const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find(
  (t) => t.type === 'page' && !t.url.includes('pet.html'),
);
if (!page) {
  console.log(
    'SEM_PAGE',
    targetInfos.map((t) => `${t.type} ${t.url.slice(0, 60)}`).join(' | '),
  );
  process.exit(1);
}
const { sessionId } = await send('Target.attachToTarget', {
  targetId: page.targetId,
  flatten: true,
});
const result = await send(
  'Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true },
  sessionId,
);
console.log(
  'RESULT:',
  JSON.stringify(result.result?.value ?? result, null, 1).slice(0, 3000),
);
if (result.exceptionDetails) {
  console.log('EXC:', JSON.stringify(result.exceptionDetails).slice(0, 700));
}
await new Promise((r) => setTimeout(r, waitMs));
if (shot) {
  const cap = await send(
    'Page.captureScreenshot',
    { format: 'png' },
    sessionId,
  );
  writeFileSync(shot, Buffer.from(cap.data, 'base64'));
  console.log('SHOT:', shot);
}
ws.close();
process.exit(0);
