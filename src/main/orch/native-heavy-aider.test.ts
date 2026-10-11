import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as nodePty from '@lydell/node-pty';
import { expect, it } from 'vitest';
import { NativeHeavyCommands } from './native-heavy-command';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import { watchDarwinHeavyCommand } from '../pty/darwin-heavy-command';
import { supervisedPtyCommand, nestedHeavyJobBaseCommand } from '../pty/darwin-pty-supervisor';
import { skipUnderNexusPtySupervisor } from '../../test/nested-pty-supervisor';
import { darwinNodePtyBootstrapLaunch } from '../pty/darwin-node-pty-bootstrap';
import { buildControlArgs } from '../adapters/control-args';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { AgentGateContext } from './gate';
const aider = '/Users/cleofaspereirarocha/.local/share/uv/tools/aider-chat/bin/aider';
const commandText = 'NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"';
const once = process.env.NEXUS_TEST_AIDER_APPROVE_ONCE === '1';
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

it.runIf(process.platform === 'darwin' && fs.existsSync(aider))('actual installed Aider owned-PTY default guard or exact normal one-time tool approval', async (testContext) => {
  skipUnderNexusPtySupervisor(testContext);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-c6-aider-pty-'))), phases: unknown[] = [];
  console.log(`owned Aider evidence: ${root}`);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fixtureSha256 = sha(path.join(process.cwd(), 'src/main/orch/native-heavy-aider.test.ts'));
  const helper = path.join(root, 'resources/native/darwin/nexus-pty-supervisor');
  execFileSync(process.execPath, ['scripts/build-darwin-pty-supervisor.mjs', '--output', helper], { stdio: 'ignore' });
  const runtime = { platform: 'darwin' as const, packaged: false, cwd: root, moduleDir: root };
  fs.cpSync('resources/heavy-command', path.join(root, 'heavy-command'), { recursive: true });
  const resources = fs.realpathSync(path.join(root, 'heavy-command'));
  const adapter = JSON.parse(fs.readFileSync('src/adapters/builtin/aider.json', 'utf8')) as CliPtyAdapter;
  const defaultArgs = buildControlArgs(adapter, once ? { permissionMode: 'default' } : {});
  for (const scheduled of once ? [false, true] : [false]) {
    const phase = scheduled ? 'scheduled' : 'baseline', dir = path.join(root, phase), workspace = path.join(dir, 'workspace'), home = path.join(dir, 'home'), tmp = path.join(dir, 'tmp');
    for (const p of [dir, workspace, home, tmp]) fs.mkdirSync(p, { mode: 0o700 });
    fs.writeFileSync(path.join(workspace, 'Makefile'), 'all:\n\t@node -e "process.stdout.write(\'ACTUAL_AIDER_NODE_DONE\\n\')" > command-ran\n');
    let pid = 0, alive = true, modelCalls = 0; const identity = {}, admissions: any[] = [], transitions: string[] = [];
    const scope = { version: 1 as const, installationId: 'private-aider', projectId: 'aider', checkoutId: phase, rootRealPath: workspace, identitySource: 'manifest' as const };
    const ctx = { token: `private-${randomUUID()}`, sessionId: `private-${phase}`, role: 'user', scope } as AgentGateContext;
    const proof = new OwnedCommandProcesses(id => id === ctx.sessionId && pid && alive ? { pid, identity } : null, undefined, p => watchDarwinHeavyCommand(runtime, p));
    const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
    const native = new NativeHeavyCommands({ current: () => alive, claim: (id, p, kind) => kind === 'darwin-job' && p !== pid ? proof.claim(id, p, kind) : Promise.resolve(null),
      probe: (id, claim) => proof.probe(id, claim), borrow: (id, claim, p) => proof.borrow(id, claim, p), stop: (id, claim) => proof.stop(id, claim),
      acquire: async request => { const permit = await pool.acquire(request); transitions.push('grant'); return { id: permit.id, release() { transitions.push('release'); permit.release(); } }; } });
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((req, res) => {
      req.setTimeout(5000, () => req.destroy()); let raw = '', bytes = 0;
      req.on('data', data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) req.destroy(); else raw += data; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (req.url === '/hook/heavy-command') {
            if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
            admissions.push(body); void native.admit(ctx, body).then(result => res.end(JSON.stringify(result))); return;
          }
          if (req.url !== '/v1/chat/completions' || ++modelCalls > 8) { res.writeHead(404); res.end(); return; }
          // Aider's installed editblock parser owns shell-code extraction and
          // ordinary yes-always confirmation. No shell is implemented here.
          const content = modelCalls === 1 ? `Run the exact finite private check.\n\n\`\`\`bash\n${commandText}\n\`\`\`\n` : 'Private check done.';
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: 1,
            model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        } catch { res.writeHead(422); res.end('{}'); }
      });
    });
    server.maxConnections = 16; server.setTimeout(5000, socket => socket.destroy()); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
    const env: Record<string, string> = { PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
      SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', OPENAI_API_KEY: 'private-finite-key', OPENAI_API_BASE: `http://127.0.0.1:${port}/v1` };
    if (scheduled) Object.assign(env, { NODE_OPTIONS: `--require ${JSON.stringify(path.join(resources, 'preload.cjs'))}`, NEXUS_HEAVY_AGENT_ENTRY: fs.realpathSync(aider),
      NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token,
      NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'), BASH_ENV: path.join(resources, 'shell.bash'), ZDOTDIR: resources });
    const args = [...defaultArgs, '--message', 'Run the finite private Make check exactly once.', '--model', 'openai/gpt-4o', '--openai-api-base', env.OPENAI_API_BASE,
      '--no-auto-commits', '--no-git', '--no-check-update', '--no-analytics', '--no-show-release-notes', '--no-stream', '--map-tokens', '0'];
    const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:${port}"))`;
    const launch = supervisedPtyCommand(runtime, '/usr/bin/sandbox-exec', ['-p', profile, aider, ...args]);
    const bootstrap = darwinNodePtyBootstrapLaunch(workspace, launch.file, launch.args, env);
    const terminal = nodePty.spawn(bootstrap.file, [...bootstrap.args], { cwd: bootstrap.cwd, env: bootstrap.env, cols: 120, rows: 35 }); pid = terminal.pid;
    let output = '', approved = false, outputAnswer = false;
    terminal.onData(data => {
      output = (output + data).slice(-32768);
      if (once && !approved && output.includes(commandText) && output.includes('Run shell command?')) { approved = true; terminal.write('y\r'); }
      if (once && !outputAnswer && output.includes('Add command output to the chat?')) { outputAnswer = true; terminal.write('n\r'); }
    });
    const closed = new Promise<{ exitCode: number; signal?: number }>(resolve => terminal.onExit(event => { alive = false; resolve(event); }));
    const timer = setTimeout(() => { if (alive) terminal.kill('SIGTERM'); }, 30000);
    try {
      const end = await closed; expect(end.exitCode, output).toBe(0); expect(modelCalls).toBeGreaterThan(0);
      if (!once) {
        expect(output).toContain(commandText); expect(fs.existsSync(path.join(workspace, 'command-ran'))).toBe(false); expect(admissions).toEqual([]);
        phases.push({ phase, end, modelCalls, admissions, transitions, defaultArgs, args, output, capability: 'default yes-always declines explicit model-shell approval' }); continue;
      }
      expect(approved).toBe(true);
      expect(fs.readFileSync(path.join(workspace, 'command-ran'), 'utf8'), output).toBe('ACTUAL_AIDER_NODE_DONE\n');
      if (scheduled) { expect(admissions.some(a => a.proof === 'darwin-job')).toBe(true); await native.drain(); expect(transitions).toEqual(['grant', 'release']); }
      else expect(admissions).toEqual([]);
      expect(output).not.toContain('responsibility inventory incomplete'); phases.push({ phase, end, modelCalls, admissions, transitions, defaultArgs, args, output, approved, outputAnswer });
    } finally {
      clearTimeout(timer); if (alive) terminal.kill('SIGTERM'); await closed; await native.drain(); pool.close();
      for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
      fs.writeFileSync(path.join(dir, 'phase.json'), JSON.stringify({ phase, modelCalls, admissions, transitions, output, once, approved, outputAnswer }) + '\n', { mode: 0o600 });
    }
  }
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({ sourceSha, fixtureSha256, entry: aider, entrySha256: sha(aider), phases }) + '\n', { mode: 0o600 });
}, 85000);
