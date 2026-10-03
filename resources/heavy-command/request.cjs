const http = require('node:http');
const url = new URL(process.env.NEXUS_HEAVY_COMMAND_URL);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/hook/heavy-command') process.exit(78);
const body = JSON.stringify({ pid: Number(process.argv[2]), kind: 'typescript' });
// ps birth identity is second-granularity: do not claim a same-second PID.
setTimeout(() => {
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + process.env.NEXUS_GATE_TOKEN }, timeout: 360_000 }, (res) => {
    let text = '';
    res.on('data', (part) => { text += part; if (text.length > 2048) req.destroy(); });
    res.on('end', () => { try { const result = JSON.parse(text); process.exit(res.statusCode === 200 && result.allow === true ? 0 : 78); } catch { process.exit(78); } });
  });
  req.on('timeout', () => req.destroy()); req.on('error', () => process.exit(78)); req.end(body);
}, 1100);
