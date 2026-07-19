import WebSocket from 'ws';
const res = await fetch('http://127.0.0.1:9222/json');
const targets = await res.json();
console.log('targets:', targets.map(t => `${t.type} ${t.url}`).join('\n'));
const page = targets.find(t => t.type === 'page' && t.url.includes('localhost') && !t.url.includes('pet.html'));
if (!page) { console.log('sem page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256*1024*1024 });
let seq = 0; const pending = new Map();
const send = (method, params={}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, {resolve, reject});
  ws.send(JSON.stringify({id, method, params}));
});
const errors = [];
ws.on('message', raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) { const {resolve,reject} = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 800));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error: ' + JSON.stringify(msg.params.args).slice(0, 500));
});
await new Promise(r => ws.on('open', r));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise(r => setTimeout(r, 6000));
const href = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
console.log('href:', href.result.value);
const html = await send('Runtime.evaluate', { expression: 'document.getElementById("root")?.innerHTML?.slice(0,200) ?? "ROOT VAZIO"', returnByValue: true });
console.log('root:', html.result.value);
console.log('--- erros capturados ---');
for (const e of errors.slice(0, 5)) console.log(e);
ws.close(); process.exit(0);
