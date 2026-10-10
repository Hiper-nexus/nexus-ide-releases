import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { NativeHeavyCommands } from './native-heavy-command';
import { nestedHeavyJobBaseCommand, supervisedPtyCommand } from '../pty/darwin-pty-supervisor';
import { watchDarwinHeavyCommand, type PhysicalCommandClaim } from '../pty/darwin-heavy-command';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import type { AgentGateContext } from './gate';
import { resolveCliBinary } from '../path-resolver';
import { buildControlArgs } from '../adapters/control-args';
import { mimoSkipPermissionsViaEnv } from '../adapters/mimo-skip-permissions';
import type { CliPtyAdapter } from '../../shared/adapter-types';

const selected = process.env.NEXUS_TEST_NATIVE_NODE_CLI ?? 'qwen';
const nexusDefault = process.env.NEXUS_TEST_NATIVE_NODE_DEFAULT !== '0';
const installed = {
  qwen: '/Users/cleofaspereirarocha/.npm-global/lib/node_modules/@qwen-code/qwen-code/cli-entry.js',
  mimo: '/Users/cleofaspereirarocha/.npm-global/lib/node_modules/@mimo-ai/cli/bin/mimo',
  minimax: '/Users/cleofaspereirarocha/.npm-global/lib/node_modules/@minimax-ai/code/cli.js',
};
const finiteCommand = 'NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"';
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const execute = promisify(execFile);
const transitionalInventoryWarning = 'nexus-pty-supervisor: responsibility inventory incomplete; remaining alive fail-closed\n';
interface C6Completion {
  ending: { code: number | null; signal: NodeJS.Signals | null };
  graceful: boolean; forcedKill: boolean; stderr: string; scheduled: boolean; cliPid: number; nativeDrained: boolean;
  expectedHelperSha256: string; helperSha256: string; expectedSourceSha256: string; sourceSha256: string;
  expectedEntrySha256: string; entrySha256: string; expectedNativeSha256: string | null; nativeSha256: string | null;
  cohortStates: Array<ReturnType<PhysicalCommandClaim['state']>>; transitions: string[];
  admissions: Array<{ pid: number; proof?: string; requestedLeaseId?: string; allow: boolean; leaseId?: string }>;
}

function assertC6Completion(proof: C6Completion): void {
  expect(proof.ending).toEqual({ code: 0, signal: null });
  expect(proof.graceful).toBe(true);
  expect(proof.forcedKill).toBe(false);
  expect(proof.nativeDrained).toBe(true);
  for (const [expected, actual] of [
    [proof.expectedHelperSha256, proof.helperSha256], [proof.expectedSourceSha256, proof.sourceSha256],
    [proof.expectedEntrySha256, proof.entrySha256],
  ]) { expect(expected).toMatch(/^[a-f0-9]{64}$/); expect(actual).toBe(expected); }
  if (proof.expectedNativeSha256 !== null) expect(proof.expectedNativeSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(proof.nativeSha256).toBe(proof.expectedNativeSha256);
  if (proof.scheduled) {
    const jobs = proof.admissions.filter(admission => admission.proof === 'darwin-job' && admission.requestedLeaseId === undefined);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.pid).not.toBe(proof.cliPid); expect(job.leaseId).toBeTypeOf('string'); expect(job.leaseId!.length).toBeGreaterThan(0);
    expect(proof.admissions.every(admission => admission.allow === true && admission.leaseId === job.leaseId &&
      (admission === job || admission.requestedLeaseId === job.leaseId))).toBe(true);
    expect(proof.transitions).toEqual(['grant', 'release']);
    expect(proof.cohortStates).toEqual(['gone']);
  } else {
    expect(proof.admissions).toEqual([]); expect(proof.transitions).toEqual([]); expect(proof.cohortStates).toEqual([]);
  }
  // The audited C helper holds its stable anchor until two complete empty
  // inventories. A warning during retries is not its terminal proof.
  expect(['', transitionalInventoryWarning]).toContain(proof.stderr);
}

/** Test transport only; capabilities are empty so the real CLI owns its shell.
 * Approval uses the CLI's own advertised one-time option for one exact command. */
function acp(child: ChildProcessWithoutNullStreams, approvals: unknown[]) {
  let id = 0, buffer = '', count = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const updates: unknown[] = [];
  const send = (value: object) => child.stdin.write(JSON.stringify(value) + '\n');
  const rejectAll = (error: Error) => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); } pending.clear(); };
  child.stdout.on('data', part => {
    buffer += part.toString('utf8'); if (buffer.length > 1024 * 1024) { rejectAll(new Error('ACP physical line bound')); return; }
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message: any; try { message = JSON.parse(line); } catch { continue; }
      if (++count > 2000) { rejectAll(new Error('ACP frame bound')); return; }
      if (message.method && message.id !== undefined) {
        if (message.method !== 'session/request_permission') { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'client capability not advertised' } }); continue; }
        const params = message.params, command = params?.toolCall?.rawInput?.command;
        const option = params?.options?.find((value: any) => value.kind === 'allow_once');
        approvals.push({ method: message.method, command, title: params?.toolCall?.title, options: params?.options, selected: command === finiteCommand ? option?.optionId : null });
        send({ jsonrpc: '2.0', id: message.id, result: { outcome: command === finiteCommand && option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } }); continue;
      }
      if (message.method === 'session/update') { updates.push(message.params); continue; }
      const waiting = pending.get(message.id); if (!waiting) continue;
      pending.delete(message.id); clearTimeout(waiting.timer); if (message.error) waiting.reject(new Error(JSON.stringify(message.error))); else waiting.resolve(message.result);
    }
  });
  child.once('close', () => rejectAll(new Error('ACP child physically closed')));
  return { updates, call(method: string, params: object): Promise<any> {
    const requestId = id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`bounded ACP request failed: ${method}`)); }, 20000);
      pending.set(requestId, { resolve, reject, timer }); send({ jsonrpc: '2.0', id: requestId, method, params });
    });
  }, stop() { rejectAll(new Error('owned fixture stopped')); } };
}

function openaiStream(res: http.ServerResponse, model: string, tool: { name: string; input: object } | null) {
  res.writeHead(200, { 'content-type': 'text/event-stream' }); const id = `chatcmpl-${randomUUID()}`;
  const chunk = (delta: object, finish: string | null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant' }, null);
  if (tool) { chunk({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }, null); chunk({}, 'tool_calls'); }
  else { chunk({ content: 'REAL_C6_MODEL_DONE' }, null); chunk({}, 'stop'); }
  res.end('data: [DONE]\n\n');
}

async function actualControl(kind: 'qwen' | 'minimax' | 'mimo') {
  const evidence = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `nexus-c6-${kind}-control-`)));
  const entry = fs.realpathSync(installed[kind]), entrySha256 = sha(entry);
  const nativeBinary = kind === 'mimo' ? fs.realpathSync(path.join(path.dirname(entry), '../node_modules/@mimo-ai/mimocode-darwin-arm64/bin/mimo')) : null;
  const nativeSha256 = nativeBinary ? sha(nativeBinary) : null;
  const cliNode = kind === 'minimax' ? fs.realpathSync('/opt/homebrew/bin/node') : process.execPath;
  const cliRuntime = JSON.parse(execFileSync(cliNode, ['-p', 'JSON.stringify({version:process.version,modules:process.versions.modules})'], { encoding: 'utf8', timeout: 5000 }));
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 }).trim();
  const fixtureSha256 = sha(path.join(process.cwd(), 'src/main/orch/native-heavy-node-clis.test.ts'));
  const adapterId = kind === 'mimo' ? 'mimo-code' : kind === 'minimax' ? 'minimax-code' : kind;
  const adapter = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/adapters/builtin', `${adapterId}.json`), 'utf8')) as CliPtyAdapter;
  let controlArgs = nexusDefault ? buildControlArgs(adapter, {}) : [];
  const controlEnv = kind === 'mimo' ? mimoSkipPermissionsViaEnv(controlArgs) : { args: controlArgs, env: {} };
  controlArgs = controlEnv.args;
  const helper = path.join(evidence, 'resources/native/darwin/nexus-pty-supervisor');
  const supervisorSource = path.join(process.cwd(), 'native/darwin-pty-supervisor/main.c'), supervisorSourceSha256 = sha(supervisorSource);
  execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/build-darwin-pty-supervisor.mjs'), '--output', helper], { stdio: 'ignore' });
  const helperSha256 = sha(helper);
  const runtime = { platform: 'darwin' as const, packaged: false, cwd: evidence, moduleDir: evidence };
  fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), path.join(evidence, 'heavy-command'), { recursive: true });
  const resources = fs.realpathSync(path.join(evidence, 'heavy-command')), phases: unknown[] = [];
  const resourceHashes = Object.fromEntries(fs.readdirSync(resources).sort().filter(name => fs.statSync(path.join(resources, name)).isFile()).map(name => [name, sha(path.join(resources, name))]));
  console.log(`C6 private evidence: ${evidence}`);
  for (const scheduled of [false, true]) {
    const phase = scheduled ? 'scheduled' : 'baseline', root = path.join(evidence, phase), workspace = path.join(root, 'workspace'), home = path.join(root, 'home'), tmp = path.join(root, 'tmp');
    for (const directory of [root, workspace, home, tmp]) fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(path.join(home, '.qwen'), { mode: 0o700 });
    const outside = path.join(root, 'outside-denied');
    let deniedRequests = 0; const denialSockets = new Set<import('node:net').Socket>();
    const denialServer = http.createServer((_req, res) => { deniedRequests++; res.end('owned-network-probe'); });
    denialServer.maxConnections = 4; denialServer.setTimeout(2000, socket => socket.destroy());
    denialServer.on('connection', socket => { denialSockets.add(socket); socket.once('close', () => denialSockets.delete(socket)); });
    await new Promise<void>(resolve => denialServer.listen(0, '127.0.0.1', resolve));
    const denialUrl = `http://127.0.0.1:${(denialServer.address() as { port: number }).port}/probe`;
    expect(await fetch(denialUrl).then(response => response.text())).toBe('owned-network-probe');
    fs.writeFileSync(path.join(workspace, 'Makefile'), `all:\n\t@node -e "process.stdout.write('REAL_C6_CHILD_DONE\\n')" > command-ran\n\t@if (printf forbidden > ${JSON.stringify(outside)}) 2>/dev/null; then printf escaped > outside-result; else printf denied > outside-result; fi\n\t@if /usr/bin/curl -m 2 --silent ${JSON.stringify(denialUrl)} >/dev/null 2>&1; then printf escaped > network-result; else printf denied > network-result; fi\n`);
    let cliPid = 0, cliAlive = true, requests = 0, toolSent = false; const identity = {}, admissions: any[] = [], transitions: string[] = [], shapes: unknown[] = [], approvals: unknown[] = [];
    const admissionResults: C6Completion['admissions'] = [], physicalClaims: PhysicalCommandClaim[] = [];
    const scope = { version: 1 as const, installationId: 'private-c6', projectId: kind, checkoutId: phase, rootRealPath: workspace, identitySource: 'manifest' as const };
    const ctx = { token: `private-${randomUUID()}`, sessionId: `private-${phase}`, role: 'user', scope } as AgentGateContext;
    const proof = new OwnedCommandProcesses(id => id === ctx.sessionId && cliPid && cliAlive ? { pid: cliPid, identity } : null, undefined, async pid => {
      const claim = await watchDarwinHeavyCommand(runtime, pid);
      if (claim) physicalClaims.push(claim);
      return claim;
    });
    const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
    const native = new NativeHeavyCommands({ current: () => cliAlive, claim: (id, pid, kind) => kind === 'darwin-job' && pid !== cliPid ? proof.claim(id, pid, kind) : Promise.resolve(null),
      probe: (id, claim) => proof.probe(id, claim), borrow: (id, claim, pid) => proof.borrow(id, claim, pid), stop: (id, claim) => proof.stop(id, claim),
      acquire: async request => { const permit = await pool.acquire(request); transitions.push('grant'); return { id: permit.id, release() { transitions.push('release'); permit.release(); } }; } });
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((req, res) => {
      req.setTimeout(5000, () => req.destroy()); let raw = '', bytes = 0;
      req.on('data', part => { bytes += part.length; if (bytes > 2 * 1024 * 1024) req.destroy(); else raw += part; });
      req.on('end', () => {
        try {
          if (++requests > 24) throw new Error('finite gateway budget'); const body = JSON.parse(raw);
          if (req.url === '/hook/heavy-command') {
            if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
            admissions.push(body); void native.admit(ctx, body).then(result => {
              admissionResults.push({ pid: body.pid, proof: body.proof, requestedLeaseId: body.leaseId, ...result });
              res.end(JSON.stringify(result));
            }); return;
          }
          if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
          const tools = (body.tools ?? []).map((t: any) => t.function); shapes.push({ tools, last: body.messages?.at(-1) });
          const shell = tools.find((tool: any) => ['run_shell_command', 'bash', 'Bash', 'exec_command'].includes(tool?.name));
          if (body.stream !== true) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: 1,
            model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'REAL_C6_MODEL_DONE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return; }
          if (!toolSent && shell) { toolSent = true; openaiStream(res, body.model, { name: shell.name, input: { command: finiteCommand, description: 'Exact finite private fixture' } }); }
          else openaiStream(res, body.model, null);
        } catch (error) { res.writeHead(422); res.end(JSON.stringify({ error: String(error) })); }
      });
    });
    server.maxConnections = 16; server.setTimeout(5000, socket => socket.destroy());
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
    fs.writeFileSync(path.join(home, '.qwen/settings.json'), JSON.stringify({ security: { auth: { selectedType: 'openai' } }, model: { name: 'finite-model' }, telemetry: { enabled: false } }));
    const env: NodeJS.ProcessEnv = { PATH: `${path.dirname(cliNode)}:/opt/homebrew/bin:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
      QWEN_HOME: path.join(home, '.qwen'), OPENAI_API_KEY: 'private-finite-model-key', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_MODEL: 'finite-model', LANG: 'en_US.UTF-8', TERM: 'dumb', SHELL: '/bin/bash' };
    Object.assign(env, controlEnv.env);
    let cliArgs = ['--acp', '--approval-mode', 'default', '--model', 'finite-model'];
    if (nexusDefault && kind === 'qwen') cliArgs = ['--acp', '--model', 'finite-model'];
    if (kind === 'mimo') {
      const mimoHome = path.join(home, 'mimo');
      for (const directory of [mimoHome, path.join(mimoHome, 'data'), path.join(mimoHome, 'config')]) fs.mkdirSync(directory, { mode: 0o700 });
      Object.assign(env, { MIMOCODE_HOME: mimoHome, MIMOCODE_DB: path.join(mimoHome, 'data/mimocode.db'), MIMOCODE_CONFIG_DIR: path.join(mimoHome, 'config'),
        MIMOCODE_DISABLE_AUTOUPDATE: '1', XIAOMI_API_KEY: 'private-finite-model-key', SHELL: process.env.SHELL ?? '/bin/zsh',
        MIMOCODE_CONFIG_CONTENT: JSON.stringify({ model: 'xiaomi/mimo-v2.6-flash', provider: { xiaomi: {
          models: { 'mimo-v2.6-flash': { id: 'mimo-v2.6-flash', name: 'Finite private MiMo', reasoning: true, tool_call: true } },
          options: { apiKey: '{env:XIAOMI_API_KEY}', baseURL: `http://127.0.0.1:${port}/v1` },
        } } }) });
      cliArgs = ['acp', '--cwd', workspace];
    }
    if (kind === 'minimax') {
      env.MINIMAX_DATA_DIR = path.join(home, 'minimax-data'); env.NEXUS_FAKE_PROVIDER_KEY = 'private-finite-model-key';
      try {
        const output = await execute('/usr/bin/sandbox-exec', ['-p', `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:${port}"))`, cliNode, entry, 'provider', 'add', '--name', 'NativeFinite', '--base-url', `http://127.0.0.1:${port}/v1`,
          '--api-format', 'openai-completions', '--model', 'finite-model', '--api-key-env', 'NEXUS_FAKE_PROVIDER_KEY', '--use'], { cwd: workspace, env, encoding: 'utf8', timeout: 15000, maxBuffer: 32768 });
        fs.writeFileSync(path.join(root, 'provider-add.txt'), output.stdout + output.stderr, { mode: 0o600 });
      } catch (error) {
        for (const socket of [...sockets, ...denialSockets]) socket.destroy();
        await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => denialServer.close(() => resolve()))]); pool.close();
        throw error;
      }
      cliArgs = ['--model', 'custom_provider:nativefinite/finite-model', 'acp'];
    }
    if (scheduled) Object.assign(env, { NODE_OPTIONS: `--require ${JSON.stringify(path.join(resources, 'preload.cjs'))}`, NEXUS_HEAVY_AGENT_ENTRY: entry,
      NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token,
      NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'), BASH_ENV: path.join(resources, 'shell.bash'), ZDOTDIR: resources });
    // Ordinary non-governed AI panes do not take the advisory/readOnly outer
    // file profile (mission-cli-execution-policy). No PTY/device grant is
    // added here. Network is narrowed to this finite fixture only; that is
    // a test restriction, not a claim about plain Autopilot network policy.
    const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:${kind === 'mimo' ? '*' : port}"))${kind === 'mimo' ? '(allow network-bind (local tcp "localhost:*"))(allow network-inbound (local tcp "localhost:*"))' : ''}`;
    const command = supervisedPtyCommand(runtime, '/usr/bin/sandbox-exec', ['-p', profile, cliNode, entry, ...controlArgs, ...cliArgs]);
    const child = spawn(command.file, command.args, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] }); cliPid = child.pid!;
    let stderr = ''; child.stderr.on('data', part => { stderr = (stderr + part).slice(-32768); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => { cliAlive = false; resolve({ code, signal }); })), rpc = acp(child, approvals);
    let forcedKill = false, nativeDrained = false;
    const timer = setTimeout(() => { if (cliAlive) { forcedKill = true; child.kill('SIGTERM'); } }, 30000);
    let failure: unknown;
    try {
      const initialized = await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'nexus-private-c6', version: '1' } });
      const session = await rpc.call('session/new', { cwd: workspace, mcpServers: [] });
      if (kind === 'minimax') {
        fs.writeFileSync(path.join(root, 'session-new.json'), JSON.stringify(session) + '\n', { mode: 0o600 });
        const options = (session.configOptions ?? []).find((option: any) => option.category === 'model' || option.id === 'model');
        const choices = (options?.options ?? []).flatMap((option: any) => option.options ?? [option]);
        const model = choices.find((option: any) => typeof option.value === 'string' && option.value.includes('finite-model'));
        if (!model) throw new Error(`actual private MiniMax model choice absent: ${JSON.stringify(session).slice(0, 4000)}`);
        await rpc.call('session/set_config_option', { sessionId: session.sessionId, configId: options.id, value: model.value });
      }
      const result = await rpc.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Run the exact finite private fixture tool command once, then report done.' }] });
      expect(result.stopReason, stderr).toBe('end_turn'); expect(toolSent, JSON.stringify(shapes)).toBe(true);
      expect(fs.readFileSync(path.join(workspace, 'command-ran'), 'utf8'), JSON.stringify(rpc.updates) + stderr).toBe('REAL_C6_CHILD_DONE\n');
      expect(fs.readFileSync(path.join(workspace, 'outside-result'), 'utf8')).toBe('escaped'); expect(fs.readFileSync(outside, 'utf8')).toBe('forbidden');
      expect(fs.readFileSync(path.join(workspace, 'network-result'), 'utf8')).toBe(kind === 'mimo' ? 'escaped' : 'denied');
      expect(deniedRequests).toBe(kind === 'mimo' ? 2 : 1); // MiMo's own ephemeral server requires ordinary loopback.
      if (scheduled) { expect(admissions.some(a => a.proof === 'darwin-job' && a.pid !== cliPid)).toBe(true); expect(transitions[0]).toBe('grant'); await native.drain(); expect(transitions).toEqual(['grant', 'release']); }
      else { expect(admissions).toEqual([]); expect(transitions).toEqual([]); }
      phases.push({ phase, initialized, result, cliPid, admissions, transitions, approvals, shapes, updates: rpc.updates,
        outsideWritePolicy: 'ordinary-no-file-confinement; owned private probe only', networkPolicy: kind === 'mimo' ? 'normal-loopback-required; external-fixture-only-restriction' : 'fixture-only-local-gateway-restriction', deniedProbeParentRequests: deniedRequests,
        nexusResolvedNode: resolveCliBinary('node', { processPath: env.PATH, home })?.binPath, controlArgs, cliArgs });
    } catch (error) { failure = error; throw error;
    } finally {
      clearTimeout(timer); rpc.stop(); child.stdin.end();
      const graceful = await Promise.race([closed.then(() => true), new Promise<false>(resolve => { const stop = setTimeout(() => resolve(false), 5000); stop.unref(); })]);
      if (!graceful && cliAlive) { forcedKill = true; child.kill('SIGTERM'); }
      const ending = await closed; await native.drain(); nativeDrained = true; pool.close();
      for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of denialSockets) socket.destroy(); await new Promise<void>(resolve => denialServer.close(() => resolve()));
      const completion: C6Completion = { ending, graceful, forcedKill, stderr, scheduled, cliPid, nativeDrained,
        expectedHelperSha256: helperSha256, helperSha256: sha(helper), expectedSourceSha256: supervisorSourceSha256, sourceSha256: sha(supervisorSource),
        expectedEntrySha256: entrySha256, entrySha256: sha(entry), expectedNativeSha256: nativeSha256, nativeSha256: nativeBinary ? sha(nativeBinary) : null,
        cohortStates: physicalClaims.map(claim => claim.state()), transitions, admissions: admissionResults };
      fs.writeFileSync(path.join(root, 'phase.json'), JSON.stringify({ phase, cliPid, admissions, transitions, approvals, shapes, updates: rpc.updates, stderr, ending, graceful, completion,
        failure: failure instanceof Error ? failure.message : failure, controlArgs, controlEnvKeys: Object.keys(controlEnv.env), cliArgs, nexusDefault }) + '\n', { mode: 0o600 });
      if (!failure) assertC6Completion(completion);
    }
  }
  expect(sha(entry)).toBe(entrySha256);
  if (nativeBinary) expect(sha(nativeBinary)).toBe(nativeSha256);
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ sourceSha, fixtureSha256, resourceHashes, helperSha256: sha(helper), cli: kind,
    cliNode, cliNodeSha256: sha(cliNode), cliRuntime, validationRuntime: process.version, entry, entrySha256, nativeBinary, nativeSha256, nexusDefault, controlArgs, phases }) + '\n', { mode: 0o600 });
}

function completeC6Fixture(): C6Completion {
  return { ending: { code: 0, signal: null }, graceful: true, forcedKill: false, stderr: '', scheduled: true, cliPid: 10, nativeDrained: true,
    expectedHelperSha256: 'a'.repeat(64), helperSha256: 'a'.repeat(64), expectedSourceSha256: 'b'.repeat(64), sourceSha256: 'b'.repeat(64),
    expectedEntrySha256: 'c'.repeat(64), entrySha256: 'c'.repeat(64), expectedNativeSha256: null, nativeSha256: null,
    cohortStates: ['gone'], transitions: ['grant', 'release'], admissions: [
      { pid: 20, proof: 'darwin-job', allow: true, leaseId: 'owned-lease' },
      { pid: 30, requestedLeaseId: 'owned-lease', allow: true, leaseId: 'owned-lease' },
      { pid: 40, requestedLeaseId: 'owned-lease', allow: true, leaseId: 'owned-lease' },
    ] };
}

describe('F-1144 — C6 terminal completion proof', () => {
  it.each(['', transitionalInventoryWarning])('accepts only completed audited native proof with stderr %j', stderr => {
    expect(() => assertC6Completion({ ...completeC6Fixture(), stderr })).not.toThrow();
  });
  const faults: Record<string, (proof: C6Completion) => void> = {
    'nonzero native exit': proof => { proof.ending.code = 159; },
    'native signal death': proof => { proof.ending = { code: null, signal: 'SIGKILL' }; },
    'grace deadline elapsed': proof => { proof.graceful = false; },
    'forced timer or cleanup': proof => { proof.forcedKill = true; },
    'unknown stderr': proof => { proof.stderr = 'unrecognized native failure\n'; },
    'warning plus other stderr': proof => { proof.stderr = transitionalInventoryWarning + 'unrecognized native failure\n'; },
    'changed helper image': proof => { proof.helperSha256 = 'd'.repeat(64); },
    'missing expected helper identity': proof => { proof.expectedHelperSha256 = ''; },
    'changed audited source': proof => { proof.sourceSha256 = 'd'.repeat(64); },
    'changed installed CLI': proof => { proof.entrySha256 = 'd'.repeat(64); },
    'changed installed native CLI': proof => { proof.nativeSha256 = 'd'.repeat(64); },
    'unfinished native drain': proof => { proof.nativeDrained = false; },
    'unknown physical cohort': proof => { proof.cohortStates = ['unknown']; },
    'live physical cohort': proof => { proof.cohortStates = ['live']; },
    'missing authenticated cohort': proof => { proof.cohortStates = []; },
    'missing actual admission': proof => { proof.admissions = []; },
    'rejected actual admission': proof => { proof.admissions[0]!.allow = false; },
    'wrong job root': proof => { proof.admissions[0]!.pid = proof.cliPid; },
    'borrowed foreign lease': proof => { proof.admissions[1]!.requestedLeaseId = 'foreign-lease'; },
    'returned foreign lease': proof => { proof.admissions[1]!.leaseId = 'foreign-lease'; },
    'unreleased native permit': proof => { proof.transitions = ['grant']; },
  };
  it.each(Object.keys(faults))('rejects %s even when stderr has no warning', fault => {
    const proof = completeC6Fixture(); faults[fault]!(proof);
    expect(() => assertC6Completion(proof)).toThrow();
  });
  it.each(['live', 'unknown'] as const)('rejects the exact transitional warning with an %s cohort', state => {
    const proof = completeC6Fixture(); proof.stderr = transitionalInventoryWarning; proof.cohortStates = [state];
    expect(() => assertC6Completion(proof)).toThrow();
  });
});

it.runIf(process.platform === 'darwin' && selected === 'qwen' && fs.existsSync(installed.qwen))('actual Qwen ordinary ACP shell: baseline and scoped Native A+B scheduling use unchanged normal approval', () => actualControl('qwen'), 85000);
it.runIf(process.platform === 'darwin' && selected === 'minimax' && fs.existsSync(installed.minimax))('actual MiniMax ordinary ACP shell: baseline and scoped Native A+B scheduling use unchanged normal approval', () => actualControl('minimax'), 85000);
it.runIf(process.platform === 'darwin' && selected === 'mimo' && fs.existsSync(installed.mimo))('actual MiMo native ordinary ACP shell: baseline and scoped Native A+B scheduling use unchanged normal approval', () => actualControl('mimo'), 85000);
