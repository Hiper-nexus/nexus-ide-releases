import WebSocket from 'ws';
const res = await fetch('http://127.0.0.1:9222/json');
const targets = await res.json();
const page = targets.find(t => t.type === 'page' && t.url.match(/localhost:\d+\/$/));
if (!page) { console.log('sem page principal'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256*1024*1024 });
let seq = 0; const pending = new Map();
const send = (m, p={}) => new Promise((resolve, reject) => { const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method:m,params:p})); });
ws.on('message', raw => { const msg=JSON.parse(raw); if(msg.id&&pending.has(msg.id)){const{resolve,reject}=pending.get(msg.id);pending.delete(msg.id);msg.error?reject(new Error(msg.error.message)):resolve(msg.result);} });
await new Promise(r => ws.on('open', r));
await send('Runtime.enable');
const expr = `(() => {
  const bar = document.querySelector('.workspace-bar');
  if (!bar) return 'sem barra';
  const actions = bar.querySelector('.workspace-bar__actions');
  const sysBtns = [...bar.querySelectorAll('.workspace-bar__zone--system > *')];
  const last = sysBtns[sysBtns.length-1];
  const barR = bar.getBoundingClientRect();
  const lastR = last ? last.getBoundingClientRect() : null;
  return JSON.stringify({
    innerWidth: window.innerWidth,
    density: bar.dataset.density,
    barClientW: bar.clientWidth, barScrollW: bar.scrollWidth,
    actionsClientW: actions?.clientWidth, actionsScrollW: actions?.scrollWidth,
    barRight: Math.round(barR.right),
    lastControl: last?.className?.toString().slice(0,60),
    lastRight: lastR ? Math.round(lastR.right) : null,
    clipped: lastR ? Math.round(lastR.right - barR.right) : null,
  }, null, 1);
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result.value);
ws.close(); process.exit(0);
