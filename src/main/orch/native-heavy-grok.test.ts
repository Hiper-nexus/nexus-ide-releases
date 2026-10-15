import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { expect, it, onTestFinished } from 'vitest';
import { NativeHeavyCommands } from './native-heavy-command';
import { selectGrokHeavyShell } from './native-heavy-preload';
import { nestedHeavyJobBaseCommand, supervisedPtyCommand } from '../pty/darwin-pty-supervisor';
import { realpathOrSkip, skipUnderNexusPtySupervisor } from '../../test/nested-pty-supervisor';
import { watchDarwinHeavyCommand } from '../pty/darwin-heavy-command';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import type { AgentGateContext } from './gate';
const grok = process.env.NEXUS_TEST_GROK_BIN ?? (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'grok')).find((file) => fs.existsSync(file));
function streamMessage(res: http.ServerResponse, model: string, content: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }) {
 res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
 const event = (name: string, value: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
 event('message_start', { type: 'message_start', message: { id: 'msg_finite', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
 if (content.type === 'tool_use') {
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: content.id, name: content.name, input: {} } });
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
 } else {
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.text } });
 }
 event('content_block_stop', { type: 'content_block_stop', index: 0 });
 event('message_delta', { type: 'message_delta', delta: { stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
 event('message_stop', { type: 'message_stop' }); res.end();
}

it.runIf(process.platform === 'darwin' && Boolean(grok))('real Grok native Bash is admitted by inherited scoped shell env before absolute sh/make', async (testContext) => {
 skipUnderNexusPtySupervisor(testContext);
 const actualGrok = realpathOrSkip(testContext, grok!, 'grok'), binarySha256 = createHash('sha256').update(fs.readFileSync(actualGrok)).digest('hex');
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-real-grok-'));
 onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
 fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\t@printf done > command-ran\n\t@printf x >> command-count\n');
 fs.writeFileSync(path.join(root, '.bashrc'), `finite_snapshot() { printf x >> snapshot-count; printf preserved > ${JSON.stringify(path.join(root, 'snapshot-preserved'))}; }\n`);
 const helper = path.join(root, 'resources/native/darwin/nexus-pty-supervisor');
 execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/build-darwin-pty-supervisor.mjs'), '--output', helper], { stdio: 'ignore' });
 const runtime = { platform: 'darwin' as const, packaged: false, cwd: root, moduleDir: root };
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'claude-hook', checkoutId: 'finite', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-hook', sessionId: 'finite-hook-session', role: 'user', scope } as AgentGateContext;
 let cliPid = 0, cliAlive = true; const identity = {};
 const claims: Array<Awaited<ReturnType<typeof watchDarwinHeavyCommand>>> = [];
 const proof = new OwnedCommandProcesses((id) => id === ctx.sessionId && cliPid && cliAlive ? { pid: cliPid, identity } : null, undefined, async (pid) => {
  const claim = await watchDarwinHeavyCommand(runtime, pid); claims.push(claim); return claim;
 });
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const transitions: string[] = []; const admissions: unknown[] = []; const admissionResults: unknown[] = [];
 const admittedLeases: string[] = [];
 const native = new NativeHeavyCommands({ current: () => cliAlive, claim: (id, pid, proofKind) => proofKind === 'darwin-job' ? proof.claim(id, pid, proofKind) : Promise.resolve(null), probe: (id, claim) => proof.probe(id, claim), borrow: (id, claim, pid) => proof.borrow(id, claim, pid), stop: (id, claim) => proof.stop(id, claim),
   acquire: async (request) => { const permit = await pool.acquire(request); transitions.push('grant'); return { id: permit.id, release: () => { transitions.push('release'); permit.release(); } }; } });
 let modelCalls = 0; let toolSent = false; const shapes: unknown[] = []; const toolResults: unknown[] = [];
 const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (part) => { raw += part; if (raw.length > 4 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
   if (req.url === '/hook/heavy-command') {
    admissions.push(JSON.parse(raw));
    if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
    void native.admit(ctx, JSON.parse(raw)).then((result) => { admissionResults.push({ allow: result.allow, reason: result.reason, hasLease: Boolean(result.leaseId) }); if (result.allow && result.leaseId) admittedLeases.push(result.leaseId); res.end(JSON.stringify(result)); }); return;
   }
   if (req.url?.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
   if (req.url?.startsWith('/v1/messages')) {
    const request = JSON.parse(raw); modelCalls++; shapes.push({ keys: Object.keys(request), tools: (request.tools ?? []).map((tool: Record<string, unknown>) => ({ name: tool.name, type: tool.type, function: (tool.function as { name?: string } | undefined)?.name })) });
    for (const message of request.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
     if (block.type === 'tool_result' && block.tool_use_id === 'toolu_finite_make') toolResults.push({ is_error: block.is_error, content: JSON.stringify(block.content).slice(0, 8000) });
    }
    if (!toolSent && (request.tools ?? []).some((tool: { name?: string }) => tool.name === 'run_terminal_command')) { toolSent = true; streamMessage(res, request.model, { type: 'tool_use', id: 'toolu_finite_make', name: 'run_terminal_command', input: { command: 'finite_snapshot; NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"', description: 'finite fixture only', explanation: 'finite fixture only', is_background: false } }); }
    else streamMessage(res, request.model, { type: 'text', text: 'finite fixture done' }); return;
   }
   res.writeHead(404); res.end('{}');
  });
 });
 onTestFinished(async () => {
  pool.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address() as { port: number };
 fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), path.join(root, 'heavy-command'), { recursive: true });
 const resources = fs.realpathSync(path.join(root, 'heavy-command'));
 // Exercise the shipped scripts byte-for-byte. Runtime refusals already
 // report a bounded cause; the test records admission and process evidence.
 const grokHome = path.join(root, 'grok'); fs.mkdirSync(grokHome);
 fs.writeFileSync(path.join(grokHome, 'config.toml'), `[cli]\nuse_leader = false\n[models]\ndefault = "finite"\n[model.finite]\nmodel = "finite"\nbase_url = "http://127.0.0.1:${port}/v1"\napi_backend = "messages"\nenv_key = "NEXUS_FAKE_PROVIDER_KEY"\ncontext_window = 32768\n`);
 const env: NodeJS.ProcessEnv = { PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:${process.env.PATH ?? '/usr/bin:/bin'}`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: root, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(root, 'securestorage'),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'finite-test-credential', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl' };
 delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.NODE_OPTIONS;
 Object.assign(env, { GROK_HOME: grokHome, GROK_DISABLE_AUTOUPDATER: '1', NEXUS_FAKE_PROVIDER_KEY: 'finite-test-credential', NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'), BASH_ENV: path.join(resources, 'shell.bash'), ZDOTDIR: resources });
 // Exercise Main's shell-selection policy with Homebrew before system Bash.
 selectGrokHeavyShell(env, 'grok');
 const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:${port}"))(allow network-bind (local tcp "localhost:*"))(allow network-inbound (local tcp "localhost:*"))(allow network-bind (local unix (subpath ${JSON.stringify(fs.realpathSync(root))})))(allow network-inbound (local unix (subpath ${JSON.stringify(fs.realpathSync(root))})))(allow network-outbound (remote unix (subpath ${JSON.stringify(fs.realpathSync(root))})))`;
 const command = supervisedPtyCommand(runtime, '/usr/bin/sandbox-exec', ['-p', profile, actualGrok, '-p', 'finite fixture', '--always-approve', '--disable-web-search', '--model', 'finite', '--output-format', 'json']);
 const child = spawn(command.file, command.args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
 cliPid = child.pid!; let stderr = '', stdout = ''; child.stderr.on('data', (part) => stderr += part); child.stdout.on('data', (part) => stdout += part);
 const exit = new Promise<number | null>((resolve) => child.once('close', (code) => { cliAlive = false; resolve(code); }));
 let forcedTimeout = false;
 const timer = setTimeout(() => { forcedTimeout = true; child.kill('SIGTERM'); }, 25_000);
 try {
  const code = await exit;
  const admissionShapes = admissions.map((value) => { const request = value as { pid?: number; kind?: string; proof?: string; leaseId?: string }; return { pid: request.pid, kind: request.kind, proof: request.proof, hasLease: Boolean(request.leaseId) }; });
  const diagnostic = JSON.stringify({ shapes, toolResults, admissions: admissionShapes, admissionResults, transitions }) + (stderr + stdout).slice(0, 8000);
  expect(code, diagnostic).toBe(0); expect(forcedTimeout).toBe(false); expect(modelCalls, diagnostic).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(path.join(root, 'command-ran')), diagnostic).toBe(true);
  expect(fs.readFileSync(path.join(root, 'command-ran'), 'utf8')).toBe('done');
  expect(fs.readFileSync(path.join(root, 'snapshot-preserved'), 'utf8')).toBe('preserved');
  expect((admissions[0] as { proof?: string }).proof).toBe('darwin-job');
  expect(fs.readFileSync(path.join(root, 'command-count'), 'utf8')).toBe('x');
  expect(fs.readFileSync(path.join(root, 'snapshot-count'), 'utf8')).toBe('x');
  expect(admittedLeases.length).toBeGreaterThan(0);
  expect(new Set(admittedLeases).size).toBe(1);
  await native.drain(); expect(transitions).toEqual(['grant', 'release']); expect(stdout).toContain('finite fixture done');
  expect(claims.length).toBeGreaterThan(0); expect(claims.every(claim => claim?.state() === 'gone')).toBe(true);
  expect(createHash('sha256').update(fs.readFileSync(actualGrok)).digest('hex')).toBe(binarySha256);
  const proofDir = path.join(process.cwd(), '.superpowers/sdd/release-076213-reviewed/f1148-grok-proof');
  if (fs.existsSync(proofDir)) fs.writeFileSync(path.join(proofDir, 'native-managed-grok-facts.json'), JSON.stringify({ actualGrok, binarySha256,
   cliPid, privateProfile: root, selectedShell: env.GROK_SHELL, homebrewFirst: true, forcedTimeout, code,
   commandCount: 1, snapshotCount: 1, admittedLeaseCount: new Set(admittedLeases).size, transitions,
   physicalClaims: claims.map(claim => claim?.state() ?? 'unproved'), signedPackagedProof: false }, null, 2) + '\n', { mode: 0o600 });
 } finally {
  clearTimeout(timer); child.kill('SIGTERM'); await exit;
 }
}, 35_000);
