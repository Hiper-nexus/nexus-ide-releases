/**
 * Prova física P3 — AGY advisory dentro do Seatbelt.
 *
 * Dirige os módulos REAIS (agy-native-mcp-lease + process-sandbox) para
 * spawnar o AGY 1.1.8 nativo sob `sandbox-exec` com o perfil advisory
 * (native processHome + private runtime + provider-state grants + workspace
 * read-only). Um servidor MCP de prova registra initialize/tools/list/call.
 *
 * Critérios verificados (handoff P3):
 *   1. HOME/Keychain nativo autenticado (resposta real do modelo)
 *   2. config MCP temporária presente no perfil real
 *   3. workspace fisicamente read-only (touch nega EPERM)
 *   4. runtime privado gravável (touch em $TMPDIR ok)
 *   5. prompt real respondido
 *   6. MCP alcançável + tools/list recebido (wiring nexus_*)
 *   7. tools/call (se o modelo decidir chamar — reportado)
 *   8. config restaurada byte a byte após release
 *   9. restore também funciona via recovery (crash path)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  acquireAgyNativeMcpLease,
  releaseAgyNativeMcpLease,
  recoverStaleAgyNativeLeases,
} from '../../src/main/orch/agy-native-mcp-lease.ts';
import { buildScopedExecPlan } from '../../src/main/runtime/process-sandbox.ts';

const AGY_BIN = process.env.AGY_BIN ?? '/Users/cleofasrocha/.local/bin/agy';
const MODEL = process.env.AGY_MODEL ?? 'gemini-3.6-flash-low';
const PROMPT =
  'You are an advisory agent under test. Reply with exactly AGY_SEATBELT_OK and nothing else. ' +
  'If an MCP tool named nexus_handoff_submit is available, list the nexus tools you can see, but do NOT call any tool.';

const results = [];
const check = (id, label, ok, evidence = '') => {
  results.push({ id, label, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${evidence ? ` — ${evidence}` : ''}`);
};

function runPlan(plan, input = {}) {
  return new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...input,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, signal: 'SIGKILL', stdout, stderr, timedOut: true });
    }, input.timeoutMs ?? 120000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: false });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: stderr + String(err), timedOut: false });
    });
  });
}

// ---------------------------------------------------------------------------
// Minimal streamable-HTTP MCP server that records every JSON-RPC method.
// ---------------------------------------------------------------------------
const seen = { initialize: 0, 'tools/list': 0, 'tools/call': 0, other: [] };
const mcpServer = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const method = msg.method ?? 'unknown';
    if (method in seen) seen[method]++;
    else if (!method.startsWith('notifications/')) seen.other.push(method);

    const isNotif = msg.id === undefined || msg.id === null;
    const reply = (result) => ({
      jsonrpc: '2.0',
      id: msg.id,
      result,
    });
    let payload = null;
    if (method === 'initialize') {
      payload = reply({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agy-seatbelt-proof', version: '0.0.1' },
      });
    } else if (method === 'ping') {
      payload = reply({});
    } else if (method === 'tools/list') {
      payload = reply({
        tools: [
          {
            name: 'nexus_handoff_submit',
            description: 'Submit an advisory handoff receipt',
            inputSchema: {
              type: 'object',
              properties: { summary: { type: 'string' } },
              required: ['summary'],
            },
          },
          {
            name: 'nexus_pane_read',
            description: 'Read a pane buffer',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
    } else if (method === 'tools/call') {
      payload = reply({ content: [{ type: 'text', text: 'ok' }] });
    }
    if (isNotif && !payload) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload ?? { jsonrpc: '2.0', id: msg.id, result: {} }));
  });
});

await new Promise((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
const mcpPort = mcpServer.address().port;
const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
console.log(`[proof] test MCP server on ${mcpUrl}`);

// ---------------------------------------------------------------------------
// Temp workspace (read-only root) + marker file.
// ---------------------------------------------------------------------------
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-proof-ws-'));
fs.writeFileSync(path.join(workspace, 'README.md'), '# proof workspace\n');
const forbiddenTarget = path.join(workspace, 'forbidden.txt');

// Ensure no stale lease from a prior crashed run blocks us.
recoverStaleAgyNativeLeases();

const cliConfig = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp_config.json');
const backupBefore = fs.existsSync(cliConfig) ? fs.readFileSync(cliConfig) : null;

let lease = null;
let agyExit = null;
try {
  // 1) Acquire the native lease (injects nexus into the REAL profile config).
  lease = acquireAgyNativeMcpLease(mcpUrl, `proof-${Date.now()}`, {});
  console.log(`[proof] lease acquired: runtimeDir=${lease.runtimeDir}`);
  console.log(`[proof] leased configs: ${lease.configPaths.join(', ')}`);

  // C2 — config MCP present in the real profile.
  const injected = JSON.parse(fs.readFileSync(cliConfig, 'utf8'));
  const hasNexus = Boolean(injected?.mcpServers?.nexus);
  check('C2', 'config MCP temporária injetada no perfil real', hasNexus,
    hasNexus ? 'mcpServers.nexus presente' : 'nexus AUSENTE');

  // Build the real Seatbelt plan with native-profile decoration.
  const realHome = os.homedir();
  const plan = buildScopedExecPlan({
    platform: 'darwin',
    executable: AGY_BIN,
    args: ['--print', PROMPT, '--model', MODEL],
    cwd: workspace,
    rootRealPath: workspace,
    sandboxDir: lease.runtimeDir,
    privateHome: lease.runtimeDir,
    processHome: realHome,
    env: {
      ...process.env,
      PATH: process.env.PATH,
      NEXUS_MCP_URL: mcpUrl,
    },
    readOnlyRoot: true,
    sandboxProfile: 'workspace-net',
    extraReadPaths: [lease.geminiDir],
    extraWritePaths: [lease.geminiDir],
  });
  console.log(`[proof] HOME=${plan.env.HOME}`);
  console.log(`[proof] TMPDIR=${plan.env.TMPDIR}`);
  check('C0', 'HOME do processo é o HOME nativo (não o runtime)',
    plan.env.HOME === realHome, plan.env.HOME);

  // C3/C4 — mechanical RO/RW probes under the SAME sandbox profile.
  const roProbe = buildScopedExecPlan({
    platform: 'darwin',
    executable: '/bin/sh',
    args: ['-c', `touch ${JSON.stringify(forbiddenTarget)}`],
    cwd: workspace,
    rootRealPath: workspace,
    sandboxDir: lease.runtimeDir,
    privateHome: lease.runtimeDir,
    processHome: realHome,
    env: { PATH: process.env.PATH },
    readOnlyRoot: true,
    sandboxProfile: 'workspace-net',
    extraReadPaths: [lease.geminiDir],
    extraWritePaths: [lease.geminiDir],
  });
  const roResult = await runPlan(roProbe, { timeoutMs: 15000 });
  check('C3', 'workspace fisicamente read-only (touch negado pelo kernel)',
    roResult.code !== 0 && !fs.existsSync(forbiddenTarget),
    `exit=${roResult.code} arquivo=${fs.existsSync(forbiddenTarget)}`);

  const rwProbe = buildScopedExecPlan({
    platform: 'darwin',
    executable: '/bin/sh',
    args: ['-c', `touch "$TMPDIR/writable-ok.txt" && echo WROTE`],
    cwd: workspace,
    rootRealPath: workspace,
    sandboxDir: lease.runtimeDir,
    privateHome: lease.runtimeDir,
    processHome: realHome,
    env: { PATH: process.env.PATH },
    readOnlyRoot: true,
    sandboxProfile: 'workspace-net',
    extraReadPaths: [lease.geminiDir],
    extraWritePaths: [lease.geminiDir],
  });
  const rwResult = await runPlan(rwProbe, { timeoutMs: 15000 });
  check('C4', 'runtime privado gravável (touch em $TMPDIR ok)',
    rwResult.code === 0 && rwResult.stdout.includes('WROTE'),
    `exit=${rwResult.code} out=${rwResult.stdout.trim()}`);

  // C1/C5 — real AGY spawn under Seatbelt: auth + real prompt response.
  console.log('[proof] spawning AGY under Seatbelt (this may take a while)…');
  const t0 = Date.now();
  agyExit = await runPlan(plan, { timeoutMs: 180000 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[proof] AGY exited code=${agyExit.code} signal=${agyExit.signal} in ${elapsed}s`);
  if (agyExit.stdout) console.log(`[proof] stdout (tail): ${agyExit.stdout.slice(-800)}`);
  if (agyExit.stderr) console.log(`[proof] stderr (tail): ${agyExit.stderr.slice(-800)}`);

  const responded = agyExit.stdout.includes('AGY_SEATBELT_OK');
  check('C1', 'HOME/Keychain nativo autenticado (modelo respondeu)', responded,
    responded ? 'modelo respondeu' : `code=${agyExit.code}`);
  check('C5', 'prompt real respondido', responded);

  // C6/C7 — MCP wiring: did AGY connect and list tools?
  check('C6', 'MCP nexus alcançável + tools/list recebido',
    seen['tools/list'] > 0, `tools/list=${seen['tools/list']} initialize=${seen.initialize}`);
  check('C7', 'tools/call (handoff) chamado pelo modelo',
    seen['tools/call'] > 0, `tools/call=${seen['tools/call']}`);
} finally {
  // C8 — release restores the real config byte-for-byte.
  if (lease) {
    releaseAgyNativeMcpLease(lease.token, {});
    const after = fs.existsSync(cliConfig) ? fs.readFileSync(cliConfig) : null;
    const restored =
      backupBefore === null ? after === null : (after && after.equals(backupBefore));
    const injectedGone = !JSON.parse(fs.readFileSync(cliConfig, 'utf8'))?.mcpServers?.nexus;
    check('C8', 'config restaurada byte a byte após release', Boolean(restored) && injectedGone,
      `nexus removido=${injectedGone} bytes iguais=${Boolean(restored)}`);
  }
  mcpServer.close();
}

// C9 — crash path: inject, do NOT release, then recover restores.
{
  const lease2 = acquireAgyNativeMcpLease(mcpUrl, `proof-crash-${Date.now()}`, {});
  const injectedNow = JSON.parse(fs.readFileSync(cliConfig, 'utf8'));
  const injectedOk = Boolean(injectedNow?.mcpServers?.nexus);
  // Forge the journal/lock pid to a dead process so recovery claims it.
  const artifactRoot = path.join(os.homedir(), '.nexus', 'ephemeral', 'agy-native');
  for (const entry of fs.readdirSync(artifactRoot)) {
    const jp = path.join(artifactRoot, entry, 'journal.json');
    if (fs.existsSync(jp)) {
      const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
      j.pid = 999999999;
      fs.writeFileSync(jp, JSON.stringify(j));
    }
  }
  const lockPath = path.join(artifactRoot, 'profile.lock');
  if (fs.existsSync(lockPath)) {
    const l = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    l.pid = 999999999;
    fs.writeFileSync(lockPath, JSON.stringify(l));
  }
  const rec = recoverStaleAgyNativeLeases();
  const after = fs.readFileSync(cliConfig);
  const restored = backupBefore ? after.equals(backupBefore) : !after;
  check('C9', 'recovery restaura config após crash', injectedOk && Boolean(restored) && rec.recovered >= 1,
    `recovered=${rec.recovered} bytes iguais=${Boolean(restored)}`);
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log('\n================ RESULTADO ================');
console.log(`${results.length - failed.length}/${results.length} critérios PASS`);
for (const r of results) {
  console.log(` ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}`);
}
if (failed.length) {
  console.log(`\n${failed.length} critério(s) FALHARAM.`);
  process.exitCode = 1;
} else {
  console.log('\nPROVA COMPLETA: AGY advisory sob Seatbelt PASSOU.');
}
