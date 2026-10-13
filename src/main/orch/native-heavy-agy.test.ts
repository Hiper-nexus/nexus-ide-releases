import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, fork, spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, utilityProcess: { fork: () => { throw new Error('explicit Node test port required'); } } }));
import { createNativeHeavyLocalChannel } from './native-heavy-local-channel';
import { AGY_NATIVE_HEAVY_PLUGIN, ensureAgyNativeHeavyPlugin } from './native-heavy-agy-plugin';
import { NativeHeavyCommands } from './native-heavy-command';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import { watchDarwinHeavyCommand } from '../pty/darwin-heavy-command';
import { nestedHeavyJobBaseCommand, supervisedPtyCommand } from '../pty/darwin-pty-supervisor';
import { skipUnderNexusPtySupervisor } from '../../test/nested-pty-supervisor';
import type { AgentGateContext } from './gate';

// AGY 1.2.16 asked for a new login in a Main checkout HOME (F-567), so this
// proof runs where native auth already lives and touches only its own name.
const nativeHome = os.userInfo().homedir, gemini = path.join(nativeHome, '.gemini');
const agy = process.env.NEXUS_TEST_AGY_BIN ?? path.join(nativeHome, '.local/bin/agy');
const pluginDir = path.join(gemini, 'config/plugins', AGY_NATIVE_HEAVY_PLUGIN), sourceDir = path.join(nativeHome, '.nexus/agy-native-heavy-plugin');
const manifestFile = path.join(gemini, 'config/import_manifest.json');
const digest = (file: string) => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
const identity = (file: string) => { try { const s = fs.lstatSync(file); return [s.ino, s.size, s.mtimeMs, s.isSymbolicLink()]; } catch { return null; } };
/** Native AGY state the proof must leave untouched. Accounts: stat only, never read. */
function nativeSnapshot() {
  const plugins = path.join(gemini, 'config/plugins');
  return {
    plugins: JSON.stringify(fs.readdirSync(plugins).sort().map(name => [name, digest(path.join(plugins, name, 'plugin.json')), digest(path.join(plugins, name, 'hooks.json'))])),
    manifest: digest(manifestFile), config: digest(path.join(gemini, 'config/config.json')),
    accounts: JSON.stringify(['oauth_creds.json', 'google_accounts.json', 'jetski-standalone-oauth-token', 'antigravity-cli/antigravity-oauth-token', 'installation_id'].map(file => [file, identity(path.join(gemini, file))])),
  };
}
const agyEnv = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: nativeHome, USER: os.userInfo().username, LOGNAME: os.userInfo().username,
  SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', AGY_CLI_DISABLE_AUTO_UPDATE: '1', ...extra });

// Explicit opt-in: ordinary suites never run authenticated inference.
it.runIf(process.platform === 'darwin' && process.env.NEXUS_TEST_AGY_AUTHENTICATED === '1' && fs.existsSync(agy))('actual authenticated AGY global plugin admits heavy commands through the file channel', async (testContext) => {
  skipUnderNexusPtySupervisor(testContext);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-plugin-proof-')));
  console.log(`owned AGY evidence: ${root}`);
  // Install/uninstall only the exclusive name, and only when nothing owns it yet.
  expect(fs.existsSync(pluginDir) || fs.existsSync(sourceDir)).toBe(false);
  const nativeBefore = nativeSnapshot(), manifestExisted = fs.existsSync(manifestFile);
  const helper = path.join(root, 'resources/native/darwin/nexus-pty-supervisor');
  execFileSync(process.execPath, ['scripts/build-darwin-pty-supervisor.mjs', '--output', helper], { stdio: 'ignore' });
  fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), path.join(root, 'heavy-command'), { recursive: true });
  const resources = fs.realpathSync(path.join(root, 'heavy-command')), node = fs.realpathSync(process.execPath);
  const runtime = { platform: 'darwin' as const, packaged: false, cwd: root, moduleDir: root };
  const trace = path.join(root, 'hook-trace.jsonl');
  // Observe the installed hook without changing it: the plugin's Node path is
  // a regular wrapper that records the transformer's stdout, then returns it.
  const hookNode = (label: string) => {
    const file = path.join(root, `hook-node-${label}`);
    fs.writeFileSync(file, `#!/bin/sh\nout=$('${node}' "$@"); status=$?\nprintf '%s\\n' "$out" >> '${trace}'\nprintf '%s' "$out"\nexit $status\n`, { mode: 0o755 });
    return file;
  };
  const receipt: Record<string, unknown> = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    agyVersion: execFileSync(agy, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'version-home'), AGY_CLI_DISABLE_AUTO_UPDATE: '1' }, timeout: 20_000 }).trim(),
    physicalCeilingMs: 30_000, phases: [] };
  fs.rmSync(path.join(root, 'version-home'), { recursive: true, force: true });

  // shellHooks=false isolates the plugin: without Nexus BASH_ENV/ZDOTDIR the
  // existing shell route cannot admit, so any admission comes from the hook.
  async function phase(name: string, scheduled: boolean, shellHooks = false) {
    const dir = path.join(root, name), workspace = path.join(dir, 'workspace'), privateTmp = path.join(dir, 'tmp');
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 }); fs.mkdirSync(privateTmp, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.name', 'Private Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    // The marker carries only how many channel variables the target saw.
    fs.writeFileSync(path.join(workspace, 'Makefile'), 'all:\n\t@n=0; for v in "$$NEXUS_HEAVY_CHANNEL_DIR" "$$NEXUS_HEAVY_CHANNEL_KEY" "$$NEXUS_HEAVY_CHANNEL_EPOCH" "$$NEXUS_HEAVY_CHANNEL_PUBLIC_KEY"; do [ -n "$$v" ] && n=$$((n+1)); done; printf "done:%s" "$$n" > command-ran\n');
    git('add', 'Makefile'); git('commit', '-qm', 'Private AGY fixture');
    const marker = path.join(workspace, 'command-ran');
    const scope = { version: 1 as const, installationId: 'private-agy', projectId: 'agy', checkoutId: name, rootRealPath: workspace, identitySource: 'manifest' as const };
    const ctx = { token: `private-${randomUUID()}`, sessionId: `private-agy-${name}`, role: 'user', scope } as AgentGateContext;
    let cliPid = 0, cliAlive = true, stopCalls = 0;
    const owner = {}, admissions: Array<Record<string, unknown>> = [], transitions: string[] = [], claimed: number[] = [], pending = new Set<Promise<unknown>>();
    const checks: Record<string, boolean> = {};
    const proof = new OwnedCommandProcesses(id => id === ctx.sessionId && cliPid && cliAlive ? { pid: cliPid, identity: owner } : null, undefined, pid => watchDarwinHeavyCommand(runtime, pid));
    const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
    const native = new NativeHeavyCommands({ current: () => cliAlive,
      claim: async (id, pid, kind) => { const claim = kind === 'darwin-job' ? await proof.claim(id, pid, kind) : null; if (claim) claimed.push(pid); return claim; },
      probe: (id, claim) => proof.probe(id, claim), borrow: (id, claim, pid) => proof.borrow(id, claim, pid), stop: (id, claim) => { stopCalls++; return proof.stop(id, claim); },
      acquire: async request => {
        const permit = await pool.acquire(request); checks.markerAbsentAtGrant = !fs.existsSync(marker); transitions.push('grant');
        return { id: permit.id, release: () => {
          checks.markerPresentAtRelease = fs.existsSync(marker);
          // Gone or an unreaped zombie: no instruction of the job can run.
          checks.jobGoneAtRelease = claimed.length > 0 && claimed.every(pid => { try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 2000 }).trim().startsWith('Z'); } catch { return true; } });
          transitions.push('release'); permit.release();
        } };
      } });
    // Loopback Main URL required by the hook's context check. With the file
    // channel no admission may arrive here over TCP.
    let tcpHits = 0; const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((req, res) => { tcpHits++; req.resume(); res.writeHead(403); res.end(); });
    server.maxConnections = 8; server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
    const channel = scheduled ? await createNativeHeavyLocalChannel(ctx, privateTmp, { current: () => cliAlive,
      admit: (context, body, signal) => {
        const row: Record<string, unknown> = { kind: (body as { kind?: unknown }).kind, proof: (body as { proof?: unknown }).proof, lease: typeof (body as { leaseId?: unknown }).leaseId === 'string' };
        admissions.push(row);
        const flight = native.admit(context, body, signal).then(result => { row.allow = result.allow; return result; }); pending.add(flight); void flight.finally(() => pending.delete(flight)).catch(() => {});
        return flight;
      },
      drainContext: context => native.drainContext(context), spawn: (entry, cwd, transport) => {
        const child = fork(entry, transport === 'file' ? ['--file'] : [], { cwd, execPath: process.execPath, execArgv: [], env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        return { on: (event, callback) => child.on(event, callback), postMessage: message => { child.send(message as Parameters<typeof child.send>[0]); }, kill: () => child.kill() };
      } }, { transport: 'file' }) : undefined;
    const env: Record<string, string> = agyEnv({ TMPDIR: privateTmp });
    if (scheduled) Object.assign(env, channel!.env, { NEXUS_GATE_TOKEN: ctx.token, NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`,
      NEXUS_HEAVY_JOB_BASE: JSON.stringify(nestedHeavyJobBaseCommand(runtime)), NEXUS_HEAVY_NODE: node, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl',
      ...(shellHooks ? { NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash'), BASH_ENV: path.join(resources, 'shell.bash'), ZDOTDIR: resources } : {}),
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(resources, 'preload.cjs'))}` });
    const traceStart = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').length : 0;
    const prompt = 'In the current workspace, use run_command to execute exactly /usr/bin/make -f Makefile. Wait for completion. Do not use MCP or other tools. Reply only done.';
    const launch = supervisedPtyCommand(runtime, agy, ['--dangerously-skip-permissions', '--print-timeout', '20s', '--output-format', 'json', '--log-file', path.join(dir, 'agy.log'), '--print', prompt]);
    const started = Date.now();
    const child = spawn(launch.file, launch.args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    cliPid = child.pid!; let output = '', bytes = 0, timedOut = false;
    const keep = (part: Buffer) => { bytes += part.length; output = (output + part.toString('utf8')).slice(-65536); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => { cliAlive = false; resolve({ code, signal }); }));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 30_000);
    try {
      const result = await exit; clearTimeout(timer);
      const settle = Date.now() + 3000;
      while ((pending.size || pool.snapshot().active || pool.snapshot().waiting) && Date.now() < settle) await new Promise(resolve => setTimeout(resolve, 25));
      await native.drain();
      const decisions = (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').slice(traceStart) : '').split('\n').filter(Boolean).map(line => {
        try { const value = JSON.parse(line); const command = value.overwrite?.CommandLine;
          return { decision: value.decision, overwrite: value.overwrite ? Object.keys(value.overwrite) : null, launcher: typeof command === 'string' && command.includes(`${resources}/job-launch.cjs`), kind: typeof command === 'string' ? command.match(/job-launch\.cjs' '([a-z]+)'/)?.[1] ?? null : null }; }
        catch { return { decision: 'unparsed' }; }
      });
      const row = { phase: name, shellHooks, exit: result, timedOut, durationMs: Date.now() - started, marker: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null,
        hookDecisions: decisions, admissions, transitions, checks, stopCalls, tcpHits, outputBytes: bytes,
        failureClasses: ['Authentication required', 'not authenticated', 'Not logged in', 'sign in', 'Permission denied', 'Operation not permitted', 'Physical CPU/RAM admission', 'heavy-command admission', 'quota', 'rate limit', 'timed out', 'deadline'].filter(value => output.toLowerCase().includes(value.toLowerCase())) };
      (receipt.phases as unknown[]).push(row);
      return row;
    } finally {
      clearTimeout(timer); if (cliAlive) child.kill('SIGTERM'); await exit; cliAlive = false;
      await native.drain(); pool.close(); await channel?.dispose();
      for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
      // AGY's own output is personal: never printed. Only a failed phase keeps
      // it, owner-only, beside the receipt for local diagnosis.
      if (fs.existsSync(marker) && !timedOut) fs.rmSync(path.join(dir, 'agy.log'), { force: true });
      else fs.writeFileSync(path.join(dir, 'output.private'), output, { mode: 0o600 });
    }
  }

  try {
    // (0) RED control: gate token, file channel and job base, but neither the
    // plugin nor shell hooks. The heavy command runs without admission.
    const control = await phase('unadmitted', true);
    // (a) Outside Nexus: plugin installed by the real CLI, no gate token.
    expect(await ensureAgyNativeHeavyPlugin({ home: nativeHome, agyBin: agy, node: hookNode('a'), resourceDirectory: resources })).toEqual({ registered: true });
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { imports: Array<{ name: string; source: string; components: string[]; importedAt: string }> };
    const ours = manifest.imports.filter(entry => entry.name === AGY_NATIVE_HEAVY_PLUGIN);
    receipt.cliManifestEntry = ours.map(entry => ({ name: entry.name, source: entry.source, components: entry.components }));
    receipt.cliPluginFiles = fs.readdirSync(pluginDir).sort();
    const baseline = await phase('baseline', false);
    // (b) Inside Nexus: a new Node path exercises the owned hooks.json update
    // without another CLI installation.
    expect(await ensureAgyNativeHeavyPlugin({ home: nativeHome, agyBin: agy, node: hookNode('b'), resourceDirectory: resources })).toEqual({ registered: true });
    receipt.updateWithoutReinstall = (JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as typeof manifest).imports.find(entry => entry.name === AGY_NATIVE_HEAVY_PLUGIN)?.importedAt === ours[0]?.importedAt &&
      fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8').includes('hook-node-b');
    const scheduled = await phase('scheduled', true);
    // (c) Production environment: plugin plus shell hooks admit exactly once.
    const production = await phase('scheduled-with-shell-hooks', true, true);

    expect(receipt.cliManifestEntry).toEqual([{ name: AGY_NATIVE_HEAVY_PLUGIN, source: 'antigravity', components: ['hooks'] }]);
    expect(receipt.cliPluginFiles).toEqual(['hooks.json', 'plugin.json']);
    expect(receipt.updateWithoutReinstall).toBe(true);
    expect(control.timedOut).toBe(false); expect(control.exit).toEqual({ code: 0, signal: null });
    expect(control.hookDecisions).toEqual([]); expect(control.marker).toBe('done:4'); expect(control.admissions).toEqual([]); expect(control.transitions).toEqual([]);
    expect(baseline.timedOut).toBe(false); expect(baseline.exit).toEqual({ code: 0, signal: null });
    expect(baseline.marker).toBe('done:0'); expect(baseline.admissions).toEqual([]); expect(baseline.transitions).toEqual([]);
    expect(baseline.hookDecisions.length).toBeGreaterThan(0);
    expect(baseline.hookDecisions.every(value => value.decision === 'ask' && value.overwrite === null)).toBe(true);
    for (const admitted of [scheduled, production]) {
      expect(admitted.timedOut).toBe(false); expect(admitted.exit).toEqual({ code: 0, signal: null });
      expect(admitted.hookDecisions).toContainEqual({ decision: 'ask', overwrite: ['CommandLine'], launcher: true, kind: 'build' });
      expect(admitted.admissions.some(value => value.proof === 'darwin-job' && value.kind === 'build' && value.allow === true)).toBe(true);
      expect(admitted.transitions).toEqual(['grant', 'release']);
      expect(admitted.admissions.filter(value => value.proof === 'darwin-job')).toHaveLength(1);
      expect(admitted.checks).toEqual({ markerAbsentAtGrant: true, markerPresentAtRelease: true, jobGoneAtRelease: true });
      expect(admitted.marker).toBe('done:4'); expect(admitted.tcpHits).toBe(0); expect(admitted.stopCalls).toBe(0);
    }
  } finally {
    // Official uninstall of the exclusive name only, then only our own residue.
    if (fs.existsSync(path.join(pluginDir, 'plugin.json')) && JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')).name === AGY_NATIVE_HEAVY_PLUGIN) {
      try { execFileSync(agy, ['plugin', 'uninstall', AGY_NATIVE_HEAVY_PLUGIN], { cwd: root, env: agyEnv(), stdio: 'ignore', timeout: 20_000 }); receipt.uninstall = 'ok'; }
      catch { receipt.uninstall = 'failed'; }
    }
    fs.rmSync(sourceDir, { recursive: true, force: true });
    // AGY leaves `{"imports": null}` after removing the last import.
    if (!manifestExisted && fs.existsSync(manifestFile)) {
      const residue = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { imports?: unknown };
      if (residue.imports === null || Array.isArray(residue.imports) && residue.imports.length === 0) { fs.unlinkSync(manifestFile); receipt.manifestResidueRemoved = true; }
    }
    const nativeAfter = nativeSnapshot();
    receipt.nativeUnchanged = { plugins: nativeAfter.plugins === nativeBefore.plugins, manifest: nativeAfter.manifest === nativeBefore.manifest,
      config: nativeAfter.config === nativeBefore.config, accounts: nativeAfter.accounts === nativeBefore.accounts };
    receipt.nativeHasExclusivePlugin = fs.existsSync(pluginDir) || fs.existsSync(sourceDir);
    fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(`AGY receipt: ${path.join(root, 'receipt.json')}`);
  }
  expect(receipt.nativeUnchanged).toEqual({ plugins: true, manifest: true, config: true, accounts: true }); expect(receipt.nativeHasExclusivePlugin).toBe(false);
}, 240_000);
