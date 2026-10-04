import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fork, spawn, execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, utilityProcess: { fork: () => { throw new Error('explicit Node test port required'); } } }));
import { createNativeHeavyLocalChannel } from './native-heavy-local-channel';
import { reserveMuseNativeHeavyProfile } from './native-heavy-muse-profile';
import { cleanupCliMcpSession } from './cli-mcp-session-artifacts';
import { buildControlArgs } from '../adapters/control-args';
import { cliPtyAdapterSchema } from '../../shared/adapter-types';
import museAdapter from '../../adapters/builtin/muse.json';
import { NativeHeavyCommands } from './native-heavy-command';
import { nestedHeavyJobBaseCommand, supervisedPtyCommand } from '../pty/darwin-pty-supervisor';
import { watchDarwinHeavyCommand } from '../pty/darwin-heavy-command';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import type { AgentGateContext } from './gate';
const muse = process.env.NEXUS_TEST_MUSE_BIN ?? (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'muse')).find((file) => fs.existsSync(file));
function response(res: http.ServerResponse, item: Record<string, unknown>) {
 res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
 let sequence = 0;
 const event = (value: Record<string, unknown>) => res.write(`event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`);
 const base = { id: 'resp_private_fixture', object: 'response', model: 'muse-spark-1.3', created_at: 1, status: 'in_progress', output: [] };
 event({ type: 'response.created', response: base });
 event({ type: 'response.output_item.added', output_index: 0, item });
 event({ type: 'response.output_item.done', output_index: 0, item });
 event({ type: 'response.completed', response: { ...base, status: 'completed', completed_at: 2, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
 res.write('data: [DONE]\n\n');
 res.end();
}

it.runIf(process.platform === 'darwin' && Boolean(muse)).each([
 { scheduled: false, fullAuto: false }, { scheduled: true, fullAuto: false },
 { scheduled: false, fullAuto: true }, { scheduled: true, fullAuto: true },
])('real Muse private selected profile and scheduling=$scheduled fullAuto=$fullAuto', async ({ scheduled, fullAuto }) => {
 const root = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(process.cwd()), 'native-muse-control-')));
 const workspace = path.join(root, 'workspace'), privateTmp = path.join(root, 'tmp'), home = path.join(root, 'home');
 for (const directory of [workspace, privateTmp, home]) fs.mkdirSync(directory);
 const marker = path.join(workspace, 'command-ran'), outside = path.join(root, 'outside-marker');
 const fsPreflight = process.env.NEXUS_TEST_MUSE_FS_PREFLIGHT === '1';
 fs.writeFileSync(path.join(workspace, 'Makefile'), 'all:\n\t@printf done > command-ran\n');
 const helper = path.join(root, 'resources/native/darwin/nexus-pty-supervisor');
 execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/build-darwin-pty-supervisor.mjs'), '--output', helper], { stdio: 'ignore' });
 const runtime = { platform: 'darwin' as const, packaged: false, cwd: root, moduleDir: root };
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'muse-hook', checkoutId: 'finite', rootRealPath: workspace, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-hook', sessionId: 'finite-hook-session', role: 'user', scope } as AgentGateContext;
 let cliPid = 0, cliAlive = true; const identity = {};
 const proof = new OwnedCommandProcesses((id) => id === ctx.sessionId && cliPid && cliAlive ? { pid: cliPid, identity } : null, undefined, (pid) => watchDarwinHeavyCommand(runtime, pid));
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const transitions: string[] = []; const admissions: unknown[] = [];
 const native = new NativeHeavyCommands({ current: () => cliAlive, claim: (id, pid, proofKind) => proofKind === 'darwin-job' ? proof.claim(id, pid, proofKind) : Promise.resolve(null), probe: (id, claim) => proof.probe(id, claim), borrow: (id, claim, pid) => proof.borrow(id, claim, pid), stop: (id, claim) => proof.stop(id, claim),
   acquire: async (request) => { expect(fs.existsSync(marker)).toBe(false); const permit = await pool.acquire(request); transitions.push('grant'); return { id: permit.id, release: () => { transitions.push('release'); permit.release(); } }; } });
 let modelCalls = 0; let toolSent = false; const shapes: unknown[] = [];
 const server = http.createServer((req, res) => {
  if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'muse-spark-1.3', object: 'model', name: 'muse-spark-1.3', context_length: 32768 }], models: [{ id: 'muse-spark-1.3', name: 'muse-spark-1.3' }] })); return; }
  let raw = ''; req.on('data', (part) => { raw += part; if (raw.length > 4 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
   if (req.url === '/hook/heavy-command') {
    admissions.push(JSON.parse(raw));
    if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
    void native.admit(ctx, JSON.parse(raw)).then((result) => res.end(JSON.stringify(result))); return;
   }
   if (req.url?.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
   if (req.method === 'POST') {
    const request = JSON.parse(raw); modelCalls++;
    const offered = (request.tools ?? []).flatMap((tool: { name?: string; tools?: Array<{ name?: string }> }) => tool.tools?.map((entry) => ({ ...entry, namespace: tool.name })) ?? [tool]);
    const tool = offered.find((entry: { name?: string }) => /shell|bash|exec|terminal/i.test(entry.name ?? ''));
    shapes.push({ keys: Object.keys(request), offered: offered.map((entry: { name?: string }) => entry.name), selected: tool && { name: tool.name, namespace: tool.namespace, fields: Object.keys(tool.parameters?.properties ?? {}), required: tool.parameters?.required }, outputs: (request.input ?? []).filter((entry: { type?: string }) => /output/.test(entry.type ?? '')) });
    if (!toolSent && tool) {
     toolSent = true;
     const probe = channel ? path.join(channel.env.NEXUS_HEAVY_CHANNEL_DIR, 'owned-fs-probe') : '';
     const command = fsPreflight ? `printf filesystem-permitted > ${JSON.stringify(probe)}; /bin/cat ${JSON.stringify(probe)}` : `NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"; if printf forbidden > ${JSON.stringify(outside)} 2>/dev/null; then printf outside-allowed; else printf outside-denied; fi`;
     response(res, { type: 'function_call', id: 'fc_finite', call_id: 'call_finite', name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify({ command, description: 'Run finite fixture command', workdir: workspace, yield_time_ms: 10000 }), status: 'completed' });
    }
    else response(res, { type: 'message', id: 'message_finite', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'finite fixture done', annotations: [] }] }); return;
   }
   res.writeHead(404); res.end('{}');
  });
 });
 server.maxConnections = 16; server.headersTimeout = 5000; server.requestTimeout = 5000;
 const sockets = new Set<import('node:net').Socket>();
 server.on('connection', socket => { sockets.add(socket); socket.setTimeout(5000, () => socket.destroy()); socket.once('close', () => sockets.delete(socket)); });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address() as { port: number };
 fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), path.join(root, 'heavy-command'), { recursive: true });
 const resources = fs.realpathSync(path.join(root, 'heavy-command'));
 const channel = scheduled ? await createNativeHeavyLocalChannel(ctx, privateTmp, { current: () => cliAlive, admit: (context, body, signal) => { admissions.push(body); return native.admit(context, body, signal); }, drainContext: context => native.drainContext(context), spawn: (entry, cwd, transport) => {
  const child = fork(entry, transport === 'file' ? ['--file'] : [], { cwd, execPath: process.execPath, execArgv: [], env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return { on: (event, callback) => child.on(event, callback), postMessage: message => { child.send(message as Parameters<typeof child.send>[0]); }, kill: () => child.kill() };
 } }, { transport: 'file' }) : null;
 const selectedConfig = path.join(home, 'config/muse'); fs.mkdirSync(selectedConfig, { recursive: true });
 const originalSettings = JSON.stringify({ schema_version: 1, hooks: { Stop: [] } });
 fs.writeFileSync(path.join(selectedConfig, 'settings.json'), originalSettings);
 const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: privateTmp, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, 'securestorage'),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'finite-test-credential', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl' };
 delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.NODE_OPTIONS;
 Object.assign(env, { ...channel?.env, META_API_KEY: 'finite-test-credential', NEXUS_FAKE_PROVIDER_KEY: 'finite-test-credential', NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'), BASH_ENV: path.join(resources, 'shell.bash'), ZDOTDIR: resources });
 if (!scheduled) for (const name of Object.keys(env)) if (name.startsWith('NEXUS_HEAVY_') || name === 'NEXUS_GATE_TOKEN' || name === 'BASH_ENV' || name === 'ZDOTDIR') delete env[name];
 if (scheduled) {
  const profile = reserveMuseNativeHeavyProfile({ token: ctx.token, home, xdgConfigHome: env.XDG_CONFIG_HOME,
   artifactRoot: path.join(privateTmp, 'nexus-muse-profiles'), node: process.execPath, resourceDirectory: resources });
  Object.assign(env, profile.env); await profile.initialize(() => { if (!cliAlive) throw new Error('fixture_context_changed'); });
 }
 const command = supervisedPtyCommand(runtime, muse!, ['exec', '--base-url', `http://127.0.0.1:${port}`, '--model', 'muse-spark-1.3', '--workspace', workspace, '--trust-workspace',
  ...(fullAuto ? buildControlArgs(cliPtyAdapterSchema.parse(museAdapter), {}) : ['--approval-mode', 'never']), 'finite fixture']);
 const child = spawn(command.file, command.args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
 cliPid = child.pid!; let stderr = '', stdout = ''; child.stderr.on('data', (part) => stderr += part); child.stdout.on('data', (part) => stdout += part);
 const exit = new Promise<number | null>((resolve) => child.once('close', (code) => { cliAlive = false; resolve(code); }));
 const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
 try {
  const code = await exit;
  if (fsPreflight) {
   expect(code).toBe(0); expect(fs.readFileSync(path.join(channel!.env.NEXUS_HEAVY_CHANNEL_DIR, 'owned-fs-probe'), 'utf8'), JSON.stringify(shapes)).toBe('filesystem-permitted');
   expect(JSON.stringify(shapes)).toContain('filesystem-permitted'); expect(admissions).toEqual([]); expect(transitions).toEqual([]); return;
  }
  if (!fs.existsSync(marker) || scheduled && !admissions.length) {
   let visited = 0; const diagnostics: unknown[] = [];
   const inspect = (directory: string, depth: number) => { if (depth > 5) return; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (++visited > 256) return; const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(file, depth + 1);
    else if (entry.isFile() && /log|jsonl|ndjson/.test(entry.name) && fs.statSync(file).size < 1024 * 1024) {
     const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => /hook|approval|sandbox/i.test(line));
     if (lines.length) diagnostics.push({ file: path.relative(root, file), lines: lines.slice(0, 8).map(line => line.slice(0, 4000)) });
    }
   } };
   inspect(root, 0); console.error('private Muse stream diagnostics', JSON.stringify(diagnostics));
  }
  expect(code, (stderr || stdout).slice(0, 2048)).toBe(0); expect(modelCalls).toBeGreaterThanOrEqual(2);
 expect(fs.existsSync(marker), JSON.stringify({ shapes, channelCalls: admissions.length, transitions }).slice(-7000) + (stderr + stdout).slice(-2000)).toBe(true);
  expect(fs.readFileSync(marker, 'utf8')).toBe('done');
  expect(fs.existsSync(outside)).toBe(fullAuto); expect(JSON.stringify(shapes)).toContain(fullAuto ? 'outside-allowed' : 'outside-denied');
  expect(fs.readFileSync(path.join(selectedConfig, 'settings.json'), 'utf8')).toBe(originalSettings);
  if (scheduled) expect((admissions[0] as { proof?: string } | undefined)?.proof, JSON.stringify(shapes).slice(-5000) + stderr.slice(-4000)).toBe('darwin-job'); else expect(admissions).toEqual([]);
  await native.drain(); expect(transitions).toEqual(scheduled ? ['grant', 'release'] : []); expect(stdout).toContain('finite fixture done');
 } finally {
  clearTimeout(timer); child.kill('SIGTERM'); await exit; pool.close();
  if (fsPreflight && channel && fs.existsSync(path.join(channel.env.NEXUS_HEAVY_CHANNEL_DIR, 'owned-fs-probe'))) fs.unlinkSync(path.join(channel.env.NEXUS_HEAVY_CHANNEL_DIR, 'owned-fs-probe'));
  await channel?.dispose();
  cleanupCliMcpSession(ctx.token);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
 }
}, 35_000);
