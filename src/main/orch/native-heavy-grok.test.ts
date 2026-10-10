import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Script } from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { NativeHeavyCommands } from './native-heavy-command';
import { nestedHeavyJobBaseCommand, supervisedPtyCommand } from '../pty/darwin-pty-supervisor';
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

it.runIf(process.platform === 'darwin' && Boolean(grok))('real Grok native Bash is admitted by inherited scoped shell env before absolute sh/make', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-real-grok-'));
 fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\t@printf done > command-ran\n\t@printf x >> command-count\n');
 fs.writeFileSync(path.join(root, '.bashrc'), `finite_snapshot() { printf x >> snapshot-count; printf preserved > ${JSON.stringify(path.join(root, 'snapshot-preserved'))}; }\n`);
 const helper = path.join(root, 'resources/native/darwin/nexus-pty-supervisor');
 execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/build-darwin-pty-supervisor.mjs'), '--output', helper], { stdio: 'ignore' });
 const runtime = { platform: 'darwin' as const, packaged: false, cwd: root, moduleDir: root };
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'claude-hook', checkoutId: 'finite', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-hook', sessionId: 'finite-hook-session', role: 'user', scope } as AgentGateContext;
 let cliPid = 0, cliAlive = true; const identity = {};
 const proof = new OwnedCommandProcesses((id) => id === ctx.sessionId && cliPid && cliAlive ? { pid: cliPid, identity } : null, undefined, (pid) => watchDarwinHeavyCommand(runtime, pid));
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
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address() as { port: number };
 fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), path.join(root, 'heavy-command'), { recursive: true });
 const resources = fs.realpathSync(path.join(root, 'heavy-command'));
 // Temporary diagnostic in the private fixture copy: no operator paths,
 // command payload, environment values or capabilities are recorded.
 const replaceOnce = (contents: string, needle: string, replacement: string) => {
  expect(contents.split(needle), `diagnostic anchor: ${needle}`).toHaveLength(2);
  return contents.replace(needle, () => replacement);
 };
 for (const name of ['grok-transport.cjs', 'job-launch.cjs']) {
  const file = path.join(resources, name);
  let contents = fs.readFileSync(file, 'utf8');
  const logger = `function finiteDiagnostic(reason, error) { try { require('node:fs').appendFileSync(require('node:path').join(__dirname, 'diagnostic.jsonl'), JSON.stringify({ stage: ${JSON.stringify(name)}, reason, code: ['EAGAIN', 'EINVAL', 'EBADF', 'ENOENT', 'EACCES', 'ETIMEDOUT', 'EIO', 'ENOMEM', 'EPERM'].includes(error?.code) ? error.code : undefined }) + ${JSON.stringify('\n')}); } catch {} }\n`;
  contents = replaceOnce(contents, '} catch { relay.finish(78, null); }', `} catch (error) { finiteDiagnostic(['missing transport', 'unknown wrapper', 'unsupported transport', 'transport cancelled', 'transport deadline', 'trailing frame', 'transport bound', 'transport unavailable', 'missing frame', 'invalid job', 'unproved inherited lease', 'invalid channel', 'unknown transport', 'job cancelled'].includes(error?.message) ? error.message : 'unexpected-error', error); relay.finish(78, null); }`);
  const childName = name === 'grok-transport.cjs' ? 'child' : 'job';
  const failureCode = name === 'grok-transport.cjs' ? 78 : 127;
  contents = replaceOnce(contents, `${childName}.once('error', () => { failed = true; });`, `${childName}.once('error', () => { finiteDiagnostic('child-error'); failed = true; });`);
  contents = replaceOnce(contents, `${childName}.once('close', (code, signal) => relay.finish(failed ? ${failureCode} : code, signal));`, `${childName}.once('close', (code, signal) => { if (code === 78) finiteDiagnostic('child-exit-78'); relay.finish(failed ? ${failureCode} : code, signal); });`);
  if (name === 'grok-transport.cjs') {
   contents = replaceOnce(contents, "child.stdio[5].once('error', () => { failed = true; try { child.kill('SIGTERM'); } catch {} });", "child.stdio[5].once('error', () => { finiteDiagnostic('frame-write-error'); failed = true; try { child.kill('SIGTERM'); } catch {} });");
   contents = replaceOnce(contents, "'use strict';", "'use strict';\n" + logger);
  } else {
   contents = replaceOnce(contents, "validator.once('error', () => { failed = true; });", "validator.once('error', () => { finiteDiagnostic('validator-error'); failed = true; });");
   contents = logger + contents;
  }
  new Script(contents, { filename: name }); // Parse only; no run method is called.
  fs.writeFileSync(file, contents);
 }
 const requestFile = path.join(resources, 'request.cjs');
 let requestContents = fs.readFileSync(requestFile, 'utf8');
 const requestLogger = `function finiteRequestDiagnostic(reason, fields = {}) { try { require('node:fs').appendFileSync(require('node:path').join(__dirname, 'diagnostic.jsonl'), JSON.stringify({ stage: 'request.cjs', reason, nested: Boolean(process.env.NEXUS_HEAVY_LEASE), ...fields }) + ${JSON.stringify('\n')}); } catch {} }\n`;
 requestContents = replaceOnce(requestContents, "try { url = new URL(process.env.NEXUS_HEAVY_COMMAND_URL); } catch { process.exit(78); }", "try { url = new URL(process.env.NEXUS_HEAVY_COMMAND_URL); } catch { finiteRequestDiagnostic('url-parse-refused'); process.exit(78); }");
 requestContents = replaceOnce(requestContents, '!url.port) process.exit(78);', "!url.port) { finiteRequestDiagnostic('url-shape-refused'); process.exit(78); }");
 requestContents = replaceOnce(requestContents, '!process.env.NEXUS_GATE_TOKEN) process.exit(78);', "!process.env.NEXUS_GATE_TOKEN) { finiteRequestDiagnostic('request-fields-refused', { kindValid: ['typescript', 'tests', 'build', 'install'].includes(kind), pidValid: Number.isSafeInteger(pid) && pid > 0, hasToken: Boolean(process.env.NEXUS_GATE_TOKEN) }); process.exit(78); }");
 requestContents = replaceOnce(requestContents, '.test(decodeURIComponent(proxy.username + proxy.password))) process.exit(78);', ".test(decodeURIComponent(proxy.username + proxy.password))) { finiteRequestDiagnostic('proxy-shape-refused'); process.exit(78); }");
 requestContents = replaceOnce(requestContents, "if (proxy.hostname === 'localhost') proxy.hostname = '127.0.0.1';\n  } catch { process.exit(78); }", "if (proxy.hostname === 'localhost') proxy.hostname = '127.0.0.1';\n  } catch { finiteRequestDiagnostic('proxy-parse-refused'); process.exit(78); }");
 requestContents = replaceOnce(requestContents, 'const result = JSON.parse(raw);', "const result = JSON.parse(raw); finiteRequestDiagnostic('response', { status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined, allow: result.allow === true, hasLease: typeof result.leaseId === 'string' && result.leaseId.length > 0 && result.leaseId.length <= 128 });");
 requestContents = replaceOnce(requestContents, "accepted(Number(output.slice(boundary + 1)), output.slice(0, boundary));\n    } catch { process.exit(78); }", "accepted(Number(output.slice(boundary + 1)), output.slice(0, boundary));\n    } catch (error) { finiteRequestDiagnostic('curl-failed', { status: Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255 ? error.status : undefined, code: ['EAGAIN', 'EINVAL', 'EBADF', 'ENOENT', 'EACCES', 'ETIMEDOUT', 'EIO', 'ENOMEM', 'EPERM'].includes(error?.code) ? error.code : undefined }); process.exit(78); }");
 requestContents = requestLogger + "finiteRequestDiagnostic('request-start');\n" + requestContents;
 new Script(requestContents, { filename: 'request.cjs' }); // Parse only.
 fs.writeFileSync(requestFile, requestContents);
 const bashFile = path.join(resources, 'shell.bash');
 const shellTrace = (reason: string) => `printf ${JSON.stringify('%s\n')} '${JSON.stringify({ stage: 'shell.bash', reason })}' 2>/dev/null >> "$NEXUS_HEAVY_DIR/diagnostic.jsonl" || :;`;
 let bashContents = fs.readFileSync(bashFile, 'utf8');
 for (const [needle, reason] of [
  ['builtin shopt -q extglob || exit 78', 'extglob'],
  ['! -e /dev/fd/4 ]] || exit 78', 'descriptor-shape'],
  ['__nexus_start_kind=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/classify.cjs" "$BASH_EXECUTION_STRING" "$@") || exit 78', 'boot-classify'],
  ['nexus_start_kind=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/classify.cjs" "$BASH_EXECUTION_STRING" "$@") || exit 78', 'positional-classify'],
  ['nexus_kind=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/classify.cjs" "$nexus_command") || exit 78', 'debug-classify'],
 ] as const) bashContents = replaceOnce(bashContents, needle, needle.replace('|| exit 78', `|| { ${shellTrace(reason)} exit 78; }`));
 bashContents = replaceOnce(bashContents, '"${BASHPID:-$$}" "$nexus_kind") || { printf', '"${BASHPID:-$$}" "$nexus_kind") || { ' + shellTrace('debug-request') + ' printf');
 expect(bashContents.split('"${BASHPID:-$$}" "$nexus_kind")')).toHaveLength(2);
 fs.writeFileSync(bashFile, bashContents);
 const grokHome = path.join(root, 'grok'); fs.mkdirSync(grokHome);
 fs.writeFileSync(path.join(grokHome, 'config.toml'), `[cli]\nuse_leader = false\n[models]\ndefault = "finite"\n[model.finite]\nmodel = "finite"\nbase_url = "http://127.0.0.1:${port}/v1"\napi_backend = "messages"\nenv_key = "NEXUS_FAKE_PROVIDER_KEY"\ncontext_window = 32768\n`);
 const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: root, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(root, 'securestorage'),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'finite-test-credential', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl' };
 delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.NODE_OPTIONS;
 Object.assign(env, { GROK_HOME: grokHome, GROK_DISABLE_AUTOUPDATER: '1', NEXUS_FAKE_PROVIDER_KEY: 'finite-test-credential', NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'), BASH_ENV: path.join(resources, 'shell.bash'), ZDOTDIR: resources });
 const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:${port}"))(allow network-bind (local tcp "localhost:*"))(allow network-inbound (local tcp "localhost:*"))(allow network-bind (local unix (subpath ${JSON.stringify(fs.realpathSync(root))})))(allow network-inbound (local unix (subpath ${JSON.stringify(fs.realpathSync(root))})))(allow network-outbound (remote unix (subpath ${JSON.stringify(fs.realpathSync(root))})))`;
 const command = supervisedPtyCommand(runtime, '/usr/bin/sandbox-exec', ['-p', profile, grok!, '-p', 'finite fixture', '--always-approve', '--disable-web-search', '--model', 'finite', '--output-format', 'json']);
 const child = spawn(command.file, command.args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
 cliPid = child.pid!; let stderr = '', stdout = ''; child.stderr.on('data', (part) => stderr += part); child.stdout.on('data', (part) => stdout += part);
 const exit = new Promise<number | null>((resolve) => child.once('close', (code) => { cliAlive = false; resolve(code); }));
 const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
 try {
  const code = await exit;
  const admissionShapes = admissions.map((value) => { const request = value as { pid?: number; kind?: string; proof?: string; leaseId?: string }; return { pid: request.pid, kind: request.kind, proof: request.proof, hasLease: Boolean(request.leaseId) }; });
  const diagnosticFile = path.join(resources, 'diagnostic.jsonl');
  let transportDiagnostics = '', diagnosticFd: number | undefined;
  try { diagnosticFd = fs.openSync(diagnosticFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const buffer = Buffer.alloc(8000); transportDiagnostics = buffer.subarray(0, fs.readSync(diagnosticFd, buffer, 0, buffer.length, 0)).toString('utf8'); }
  catch { /* missing/unreadable private trace cannot replace the original assertion */ }
  finally { if (diagnosticFd !== undefined) { try { fs.closeSync(diagnosticFd); } catch { /* diagnostic only */ } } }
  const diagnostic = JSON.stringify({ shapes, toolResults, admissions: admissionShapes, admissionResults, transitions, transportDiagnostics }) + (stderr + stdout).slice(0, 8000);
  expect(code, diagnostic).toBe(0); expect(modelCalls, diagnostic).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(path.join(root, 'command-ran')), diagnostic).toBe(true);
  expect(fs.readFileSync(path.join(root, 'command-ran'), 'utf8')).toBe('done');
  expect(fs.readFileSync(path.join(root, 'snapshot-preserved'), 'utf8')).toBe('preserved');
  expect((admissions[0] as { proof?: string }).proof).toBe('darwin-job');
  expect(fs.readFileSync(path.join(root, 'command-count'), 'utf8')).toBe('x');
  expect(fs.readFileSync(path.join(root, 'snapshot-count'), 'utf8')).toBe('x');
  expect(admittedLeases.length).toBeGreaterThan(0);
  expect(new Set(admittedLeases).size).toBe(1);
  await native.drain(); expect(transitions).toEqual(['grant', 'release']); expect(stdout).toContain('finite fixture done');
 } finally {
  clearTimeout(timer); child.kill('SIGTERM'); await exit; pool.close();
  await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
 }
}, 35_000);
