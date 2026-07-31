#!/usr/bin/env node
/**
 * Attach READ-ONLY ao app EMPACOTADO em execução via WebSocket de browser do CDP.
 * O endpoint HTTP /json não responde no app empacotado; o caminho que funciona é
 * o WS de browser anunciado em <userData>/DevToolsActivePort.
 *
 * Uso:
 *   node scripts/spikes/cdp-attach-browser.mjs targets
 *   node scripts/spikes/cdp-attach-browser.mjs shot out.png [--match index.html]
 *   node scripts/spikes/cdp-attach-browser.mjs eval "JS" [--match index.html]
 *
 * NUNCA usa Emulation nem Input — seguro para atacar a instância que o usuário
 * está usando agora (screenshot e Runtime.evaluate apenas).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

const [, , cmd, ...rest] = process.argv;
if (!cmd) {
  console.error('uso: cdp-attach-browser.mjs targets|shot|eval ...');
  process.exit(1);
}
const arg = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
};
const match = arg('--match', 'index.html');
const userData = process.env.NEXUS_CDP_USER_DATA
  ?? path.join(os.homedir(), 'Library', 'Application Support', 'NexusIDE');

const portFile = readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8');
const [portLine, wsPath] = portFile.trim().split('\n');
const browserWsUrl = `ws://127.0.0.1:${portLine}${wsPath}`;

const ws = new WebSocket(browserWsUrl, { maxPayload: 256 * 1024 * 1024 });
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
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

const { targetInfos } = await send('Target.getTargets');
if (cmd === 'targets') {
  for (const t of targetInfos) console.log(`${t.type}\t${t.targetId}\t${t.url.slice(0, 120)}`);
  ws.close();
  process.exit(0);
}

const page = targetInfos.find(
  (t) => t.type === 'page' && t.url.includes(match) && !t.url.includes('pet.html'),
);
if (!page) {
  console.error(`nenhum target page contendo "${match}"`);
  console.error(targetInfos.map((t) => `${t.type} ${t.url.slice(0, 100)}`).join('\n'));
  ws.close();
  process.exit(2);
}
const { sessionId } = await send('Target.attachToTarget', {
  targetId: page.targetId,
  flatten: true,
});

if (cmd === 'shot') {
  const out = rest.find((r) => !r.startsWith('--') && r !== match) ?? 'shot.png';
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`shot salvo em ${out}`);
} else if (cmd === 'eval') {
  const expression = rest.find((r) => !r.startsWith('--') && r !== match);
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    console.error('eval falhou:', JSON.stringify(result.exceptionDetails).slice(0, 600));
    process.exit(3);
  }
  console.log(JSON.stringify(result.result?.value, null, 2)?.slice(0, 8000));
}
ws.close();
process.exit(0);
