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
import { darwinNodePtyBootstrapLaunch } from '../pty/darwin-node-pty-bootstrap';
import { prepareCheckoutProviderHome } from '../adapters/managed-credentials';
import { buildControlArgs } from '../adapters/control-args';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { AgentGateContext } from './gate';

const devin = '/Users/cleofaspereirarocha/.local/share/devin/cli/_versions/3000.11.3/bin/devin';
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const statIdentity = (file: string) => { const s = fs.statSync(file); return [s.ino, s.size, s.mtimeMs]; };

// Explicit opt-in: ordinary suites do not invoke authenticated inference.
it.runIf(process.platform === 'darwin' && process.env.NEXUS_TEST_DEVIN_AUTHENTICATED === '1' && fs.existsSync(devin))('actual authenticated Devin default PTY shell baseline and current Main admission', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-c6-devin-auth-')));
  console.log(`owned Devin evidence: ${root}`);
  const nativeHome = '/Users/cleofaspereirarocha', authSource = path.join(nativeHome, '.local/share');
  const credential = path.join(authSource, 'devin/credentials.toml'), credentialBefore = statIdentity(credential);
  const helper = path.join(root, 'resources/native/darwin/nexus-pty-supervisor');
  execFileSync(process.execPath, ['scripts/build-darwin-pty-supervisor.mjs', '--output', helper], { stdio: 'ignore' });
  fs.cpSync('resources/heavy-command', path.join(root, 'heavy-command'), { recursive: true });
  const resources = fs.realpathSync(path.join(root, 'heavy-command'));
  const runtime = { platform: 'darwin' as const, packaged: false, cwd: root, moduleDir: root };
  const adapter = JSON.parse(fs.readFileSync('src/adapters/builtin/devin.json', 'utf8')) as CliPtyAdapter;
  const receipt: Record<string, unknown> = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    fixtureSha256: hash(path.join(process.cwd(), 'src/main/orch/native-heavy-devin-authenticated.test.ts')), entrySha256: hash(devin),
    helperSha256: hash(helper), defaultArgs: buildControlArgs(adapter, {}), phases: [], monetaryCap: 'not supplied by CLI', physicalCeilingMs: 30_000 };

  async function launch(cwd: string, args: string[], env: Record<string, string>, started: (pid: number) => void = () => {}): Promise<{ exitCode: number; signal?: number; output: string; timedOut: boolean }> {
    const plan = supervisedPtyCommand(runtime, '/usr/bin/sandbox-exec', ['-p', `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(path.join(nativeHome, '.local/share/devin'))}) (subpath ${JSON.stringify(path.join(nativeHome, '.config/devin'))}) (literal ${JSON.stringify(path.join(env.XDG_DATA_HOME, 'devin/credentials.toml'))}))`, devin, ...args]);
    const bootstrap = darwinNodePtyBootstrapLaunch(cwd, plan.file, plan.args, env);
    const terminal = nodePty.spawn(bootstrap.file, [...bootstrap.args], { cwd: bootstrap.cwd, env: bootstrap.env, cols: 120, rows: 35 });
    started(terminal.pid);
    let output = '', live = true, timedOut = false;
    terminal.onData(data => { output = (output + data).slice(-131072); });
    const timer = setTimeout(() => { timedOut = true; if (live) terminal.kill('SIGKILL'); }, 30_000);
    try {
      const end = await new Promise<{ exitCode: number; signal?: number }>(resolve => terminal.onExit(value => { live = false; resolve(value); }));
      return { ...end, output, timedOut };
    } finally { clearTimeout(timer); }
  }

  function privateEnv(label: string): { workspace: string; config: string; env: Record<string, string> } {
    const dir = path.join(root, label), workspace = path.join(dir, 'workspace'), tmp = path.join(dir, 'tmp'), config = path.join(dir, 'config.json');
    const home = path.join(dir, 'home');
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 }); fs.mkdirSync(tmp, { mode: 0o700 }); fs.mkdirSync(home, { mode: 0o700 }); fs.writeFileSync(config, '{}\n', { mode: 0o600 });
    const state = prepareCheckoutProviderHome('devin', { userDataPath: path.join(root, 'userData'), checkoutId: label, sourceHome: authSource });
    expect(fs.realpathSync(path.join(state.stateHome, 'devin/credentials.toml'))).toBe(credential);
    return { workspace, config, env: { PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`, HOME: process.env.NEXUS_TEST_DEVIN_NATIVE_HOME === '1' ? nativeHome : home, TMPDIR: tmp,
      XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'), ...state.env, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } };
  }

  try {
    const roster = privateEnv('roster');
    const models = await launch(roster.workspace, ['--config', roster.config, 'models', 'list'], roster.env);
    receipt.roster = { exitCode: models.exitCode, timedOut: models.timedOut };
    const rosterTokens = new Set(models.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []);
    const offered = (adapter.models?.list ?? []).filter(model => rosterTokens.has(model));
    const selected = offered.find(model => /flash.*medium/.test(model)) ?? offered.find(model => /flash/.test(model)) ?? offered[0];
    receipt.selectedModel = selected ?? null; receipt.nativeDefaultModel = !selected;
    for (const scheduled of process.env.NEXUS_TEST_DEVIN_PHASES === 'scheduled' ? [true] : [false, true]) {
      const phase = scheduled ? 'scheduled' : 'baseline', prepared = privateEnv(phase);
      fs.writeFileSync(path.join(prepared.workspace, 'Makefile'), 'all:\n\t@node -e "process.stdout.write(\'ACTUAL_DEVIN_NODE_DONE\\n\')" > command-ran\n');
      let pid = 0, alive = true, stopCalls = 0; const identity = {}, admissions: Record<string, unknown>[] = [], transitions: string[] = [];
      const claims = new Map<string, { pid: number; lastState: string; target: string }>(), pending = new Set<Promise<unknown>>();
      const scope = { version: 1 as const, installationId: 'private-devin', projectId: 'devin', checkoutId: phase, rootRealPath: prepared.workspace, identitySource: 'manifest' as const };
      const ctx = { token: `private-${randomUUID()}`, sessionId: `private-${phase}`, role: 'user', scope } as AgentGateContext;
      const proof = new OwnedCommandProcesses(id => id === ctx.sessionId && pid && alive ? { pid, identity } : null, undefined, p => watchDarwinHeavyCommand(runtime, p));
      const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
      const native = new NativeHeavyCommands({ current: () => alive, claim: async (id, p, kind) => {
        const claim = kind === 'darwin-job' && p !== pid ? await proof.claim(id, p, kind) : null;
        if (claim) {
          let target = 'redacted';
          if (await proof.probe(id, claim) === 'live') {
            try {
              const raw = execFileSync('/bin/ps', ['-p', String(p), '-o', 'command=', '-ww'], { encoding: 'utf8', timeout: 1000, maxBuffer: 32768 });
              const tail = raw.split(/\s--\s/).at(-1)?.trim().split(/\s+/) ?? [];
              const file = path.basename(tail[0] ?? '');
              if (['node', 'npm', 'npx', 'sh', 'bash', 'zsh', 'make', 'perl'].includes(file)) target = file;
              const packages = raw.match(/@[a-z0-9_-]+\/[a-z0-9_-]*mcp[a-z0-9_-]*/gi) ?? [];
              if (packages.length) target += `:${packages.join(',')}`;
              if (raw.includes('/usr/bin/make -f Makefile')) target += ':finite-Make-command';
              // Private diagnostic: path basenames only, long values and URLs redacted.
              target += ` argv=[${tail.slice(0, 5).map(token => token.includes('://') ? '<url>' : token.length > 48 ? '<long>' : token.includes('/') ? `…/${path.basename(path.dirname(token))}/${path.basename(token)}` : token).join(' ')}]`;
            } catch { /* Diagnostics never supply ownership proof. */ }
            if (await proof.probe(id, claim) !== 'live') target = 'changed-before-diagnostic';
          }
          claims.set(claim, { pid: p, lastState: 'live', target });
        }
        return claim;
      }, probe: async (id, claim) => { const state = await proof.probe(id, claim); const row = claims.get(claim); if (row) row.lastState = state; return state; },
        borrow: (id, claim, p) => proof.borrow(id, claim, p), stop: (id, claim) => { stopCalls += 1; return proof.stop(id, claim); },
        acquire: async request => { const permit = await pool.acquire(request); transitions.push('grant'); return { id: permit.id, release() { transitions.push('release'); permit.release(); } }; } });
      const sockets = new Set<import('node:net').Socket>();
      const server = http.createServer((req, res) => {
        req.setTimeout(3000, () => req.destroy()); let raw = '', bytes = 0;
        req.on('data', data => { bytes += data.length; if (bytes > 4096) req.destroy(); else raw += data; });
        req.on('end', () => {
          if (req.url !== '/hook/heavy-command' || req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(403); res.end(); return; }
          try {
            const body = JSON.parse(raw), row: Record<string, unknown> = { pid: body.pid, kind: body.kind, proof: body.proof, leaseId: body.leaseId }; admissions.push(row);
            // The physical CLI deadline bounds queued response work; the read
            // deadline must not abort a normal pending Main admission.
            req.setTimeout(0); res.socket?.setTimeout(0);
            const flight = native.admit(ctx, body).then(value => { row.result = value; res.end(JSON.stringify(value)); }, () => { row.result = { allow: false, reason: 'fixture_admit_rejected' }; res.writeHead(500); res.end(); });
            pending.add(flight); void flight.finally(() => pending.delete(flight));
          }
          catch { res.writeHead(422); res.end(); }
        });
      });
      server.maxConnections = 8; server.setTimeout(3000, socket => socket.destroy()); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
      if (scheduled) Object.assign(prepared.env, { NODE_OPTIONS: `--require ${JSON.stringify(path.join(resources, 'preload.cjs'))}`, NEXUS_HEAVY_AGENT_ENTRY: fs.realpathSync(devin),
        NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token,
        NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'), BASH_ENV: path.join(resources, 'shell.bash'), ZDOTDIR: resources });
      try {
        const prompt = 'Execute exactly once NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile" in the current private workspace, then reply DONE only. The Makefile is prepared. Do not inspect files, edit anything, invoke other commands, use subagents, or do any other task.';
        const result = await launch(prepared.workspace, ['--config', prepared.config, ...buildControlArgs(adapter, {}), '--respect-workspace-trust', 'false', ...(selected ? ['--model', selected] : []), '--print', prompt], prepared.env, value => { pid = value; });
        alive = false;
        const endWait = Date.now() + 3000;
        while ((pending.size || pool.snapshot().active || pool.snapshot().waiting || [...claims.values()].some(value => value.lastState !== 'gone')) && Date.now() < endWait) await new Promise(resolve => setTimeout(resolve, 25));
        const naturalMainClaimsGone = pending.size === 0 && pool.snapshot().active === 0 && pool.snapshot().waiting === 0 && [...claims.values()].every(value => value.lastState === 'gone');
        await native.drain();
        const marker = fs.existsSync(path.join(prepared.workspace, 'command-ran')) ? fs.readFileSync(path.join(prepared.workspace, 'command-ran'), 'utf8') : null;
        (receipt.phases as unknown[]).push({ phase, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, marker, admissions, transitions,
          naturalMainClaimsGone, stopCalls, claims: [...claims.values()], originalHome: prepared.env.HOME === nativeHome,
          responsibilityUnknown: result.output.includes('responsibility inventory incomplete'), outputBytes: Buffer.byteLength(result.output),
          failureClasses: ['Permission denied', 'Operation not permitted', 'Login canceled', 'Timed out verifying account status', 'Failed to verify account membership', 'Not logged in', 'unexpected argument', 'a subcommand is required', 'insufficient credits', 'rate limit', 'quota'].filter(value => result.output.includes(value)) });
        expect(result.timedOut).toBe(false); expect(result.exitCode).toBe(0); expect(naturalMainClaimsGone).toBe(true); expect(stopCalls).toBe(0); expect(marker).toBe('ACTUAL_DEVIN_NODE_DONE\n');
        if (scheduled) { expect(admissions.some(a => a.proof === 'darwin-job')).toBe(true); expect(transitions).toEqual(['grant', 'release']); }
        else expect(admissions).toEqual([]);
        expect(result.output).not.toContain('responsibility inventory incomplete');
      } finally { alive = false; await native.drain(); pool.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  } finally {
    receipt.nativeCredentialStatUnchanged = JSON.stringify(statIdentity(credential)) === JSON.stringify(credentialBefore);
    fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
    expect(receipt.nativeCredentialStatUnchanged).toBe(true);
  }
}, 130_000);
