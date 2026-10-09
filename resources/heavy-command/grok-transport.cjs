// Exact Grok1.0.50 shell wire adapter. Payload/snapshot stay in inherited pipes;
// this is not execution authority: heavy work still enters native A+B/Main.
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const WRAPPER_SHA256 = 'f763a1e8f60c004cb652d66ac349f6412d796ab1a0838ae50a5fd554c76faf9d';
function supported(file, args) {
  return file === '/bin/bash' && args.length === 5 && args[0] === '-O' && args[1] === 'extglob' &&
    args[2] === '-c' && args[4] === '--' && Buffer.byteLength(args[3] || '', 'utf8') === 1477 &&
    crypto.createHash('sha256').update(args[3]).digest('hex') === WRAPPER_SHA256;
}
function transportFd(fd) {
  const value = fs.fstatSync(fd);
  if (!value.isFIFO() && !value.isSocket()) throw new Error('unsupported transport');
}
function readFrame(fd, signal) {
  transportFd(fd);
  return new Promise((resolve, reject) => {
    const stream = new net.Socket({ fd, readable: true, writable: false });
    let size = 0, nul = false, settled = false;
    const parts = [];
    const finish = (error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      stream.destroy();
      if (error) reject(error); else resolve(Buffer.concat(parts, size));
    };
    const abort = () => finish(new Error('transport cancelled'));
    const timer = setTimeout(() => finish(new Error('transport deadline')), 5000);
    signal.addEventListener('abort', abort, { once: true });
    stream.on('error', () => finish(new Error('transport unavailable')));
    stream.on('data', data => {
      const boundary = data.indexOf(0);
      if (nul || boundary >= 0 && boundary !== data.length - 1) { finish(new Error('trailing frame')); return; }
      const body = boundary < 0 ? data : data.subarray(0, boundary);
      size += body.length;
      if (size > 131072) { finish(new Error('transport bound')); return; }
      parts.push(body); if (boundary >= 0) nul = true;
    });
    stream.on('end', () => finish(nul ? null : new Error('missing frame')));
    if (signal.aborted) abort();
  });
}
// Keep the relay alive until its real owned chain closes; no timeout means exit.
function signalRelay() {
  const controller = new AbortController();
  let child = null, received = null;
  const handlers = new Map();
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    const handler = () => {
      received ??= signal; controller.abort();
      if (child) { try { child.kill(signal); } catch {} }
    };
    handlers.set(signal, handler); process.on(signal, handler);
  }
  return { signal: controller.signal,
    bind(value) { child = value; if (received) { try { child.kill(received); } catch {} } },
    finish(code, signal) {
      for (const [name, handler] of handlers) process.removeListener(name, handler);
      const finalSignal = received || signal;
      if (finalSignal) { try { process.kill(process.pid, finalSignal); } catch { process.exit(1); } }
      else process.exit(code ?? 1);
    },
  };
}
function originalOptions(env) {
  if (env.NEXUS_HEAVY_GROK_OPTIONS_SET === 'x') env.NODE_OPTIONS = env.NEXUS_HEAVY_GROK_OPTIONS || '';
  else delete env.NODE_OPTIONS;
  delete env.NEXUS_HEAVY_GROK_OPTIONS; delete env.NEXUS_HEAVY_GROK_OPTIONS_SET;
}
async function main() {
  const relay = signalRelay();
  try {
    // Bash already verified the ORIGINAL descriptors before Node can reuse5.
    if (process.env.NEXUS_HEAVY_GROK_CHANNELS !== '3,5') throw new Error('missing transport');
    const wrapper = process.env.NEXUS_HEAVY_GROK_WRAPPER || '';
    const args = ['-O', 'extglob', '-c', wrapper, '--'];
    if (!supported('/bin/bash', args)) throw new Error('unknown wrapper');
    transportFd(3);
    // read() short-circuits zero length in Node. A nonempty readv vector
    // reaches the kernel with zero bytes: access is checked, data untouched.
    for (const fd of [3, 5]) {
      await new Promise((resolve, reject) => fs.readv(fd, [Buffer.alloc(0)], null, error => error ? reject(error) : resolve()));
    }
    const input = await readFrame(5, relay.signal);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    if (relay.signal.aborted) throw new Error('transport cancelled');
    const kind = require('./catalog.cjs').commandKind(text);
    const env = { ...process.env, NEXUS_HEAVY_GROK_REPLAY: '1' };
    delete env.NEXUS_HEAVY_GROK_WRAPPER; delete env.NEXUS_HEAVY_HELPER;
    let file = '/bin/bash', launchArgs = args;
    if (kind) {
      env.NEXUS_HEAVY_HELPER = '1'; env.NEXUS_HEAVY_INHERITED_FD3 = '1';
      file = process.execPath; launchArgs = [path.join(__dirname, 'job-launch.cjs'), kind, '/bin/bash', ...args];
    } else { originalOptions(env); delete env.NEXUS_HEAVY_GROK_CHANNELS; }
    const child = cp.spawn(file, launchArgs, { env, stdio: ['inherit', 'inherit', 'inherit', 3, 'ignore', 'pipe'] });
    relay.bind(child);
    let failed = false;
    child.once('error', () => { failed = true; });
    child.stdio[5].once('error', () => { failed = true; try { child.kill('SIGTERM'); } catch {} });
    child.stdio[5].end(Buffer.concat([input, Buffer.from([0])]));
    child.once('close', (code, signal) => relay.finish(failed ? 78 : code, signal));
  } catch { relay.finish(78, null); }
}
if (require.main === module) void main();
module.exports = { supported, readFrame, signalRelay, originalOptions };
