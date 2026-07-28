#!/usr/bin/env node
import WebSocket from 'ws';

const port = process.env.CDP_PORT ?? '9222';
const expression =
  process.argv[2] ??
  `({
    href: location.href,
    readyState: document.readyState,
    rootChildren: document.getElementById('root')?.childElementCount ?? null,
    bodyText: document.body?.innerText?.slice(0, 500) ?? '',
  })`;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5_000);
const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: controller.signal,
}).finally(() => clearTimeout(timeout));
const targets = await response.json();
const page = targets.find(
  (candidate) =>
    candidate.type === 'page' &&
    candidate.url.includes('localhost') &&
    !candidate.url.includes('pet.html'),
);
if (!page) throw new Error(`main page not found on CDP port ${port}`);

const socket = new WebSocket(page.webSocketDebuggerUrl, {
  maxPayload: 256 * 1024 * 1024,
});
const pending = new Map();
let sequence = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
socket.on('message', (raw) => {
  const message = JSON.parse(raw);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
await send('Runtime.enable');
const result = await Promise.race([
  send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Runtime.evaluate timed out')), 5_000),
  ),
]);
if (result.exceptionDetails) {
  throw new Error(
    result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'Runtime.evaluate failed',
  );
}
console.log(JSON.stringify(result.result?.value ?? null, null, 2));
socket.close();
