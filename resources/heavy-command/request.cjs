const http = require('node:http');
let url;
try { url = new URL(process.env.NEXUS_HEAVY_COMMAND_URL); } catch { process.exit(78); }
// Check before constructing a request: bearer capability never leaves loopback.
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/hook/heavy-command' || url.username || url.password || url.search || url.hash || !url.port) process.exit(78);
const kind = process.argv[3] || 'typescript';
const pid = Number(process.argv[2]);
if (!['typescript', 'tests', 'build', 'install'].includes(kind) || !Number.isSafeInteger(pid) || pid <= 0 || !process.env.NEXUS_GATE_TOKEN) process.exit(78);
// Inner CLI sandboxes may permit only their authenticated loopback proxy.
// Preserve that route without granting a remote proxy the Main capability.
const inheritedProxy = process.env.http_proxy || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY;
let proxy;
if (inheritedProxy) {
  try {
    proxy = new URL(inheritedProxy);
    if (inheritedProxy.length > 2048 || proxy.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname) || !proxy.port ||
        proxy.pathname !== '/' || proxy.search || proxy.hash ||
        /[\x00-\x20\x7f]/.test(decodeURIComponent(proxy.username + proxy.password))) process.exit(78);
    // Keep the SDK's localhost proxy on a literal loopback address. Its
    // credential and Main bearer must not depend on a mutable DNS/hosts name.
    if (proxy.hostname === 'localhost') proxy.hostname = '127.0.0.1';
  } catch { process.exit(78); }
}
function accepted(status, raw) {
  const result = JSON.parse(raw);
  if (status !== 200 || result.allow !== true || typeof result.leaseId !== 'string' || !result.leaseId || result.leaseId.length > 128) process.exit(78);
  process.stdout.write(result.leaseId);
}
const body = JSON.stringify({ pid, kind, ...(process.argv[4] === 'darwin-job' ? { proof: 'darwin-job' } : {}), ...(process.env.NEXUS_HEAVY_LEASE ? { leaseId: process.env.NEXUS_HEAVY_LEASE } : {}) });
// ps birth identity is second-granularity: do not claim a same-second PID.
setTimeout(() => {
  if (process.env.NEXUS_HEAVY_CHANNEL_DIR) {
    try {
      const crypto = require('node:crypto'), fs = require('node:fs'), directory = process.env.NEXUS_HEAVY_CHANNEL_DIR;
      if (!require('node:path').isAbsolute(directory) || fs.realpathSync(directory) !== directory || !fs.statSync(directory).isDirectory() ||
          !/^[a-f0-9]{64}$/.test(process.env.NEXUS_HEAVY_CHANNEL_KEY || '') || !process.env.NEXUS_HEAVY_CHANNEL_EPOCH) process.exit(78);
      const id = crypto.randomUUID(), issuedAt = Date.now(), payload = JSON.parse(body);
      const input = JSON.stringify([id, issuedAt, payload]);
      const packet = JSON.stringify({ id, issuedAt, body: payload, mac: crypto.createHmac('sha256', Buffer.from(process.env.NEXUS_HEAVY_CHANNEL_KEY, 'hex')).update(input).digest('hex') });
      const config = ['url = ' + JSON.stringify(url.href), 'request = "POST"', 'header = "Content-Type: application/json"', 'data = ' + JSON.stringify(packet), 'noproxy = "*"'].join('\n') + '\n';
      const raw = require('node:child_process').execFileSync('/usr/bin/curl', ['--disable', '--config', '-', '--silent', '--show-error', '--unix-socket', 'heavy.sock', '--proto', '=http', '--max-time', '360', '--connect-timeout', '5'],
        { cwd: directory, env: {}, input: config, encoding: 'utf8', timeout: 365000, maxBuffer: 2048, stdio: ['pipe', 'pipe', 'pipe'] });
      const reply = JSON.parse(raw), hash = crypto.createHash('sha256').update(input).digest('hex');
      const key = crypto.createPublicKey({ key: Buffer.from(process.env.NEXUS_HEAVY_CHANNEL_PUBLIC_KEY || '', 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519' || reply.schema !== 'nexus.native-heavy-reply/v1' || reply.epoch !== process.env.NEXUS_HEAVY_CHANNEL_EPOCH || reply.id !== id || reply.hash !== hash ||
          typeof reply.signature !== 'string' || !crypto.verify(null, Buffer.from(JSON.stringify([reply.schema, reply.epoch, reply.id, reply.hash, reply.result])), key, Buffer.from(reply.signature, 'base64'))) process.exit(78);
      accepted(200, JSON.stringify(reply.result));
    } catch { process.exit(78); }
    return;
  }
  if (process.platform === 'darwin' && process.env.NEXUS_HEAVY_CURL === '/usr/bin/curl') {
    // Credentials and the proxy's existing authentication travel only on
    // stdin. An inner proxy remains the policy authority even when its
    // NO_PROXY lists Main loopback. Failure never retries a direct connection.
    try {
      const config = ['url = ' + JSON.stringify(url.href), 'request = "POST"',
        'header = ' + JSON.stringify('Authorization: Bearer ' + process.env.NEXUS_GATE_TOKEN),
        'header = "Content-Type: application/json"', 'data = ' + JSON.stringify(body),
        ...(proxy ? ['proxy = ' + JSON.stringify(proxy.href), 'noproxy = ""'] : ['noproxy = "*"'])].join('\n') + '\n';
      const output = require('node:child_process').execFileSync('/usr/bin/curl',
        ['--disable', '--config', '-', '--silent', '--show-error', '--proto', '=http',
          '--max-time', '360', '--connect-timeout', '5', '--write-out', '\n%{http_code}'],
        { env: {}, input: config, encoding: 'utf8', timeout: 365_000, maxBuffer: 2048, stdio: ['pipe', 'pipe', 'pipe'] });
      const boundary = output.lastIndexOf('\n');
      accepted(Number(output.slice(boundary + 1)), output.slice(0, boundary));
    } catch { process.exit(78); }
    return;
  }
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + process.env.NEXUS_GATE_TOKEN }, timeout: 360_000 }, (res) => {
    let text = '';
    res.on('data', (part) => { text += part; if (text.length > 2048) req.destroy(); });
    res.on('end', () => { try { accepted(res.statusCode, text); } catch { process.exit(78); } });
  });
  req.on('timeout', () => req.destroy()); req.on('error', () => process.exit(78)); req.end(body);
}, 1100);
