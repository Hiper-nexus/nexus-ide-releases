#!/usr/bin/env node
import WebSocket from 'ws';

const port = process.env.CDP_PORT ?? '9222';
const deadline = Date.now() + Number(process.env.CDP_WATCH_MS ?? '45000');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let page;
while (Date.now() < deadline && !page) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const targets = await response.json();
    page = targets.find(
      (candidate) =>
        candidate.type === 'page' &&
        candidate.url.includes('localhost') &&
        !candidate.url.includes('pet.html'),
    );
  } catch {
    // Main is either restarting or busy; retry until the overall deadline.
  }
  if (!page) await sleep(100);
}
if (!page) throw new Error(`main page not found on CDP port ${port}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
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
  if (message.id && pending.has(message.id)) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params?.exceptionDetails;
    console.log(
      'EXCEPTION',
      String(detail?.exception?.description ?? detail?.text ?? 'unknown').slice(
        0,
        1_000,
      ),
    );
  }
  if (message.method === 'Debugger.paused') {
    console.log(
      'PAUSED',
      JSON.stringify(
        (message.params?.callFrames ?? []).slice(0, 12).map((frame) => ({
          functionName: frame.functionName,
          url: frame.url,
          line: (frame.location?.lineNumber ?? -1) + 1,
          column: (frame.location?.columnNumber ?? -1) + 1,
        })),
      ),
    );
    void send('Debugger.resume').catch(() => {});
  }
  if (
    message.method === 'Runtime.consoleAPICalled' &&
    ['error', 'warning'].includes(message.params?.type)
  ) {
    const text = (message.params?.args ?? [])
      .map((argument) =>
        typeof argument.value === 'string' ? argument.value : argument.description,
      )
      .filter(Boolean)
      .join(' ')
      .slice(0, 1_000);
    console.log(`CONSOLE_${message.params.type.toUpperCase()}`, text);
  }
});
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
await send('Runtime.enable');
await send('Page.enable');
await send('Debugger.enable');
console.log('ATTACHED', page.url);
setTimeout(() => {
  void send('Debugger.pause').catch((error) => {
    console.log('PAUSE_ERROR', error.message);
  });
}, 3_000);

let evaluating = false;
const poll = setInterval(() => {
  if (evaluating || socket.readyState !== WebSocket.OPEN) return;
  evaluating = true;
  void send('Runtime.evaluate', {
    expression: `({
      readyState: document.readyState,
      rootChildren: document.getElementById('root')?.childElementCount ?? null,
      rootText: document.getElementById('root')?.textContent?.slice(0, 120) ?? '',
    })`,
    returnByValue: true,
  })
    .then((result) => {
      console.log('STATE', JSON.stringify(result.result?.value ?? null));
    })
    .catch((error) => {
      console.log('EVALUATE_ERROR', error.message);
    })
    .finally(() => {
      evaluating = false;
    });
}, 1_000);

await sleep(Math.max(0, deadline - Date.now()));
clearInterval(poll);
socket.close();
