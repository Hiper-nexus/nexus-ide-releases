const http = require('node:http');
// F-1434: every refusal names its cause here; the caller's last line only says
// the command did not start. Never the token, the body or a remote address.
const fail = (reason) => { process.stderr.write('nexus-heavy: ' + reason + '\n'); process.exit(78); };
let url;
try { url = new URL(process.env.NEXUS_HEAVY_COMMAND_URL); } catch { fail('this session has no Nexus admission address'); }
// Check before constructing a request: bearer capability never leaves loopback.
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/hook/heavy-command' || url.username || url.password || url.search || url.hash || !url.port) fail('the admission address is not the local Nexus endpoint');
const kind = process.argv[3] || 'typescript';
const pid = Number(process.argv[2]);
if (!['typescript', 'tests', 'build', 'install'].includes(kind) || !Number.isSafeInteger(pid) || pid <= 0 || !process.env.NEXUS_GATE_TOKEN) {
  fail(`invalid admission request (pid ${JSON.stringify(String(process.argv[2] ?? '').slice(0, 32))}, kind ${JSON.stringify(String(kind).slice(0, 32))}${process.env.NEXUS_GATE_TOKEN ? '' : ', no session token'})`);
}
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
        /[\x00-\x20\x7f]/.test(decodeURIComponent(proxy.username + proxy.password))) fail('the inherited HTTP proxy is not a local loopback proxy');
    // Keep the SDK's localhost proxy on a literal loopback address. Its
    // credential and Main bearer must not depend on a mutable DNS/hosts name.
    if (proxy.hostname === 'localhost') proxy.hostname = '127.0.0.1';
  } catch { fail('the inherited HTTP proxy is not a local loopback proxy'); }
}
function accepted(status, raw) {
  let result;
  try { result = JSON.parse(raw); } catch { fail(`Nexus admission sent an unreadable reply (HTTP ${status})`); }
  if (status !== 200 || result.allow !== true || typeof result.leaseId !== 'string' || !result.leaseId || result.leaseId.length > 128) {
    // F-1229: Main's reason (queue wait, root, jobs there) instead of a bare exit.
    if (status === 200 && typeof result.message === 'string') { process.stderr.write(result.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 600) + '\n'); process.exit(78); }
    if (status !== 200) fail(`Nexus admission answered HTTP ${status}`);
    fail(`Nexus refused the command (${typeof result.reason === 'string' && result.reason ? result.reason.replace(/[^\w.-]/g, '').slice(0, 80) : 'no reason given'})`);
  }
  process.stdout.write(result.leaseId);
}
// F-1229: Main queues one job per real git root of the work. The job runs in
// this process's cwd; a wrapped `cd <dir> && …` line names its dir through
// job-launch (the admission precedes that cd). Main accepts only this repo's roots.
let cwd = (process.argv[4] === 'darwin-job' && process.env.NEXUS_HEAVY_CWD) || '';
if (!cwd) { try { cwd = process.cwd(); } catch {} }
// Every transport carries ≤2048 bytes; an unusual path just keeps the token's lane.
if (!require('node:path').isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd) || Buffer.byteLength(JSON.stringify(cwd)) > 1024) cwd = '';
const body = JSON.stringify({ pid, kind, ...(process.argv[4] === 'darwin-job' ? { proof: 'darwin-job' } : {}), ...(process.env.NEXUS_HEAVY_LEASE ? { leaseId: process.env.NEXUS_HEAVY_LEASE } : cwd ? { cwd } : {}) });
// ps birth identity is second-granularity: do not claim a same-second PID.
setTimeout(async () => {
  if (process.env.NEXUS_HEAVY_CHANNEL_DIR) {
    try {
      const crypto = require('node:crypto'), fs = require('node:fs'), directory = process.env.NEXUS_HEAVY_CHANNEL_DIR;
      if (!require('node:path').isAbsolute(directory) || fs.realpathSync(directory) !== directory || !fs.statSync(directory).isDirectory() ||
          !/^[a-f0-9]{64}$/.test(process.env.NEXUS_HEAVY_CHANNEL_KEY || '') || !process.env.NEXUS_HEAVY_CHANNEL_EPOCH) fail('the Nexus admission channel is not configured for this session');
      const id = crypto.randomUUID(), issuedAt = Date.now(), payload = JSON.parse(body);
      const input = JSON.stringify([id, issuedAt, payload]);
      const packet = JSON.stringify({ id, issuedAt, body: payload, mac: crypto.createHmac('sha256', Buffer.from(process.env.NEXUS_HEAVY_CHANNEL_KEY, 'hex')).update(input).digest('hex') });
      const key = crypto.createPublicKey({ key: Buffer.from(process.env.NEXUS_HEAVY_CHANNEL_PUBLIC_KEY || '', 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') fail('the Nexus admission channel key is invalid');
      const io = require('./file-channel-io.cjs'), manifestFile = require('node:path').join(directory, 'transport.json');
      const manifestFd = io.open(manifestFile, fs.constants.O_RDONLY);
      let manifest; try { manifest = JSON.parse(io.read(manifestFd.fd, manifestFile)); } finally { fs.closeSync(manifestFd.fd); }
      if (manifest.schema !== 'nexus.native-heavy-transport/v1' || manifest.epoch !== process.env.NEXUS_HEAVY_CHANNEL_EPOCH || manifest.directory !== directory || !['unix', 'file'].includes(manifest.transport) || manifest.slots !== 16 ||
          typeof manifest.signature !== 'string' || !crypto.verify(null, Buffer.from(JSON.stringify([manifest.schema, manifest.epoch, manifest.directory, manifest.transport, manifest.slots])), key, Buffer.from(manifest.signature, 'base64'))) fail('the Nexus admission channel failed its integrity check');
      let raw;
      if (manifest.transport === 'file') raw = await require('./file-channel-client.cjs')(directory, JSON.parse(packet));
      else {
        const config = ['url = ' + JSON.stringify(url.href), 'request = "POST"', 'header = "Content-Type: application/json"', 'data = ' + JSON.stringify(packet), 'noproxy = "*"'].join('\n') + '\n';
        raw = require('node:child_process').execFileSync('/usr/bin/curl', ['--disable', '--config', '-', '--silent', '--show-error', '--unix-socket', 'heavy.sock', '--proto', '=http', '--max-time', '360', '--connect-timeout', '5'],
          { cwd: directory, env: {}, input: config, encoding: 'utf8', timeout: 365000, maxBuffer: 2048, stdio: ['pipe', 'pipe', 'pipe'] });
      }
      const reply = JSON.parse(raw), hash = crypto.createHash('sha256').update(input).digest('hex');
      if (key.asymmetricKeyType !== 'ed25519' || reply.schema !== 'nexus.native-heavy-reply/v1' || reply.epoch !== process.env.NEXUS_HEAVY_CHANNEL_EPOCH || reply.id !== id || reply.hash !== hash ||
          typeof reply.signature !== 'string' || !crypto.verify(null, Buffer.from(JSON.stringify([reply.schema, reply.epoch, reply.id, reply.hash, reply.result])), key, Buffer.from(reply.signature, 'base64'))) fail('the Nexus admission reply failed its integrity check');
      accepted(200, JSON.stringify(reply.result));
    } catch (error) { fail(`Nexus admission did not answer on its channel (${error?.code || 'channel failed'})`); }
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
    } catch (error) { fail(`Nexus admission did not answer (curl exit ${typeof error?.status === 'number' ? error.status : error?.code || 'unknown'})`); }
    return;
  }
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + process.env.NEXUS_GATE_TOKEN }, timeout: 360_000 }, (res) => {
    let text = '';
    res.on('data', (part) => { text += part; if (text.length > 2048) req.destroy(Object.assign(new Error('oversized'), { code: 'reply over 2 KB' })); });
    res.on('end', () => accepted(res.statusCode, text));
  });
  req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'no answer in 360 s' })));
  req.on('error', (error) => fail(`Nexus admission did not answer (${error?.code || 'connection failed'})`)); req.end(body);
}, 1100);
