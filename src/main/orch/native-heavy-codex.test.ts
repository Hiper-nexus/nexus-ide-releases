import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fork, spawn, execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, utilityProcess: { fork: () => { throw new Error('explicit Node test port required'); } } }));
import { createNativeHeavyLocalChannel } from './native-heavy-local-channel';
import { prepareCodexOperatorMissionHome } from './cli-mcp-session-codex';
import { cleanupCliMcpSession } from './cli-mcp-session-artifacts';
import { configureCodexNativeHeavyChannel } from './codex-native-heavy-channel';
import { stringify } from 'smol-toml';
import { NativeHeavyCommands } from './native-heavy-command';
import { nestedHeavyJobBaseCommand, supervisedPtyCommand } from '../pty/darwin-pty-supervisor';
import { watchDarwinHeavyCommand } from '../pty/darwin-heavy-command';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import type { AgentGateContext } from './gate';

const codex = process.env.NEXUS_TEST_CODEX_BIN ?? (process.env.PATH ?? '').split(path.delimiter)
  .map(directory => path.join(directory, 'codex')).find(file => fs.existsSync(file));

function response(res: http.ServerResponse, item: Record<string, unknown>) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (value: Record<string, unknown>) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  const base = { id: 'resp_private_fixture', object: 'response', created_at: 1, status: 'in_progress', output: [] };
  event({ type: 'response.created', response: base });
  event({ type: 'response.output_item.added', output_index: 0, item });
  event({ type: 'response.output_item.done', output_index: 0, item });
  event({ type: 'response.completed', response: { ...base, status: 'completed', output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end();
}

it.runIf(process.platform === 'darwin' && Boolean(codex)).each(['baseline', 'file'] as const)('real Codex workspace-write %s keeps scoped command policy', async mode => {
  // Codex rejects helper aliases when CODEX_HOME is under the system TMP.
  // This new private directory is outside TMP and never reads a native HOME.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(process.cwd()), 'native-codex-control-')));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const privateTmp = path.join(root, 'tmp'); fs.mkdirSync(privateTmp);
  const nodeEntry = path.join(workspace, 'node_modules/typescript/bin/finite.cjs'); fs.mkdirSync(path.dirname(nodeEntry), { recursive: true });
  fs.writeFileSync(nodeEntry, `require('node:fs').writeFileSync(${JSON.stringify(path.join(workspace, 'node-ran'))}, 'node-done')`);
  fs.writeFileSync(path.join(workspace, 'Makefile'), 'all:\n\t@printf done > command-ran\n');
  const helper = path.join(root, 'resources/native/darwin/nexus-pty-supervisor');
  execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/build-darwin-pty-supervisor.mjs'), '--output', helper], { stdio: 'ignore' });
  const runtime = { platform: 'darwin' as const, packaged: false, cwd: root, moduleDir: root };
  const scope = { version: 1 as const, installationId: 'finite', projectId: 'codex-hook', checkoutId: 'finite', rootRealPath: workspace, identitySource: 'manifest' as const };
  const ctx = { token: 'finite-codex-hook', sessionId: 'finite-codex-session', role: 'user', scope } as AgentGateContext;
  let cliPid = 0, cliAlive = true; const identity = {};
  const proof = new OwnedCommandProcesses(id => id === ctx.sessionId && cliPid && cliAlive ? { pid: cliPid, identity } : null,
    undefined, pid => watchDarwinHeavyCommand(runtime, pid));
  const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
  const transitions: string[] = [], admissions: unknown[] = [], shapes: unknown[] = [];
  const native = new NativeHeavyCommands({ current: () => cliAlive,
    claim: (id, pid, kind) => proof.claim(id, pid, kind), probe: (id, claim) => proof.probe(id, claim),
    borrow: (id, claim, pid) => proof.borrow(id, claim, pid), stop: (id, claim) => proof.stop(id, claim),
    acquire: async request => { expect(fs.existsSync(path.join(workspace, 'command-ran'))).toBe(false);
      expect(fs.existsSync(path.join(workspace, 'node-ran'))).toBe(false);
      const permit = await pool.acquire(request); expect(fs.existsSync(path.join(workspace, 'command-ran'))).toBe(false); transitions.push('grant');
      return { id: permit.id, release: () => { transitions.push('release'); permit.release(); } }; } });
  let toolSent = false, modelCalls = 0, forbiddenConnections = 0;
  let forbiddenPort = 0;
  const foreignSocket = path.join(privateTmp, 'foreign.sock');
  const foreign = http.createServer((_req, res) => { forbiddenConnections++; res.end('forbidden'); });
  foreign.maxConnections = 4; foreign.headersTimeout = 5000; foreign.requestTimeout = 5000;
  await new Promise<void>(resolve => foreign.listen(foreignSocket, resolve));
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    let raw = '', bytes = 0;
    req.on('data', part => { bytes += part.length; if (bytes > 4 * 1024 * 1024) req.destroy(); else raw += part; });
    req.on('end', () => {
      try {
        if (req.url === '/hook/heavy-command') {
          if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end('{}'); return; }
          const body = JSON.parse(raw); admissions.push(body);
          void native.admit(ctx, body).then(result => { admissions.push({ result }); res.end(JSON.stringify(result)); }); return;
        }
        if (req.url?.startsWith('/v1/responses')) {
          const body = JSON.parse(raw); modelCalls++;
          // Codex 0.160 Responses Lite carries its declared tools as a
          // developer additional_tools input item instead of body.tools.
          const tools = (body.tools ?? (body.input ?? []).filter((item: { type?: string }) => item.type === 'additional_tools')
            .flatMap((item: { tools?: unknown[] }) => item.tools ?? [])) as Array<{ name?: string; type?: string; tools?: Array<{ name?: string; type?: string }> }>;
          const offered = tools.flatMap(tool => tool.tools?.map(entry => ({ ...entry, namespace: tool.name })) ?? [tool]);
          shapes.push({ keys: Object.keys(body), inputTypes: (body.input ?? []).map((item: { type?: string }) => item.type),
            tools: offered.map(tool => ({ name: tool.name, type: tool.type, namespace: 'namespace' in tool ? tool.namespace : undefined })) });
          const selected = offered.find(tool => /(?:^|\.)exec_command$/.test(tool.name ?? '') || /(?:^|\.)shell$/.test(tool.name ?? '') || tool.name === 'exec' && tool.type === 'custom');
          if (!toolSent && selected) {
            toolSent = true;
            const tcpDenied = `/usr/bin/curl --disable --silent --show-error --fail --noproxy '*' --connect-timeout 1 --max-time 1 http://127.0.0.1:${forbiddenPort}/must-not-connect`;
            const unixDenied = `/usr/bin/curl --disable --silent --show-error --fail --noproxy '*' --connect-timeout 1 --max-time 1 --unix-socket ${JSON.stringify(foreignSocket)} http://127.0.0.1/must-not-connect`;
            const command = `if (printf forbidden > ${JSON.stringify(path.join(root, 'outside-probe'))}) 2>/dev/null; then exit 91; fi; if ${tcpDenied} 2>/dev/null; then exit 92; fi; if ${unixDenied} 2>/dev/null; then exit 93; fi; printf tmp-ok > "$TMPDIR/codex-io-control"; NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"; ${JSON.stringify(process.execPath)} ${JSON.stringify(nodeEntry)}`;
            const input = selected.name?.endsWith('shell') ? { command: ['/bin/zsh', '-c', command], workdir: workspace }
              : { cmd: command, workdir: workspace, yield_time_ms: 1000, max_output_tokens: 2048 };
            response(res, selected.type === 'custom' ? { id: 'ctc_private_fixture', type: 'custom_tool_call', call_id: 'call_private_fixture',
              name: selected.name, ...('namespace' in selected ? { namespace: selected.namespace } : {}),
              input: `let result = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workspace, yield_time_ms: 10000, max_output_tokens: 2048 })}); while (result.session_id) { result = await tools.write_stdin({session_id: result.session_id, chars: '', yield_time_ms: 1000, max_output_tokens: 2048}); } text(result.output);`, status: 'completed' }
              : { id: 'fc_private_fixture', type: 'function_call', call_id: 'call_private_fixture',
                name: selected.name, ...('namespace' in selected ? { namespace: selected.namespace } : {}), arguments: JSON.stringify(input), status: 'completed' });
          } else response(res, { id: 'msg_private_fixture', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'finite fixture done', annotations: [] }] });
          return;
        }
        if (req.url?.startsWith('/v1/models')) { res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] })); return; }
        if (req.url === '/must-not-connect') { forbiddenConnections++; res.end('forbidden'); return; }
        res.writeHead(404); res.end('{}');
      } catch { res.writeHead(422); res.end('{}'); }
    });
  });
  server.maxConnections = 16; server.headersTimeout = 5000; server.requestTimeout = 5000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
  forbiddenPort = port;
  fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), path.join(root, 'heavy-command'), { recursive: true });
  const resources = fs.realpathSync(path.join(root, 'heavy-command')), providerHome = path.join(root, 'provider-codex'); fs.mkdirSync(providerHome);
  const channel = mode === 'file' ? await createNativeHeavyLocalChannel(ctx, privateTmp, { current: () => cliAlive,
    admit: (context, body, signal) => { admissions.push(body); return native.admit(context, body, signal); },
    drainContext: context => native.drainContext(context), spawn: (entry, cwd, transport) => {
      const helper = fork(entry, transport === 'file' ? ['--file'] : [], { cwd, execPath: process.execPath, execArgv: [], env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      return { on: (event, callback) => helper.on(event, callback), postMessage: message => { helper.send(message as Parameters<typeof helper.send>[0]); }, kill: () => helper.kill() };
    } }, { transport: 'file' }) : undefined;
  const heavy = mode === 'baseline' ? {} : { ...channel?.env, NEXUS_HEAVY_AGENT_ENTRY: fs.realpathSync(codex!), NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`,
    NEXUS_GATE_TOKEN: ctx.token, NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources,
    NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'),
    BASH_ENV: path.join(resources, 'shell.bash'), ZDOTDIR: resources, NODE_OPTIONS: `--require ${JSON.stringify(path.join(resources, 'preload.cjs'))}` };
  fs.writeFileSync(path.join(providerHome, 'config.toml'), stringify({ model: 'gpt-6.1-sol', model_provider: 'finite',
    sandbox_mode: 'workspace-write', approval_policy: 'never', shell_environment_policy: { inherit: 'core' },
    model_providers: { finite: { name: 'finite', base_url: `http://127.0.0.1:${port}/v1`, env_key: 'NEXUS_FAKE_PROVIDER_KEY', wire_api: 'responses' } } }));
  const prepared = prepareCodexOperatorMissionHome(ctx.token, { home: root, providerHome, artifactRoot: path.join(root, 'ephemeral'),
    userDataPath: path.join(root, 'user-data'), checkoutId: 'finite-codex', heavyCommandEnv: heavy });
  const env = { PATH: process.env.PATH, HOME: root, ...prepared.env, TMPDIR: privateTmp, SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NEXUS_FAKE_PROVIDER_KEY: 'finite-test-credential', ...heavy };
  if (channel) {
    await configureCodexNativeHeavyChannel(ctx.token, channel.env, Object.keys(env), () => { if (!cliAlive) throw new Error('private fixture revoked'); });
    const configBytes = fs.readFileSync(path.join(prepared.env.CODEX_HOME, 'config.toml'), 'utf8');
    expect(configBytes).not.toContain(channel.env.NEXUS_HEAVY_CHANNEL_KEY);
    expect(configBytes).not.toContain(channel.env.NEXUS_HEAVY_CHANNEL_PUBLIC_KEY);
  }
  const command = supervisedPtyCommand(runtime, codex!, ['exec', '--skip-git-repo-check', '--json', '--cd', workspace, 'finite fixture']);
  const child = spawn(command.file, command.args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  cliPid = child.pid!; let stderr = '', stdout = '';
  child.stderr.on('data', part => stderr += part); child.stdout.on('data', part => stdout += part);
  const exit = new Promise<number | null>(resolve => child.once('close', code => { cliAlive = false; resolve(code); }));
  const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
  try {
    expect(await exit, (stderr + stdout).slice(-4000)).toBe(0);
    expect(modelCalls, JSON.stringify(shapes) + (stderr + stdout).slice(-4000)).toBeGreaterThanOrEqual(2);
    expect(toolSent, JSON.stringify(shapes)).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'command-ran')), JSON.stringify({ shapes, admissions, transitions }) + (stderr + stdout).slice(-5000)).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'command-ran'), 'utf8')).toBe('done');
    expect(fs.readFileSync(path.join(workspace, 'node-ran'), 'utf8')).toBe('node-done');
    expect(fs.existsSync(path.join(root, 'outside-probe'))).toBe(false);
    expect(fs.readFileSync(path.join(privateTmp, 'codex-io-control'), 'utf8')).toBe('tmp-ok');
    expect(forbiddenConnections).toBe(0);
    expect(admissions.some(value => (value as { proof?: string }).proof === 'darwin-job')).toBe(mode === 'file');
    if (mode === 'file') expect(admissions.some(value => typeof (value as { leaseId?: string }).leaseId === 'string'), JSON.stringify(admissions)).toBe(true);
    await native.drain(); expect(transitions).toEqual(mode === 'file' ? ['grant', 'release'] : []);
  } finally {
    clearTimeout(timer); child.kill('SIGTERM'); await exit; pool.close(); await channel?.dispose();
    const closed = new Promise<void>(resolve => server.close(() => resolve())); for (const socket of sockets) socket.destroy(); await closed;
    await new Promise<void>(resolve => foreign.close(() => resolve()));
    cleanupCliMcpSession(ctx.token);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 40000);
