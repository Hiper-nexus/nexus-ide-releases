/**
 * Prova física P4 — Kimi advisory dentro do Seatbelt.
 *
 * Dirige os módulos REAIS (prepareKimiMcpSession + process-sandbox) para
 * spawnar o Kimi 0.29.2 nativo sob `sandbox-exec` no perfil advisory
 * (private runtime + KIMI_CODE_HOME overlay + provider-state grants +
 * workspace read-only). Um servidor MCP de prova registra
 * initialize/tools/list/call.
 *
 * Critérios (handoff P4):
 *   C1 auth file-backed reconhecida (resposta real do modelo)
 *   C2 overlay KIMI_CODE_HOME presente com mcp.json privado
 *   C3 workspace fisicamente read-only
 *   C4 runtime privado gravável
 *   C5 prompt real respondido
 *   C6 MCP nexus alcançável + tools/list
 *   C7 tools/call chamado pelo modelo
 *   C8 nenhuma credencial copiada para o workspace
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { prepareKimiMcpSession, cleanupCliMcpSession } from '../../src/main/orch/cli-mcp-session-config.ts';
import {
  buildScopedExecPlan,
  createScopedSandboxHome,
} from '../../src/main/runtime/process-sandbox.ts';

const KIMI_BIN = process.env.KIMI_BIN ?? '/Users/cleofasrocha/.kimi-code/bin/kimi';
const PROMPT =
  'You are an advisory agent under test. First call the MCP tool nexus_handoff_submit with summary="proof". ' +
  'Then reply with exactly KIMI_SEATBELT_OK and nothing else.';
// Kimi yolo (--auto) is incompatible with headless -p; the advisory lane must
// NOT append it. This proof runs headless -p, matching a mission worker.
const EXTRA_APPROVAL = (process.env.KIMI_EXTRA ?? '').split(' ').filter(Boolean);

const results = [];
const check = (id, label, ok, evidence = '') => {
  results.push({ id, label, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${evidence ? ` — ${evidence}` : ''}`);
};

function runPlan(plan, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut: false });
    });
  });
}

// Minimal MCP server recording every method.
const seen = { initialize: 0, 'tools/list': 0, 'tools/call': 0 };
const mcpServer = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/mcp')) return res.writeHead(404).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { return res.writeHead(400).end(); }
    const method = msg.method ?? '';
    if (method in seen) seen[method]++;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    let payload = null;
    if (method === 'initialize') payload = reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'kimi-proof', version: '0.0.1' } });
    else if (method === 'ping') payload = reply({});
    else if (method === 'tools/list') payload = reply({ tools: [
      { name: 'nexus_handoff_submit', description: 'Submit handoff', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
    ] });
    else if (method === 'tools/call') payload = reply({ content: [{ type: 'text', text: 'ok' }] });
    if ((msg.id === undefined || msg.id === null) && !payload) return res.writeHead(202).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload ?? reply({})));
  });
});
await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r));
const mcpUrl = `http://127.0.0.1:${mcpServer.address().port}/mcp`;
console.log(`[proof] test MCP server on ${mcpUrl}`);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kimi-proof-ws-'));
fs.writeFileSync(path.join(workspace, 'README.md'), '# proof\n');

const realHome = os.homedir();
const kimiProviderHome = path.join(realHome, '.kimi-code');
const token = `kimi-proof-${Date.now()}`;
let session = null;
try {
  // Real overlay: KIMI_CODE_HOME = ephemeral artifactDir with private mcp.json.
  session = prepareKimiMcpSession(mcpUrl, token, {});
  const kimiHome = session.env.KIMI_CODE_HOME;
  console.log(`[proof] KIMI_CODE_HOME=${kimiHome}`);

  const mcpJson = path.join(kimiHome, 'mcp.json');
  const hasMcp = fs.existsSync(mcpJson) &&
    JSON.stringify(JSON.parse(fs.readFileSync(mcpJson, 'utf8'))).includes('NEXUS_MCP_TOKEN');
  check('C2', 'overlay KIMI_CODE_HOME com mcp.json privado (bearer via env)', hasMcp);

  const runtime = createScopedSandboxHome({ projectId: token, checkoutId: 'advisory-kimi' });

  // Provider-state read grant: the overlay symlinks credentials INTO the
  // artifactDir pointing at ~/.kimi-code — Seatbelt resolves symlinks, so the
  // real provider home must be readable or auth silently fails.
  const keychainsDir = path.join(realHome, 'Library', 'Keychains');
  const readGrants = [kimiHome, kimiProviderHome];
  if (fs.existsSync(keychainsDir)) readGrants.push(keychainsDir);

  const args = ['--output-format', 'text', '-p', PROMPT, ...EXTRA_APPROVAL];
  const plan = buildScopedExecPlan({
    platform: 'darwin',
    executable: KIMI_BIN,
    args,
    cwd: workspace,
    rootRealPath: workspace,
    sandboxDir: runtime.dir,
    privateHome: runtime.dir,
    processHome: realHome,
    env: { ...process.env, PATH: process.env.PATH, KIMI_CODE_HOME: kimiHome, NEXUS_MCP_TOKEN: token, NEXUS_MCP_URL: mcpUrl },
    readOnlyRoot: true,
    sandboxProfile: 'workspace-net',
    extraReadPaths: readGrants,
    extraWritePaths: [kimiHome, kimiProviderHome],
  });
  console.log(`[proof] HOME=${plan.env.HOME} args=${JSON.stringify(args)}`);

  // C3/C4 mechanical probes under the same profile.
  const forbidden = path.join(workspace, 'forbidden.txt');
  const ro = await runPlan({ ...plan, args: plan.args.slice(0, plan.args.indexOf(KIMI_BIN)).concat(['/bin/sh', '-c', `touch ${JSON.stringify(forbidden)}`]) }, 15000);
  check('C3', 'workspace read-only (touch negado)', ro.code !== 0 && !fs.existsSync(forbidden), `exit=${ro.code}`);
  const rw = await runPlan({ ...plan, args: plan.args.slice(0, plan.args.indexOf(KIMI_BIN)).concat(['/bin/sh', '-c', 'touch "$TMPDIR/ok.txt" && echo WROTE']) }, 15000);
  check('C4', 'runtime privado gravável', rw.stdout.includes('WROTE'), `exit=${rw.code}`);

  // C1/C5 real Kimi spawn.
  console.log('[proof] spawning Kimi under Seatbelt…');
  const out = await runPlan(plan, 180000);
  console.log(`[proof] kimi exit=${out.code}`);
  if (out.stdout) console.log(`[proof] stdout (tail): ${out.stdout.slice(-600)}`);
  if (out.stderr) console.log(`[proof] stderr (tail): ${out.stderr.slice(-400)}`);
  const responded = out.stdout.includes('KIMI_SEATBELT_OK');
  check('C1', 'auth file-backed reconhecida (modelo respondeu)', responded, responded ? 'ok' : `exit=${out.code}`);
  check('C5', 'prompt real respondido', responded);
  check('C6', 'MCP nexus alcançável + tools/list', seen['tools/list'] > 0, `list=${seen['tools/list']} init=${seen.initialize}`);
  check('C7', 'tools/call (handoff) chamado', seen['tools/call'] > 0, `call=${seen['tools/call']}`);

  // C8 no credential copied into the workspace.
  const leaked = fs.readdirSync(workspace).some((f) => /cred|token|kimi-code\.json/i.test(f));
  check('C8', 'nenhuma credencial copiada para o workspace', !leaked);
} finally {
  if (session) cleanupCliMcpSession(token);
  mcpServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log('\n================ RESULTADO KIMI ================');
console.log(`${results.length - failed.length}/${results.length} critérios PASS`);
for (const r of results) console.log(` ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}`);
process.exitCode = failed.length ? 1 : 0;
