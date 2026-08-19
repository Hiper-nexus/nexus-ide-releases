// Clica dentro do pane cujo header chip diz "pane N" e manda Enter TRUSTED.
// Uso: node cdp-key-tmp.mjs <logfile> <paneLabel ex: "pane 6">
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const logPath = process.argv[2];
const paneLabel = process.argv[3] ?? 'pane 6';
const wsUrl = readFileSync(logPath, 'utf8').match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
if (!wsUrl) { console.log('SEM_WS'); process.exit(1); }

const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
let seq = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find((t) => t.type === 'page' && !t.url.includes('pet.html'));
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

const evald = await send('Runtime.evaluate', {
  expression: `(() => {
    const chips = [...document.querySelectorAll('*')].filter(el =>
      el.children.length === 0 && (el.textContent||'').trim() === ${JSON.stringify(paneLabel)});
    if (chips.length === 0) return JSON.stringify({ err: 'chip nao achado' });
    const r = chips[0].getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height + 160 });
  })()`,
  returnByValue: true,
}, sessionId);
const pos = JSON.parse(evald.result.value);
if (pos.err) { console.log(pos.err); process.exit(1); }

const mouse = (type) =>
  send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, sessionId);
await mouse('mousePressed');
await mouse('mouseReleased');
await new Promise((r) => setTimeout(r, 400));

const key = (type) =>
  send('Input.dispatchKeyEvent', {
    type, key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    text: type === 'keyDown' ? '\r' : undefined,
    unmodifiedText: type === 'keyDown' ? '\r' : undefined,
  }, sessionId);
await key('keyDown');
await key('keyUp');
console.log('ENTER_TRUSTED em', paneLabel, JSON.stringify(pos));
ws.close();
