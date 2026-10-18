// Servidores de loopback: SAFE (o destino que o Nexus resolveu, HTTPS) e EVIL (o
// que um settings hostil quer que a chave alcance; HTTPS e HTTP puro). Cada
// requisição é gravada inteira (URL, cabeçalhos, corpo) para o runner procurar a
// chave fixture em qualquer lugar. O certificado é de teste, gerado em tmp com o
// `openssl` do sistema, e a CLI o confia por NODE_EXTRA_CA_CERTS.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-loopback-certs-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
], { stdio: 'ignore' });
process.on('exit', () => fs.rmSync(certDir, { recursive: true, force: true }));

const tls = {
  key: fs.readFileSync(path.join(certDir, 'key.pem')),
  cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
};
export const CA_FILE = path.join(certDir, 'cert.pem');

/** id do cenário -> { toolName, args }: o SAFE responde com uma chamada de ferramenta. */
export const scripts = new Map();

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
  res.end();
}

function scripted(req, res, body) {
  const script = scripts.get((req.url ?? '').split('/')[1]);
  if (!script || !(req.method === 'POST' && /chat\/completions/.test(req.url ?? ''))) return false;
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* corpo que não é JSON */ }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: parsed.model ?? 'fixture' };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (messages.some((m) => m.role === 'tool')) {
    sse(res, [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
      '[DONE]',
    ]);
  } else {
    const call = { index: 0, id: 'call_1', type: 'function', function: { name: script.toolName, arguments: JSON.stringify(script.args) } };
    sse(res, [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage },
      '[DONE]',
    ]);
  }
  return true;
}

function handler(label, hits) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ label, method: req.method, url: req.url, headers: req.headers, body });
      if (label === 'SAFE' && scripted(req, res, body)) return;
      if (req.method === 'POST' && /chat\/completions/.test(req.url ?? '')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API-key (fixture)', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

export async function startServers() {
  const safeHits = [];
  const evilHits = [];
  const safe = https.createServer(tls, handler('SAFE', safeHits));
  const evilTls = https.createServer(tls, handler('EVIL-TLS', evilHits));
  const evilHttp = http.createServer(handler('EVIL-HTTP', evilHits));
  const [safePort, evilTlsPort, evilHttpPort] = await Promise.all([listen(safe), listen(evilTls), listen(evilHttp)]);
  return {
    safe: { port: safePort, hits: safeHits },
    evil: { port: evilTlsPort, httpPort: evilHttpPort, hits: evilHits },
    close: () => Promise.all([safe, evilTls, evilHttp].map((server) => new Promise((resolve) => server.close(resolve)))),
  };
}
