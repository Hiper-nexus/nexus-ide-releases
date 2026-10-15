import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const traces = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../observability/main-trace', () => ({ trace: (event: Record<string, unknown>) => traces.push(event) }));
import { testProjectScope } from './__tests__/scope-fixture';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import { NativeHeavyCommands } from './native-heavy-command';
import { sameRepositoryExecutionRoot } from './nested-worktree-execution';
import type { AgentGateContext } from './gate';

// F-1229: um pane rodou 7 subagentes, cada um na SUA worktree do mesmo repo.
// Todos herdam o token do pane, e a fila de comando pesado era a raiz do token
// (o checkout): os testes de worktrees diferentes ficaram em fila única e quem
// passou de 300 s saiu com exit 74 "local admission request failed".
const require = createRequire(import.meta.url);
const catalog = require('../../../resources/heavy-command/catalog.cjs') as { leadingCd(command: string): string | null };
const resources = path.resolve('resources/heavy-command');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

let temp: string, root: string, wt1: string, wt2: string, foreign: string, plain: string, unregistered: string;
beforeAll(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-lane-')));
  root = path.join(temp, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, '-c', 'user.name=Nexus', '-c', 'user.email=nexus@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
  wt1 = path.join(temp, 'wt1'); wt2 = path.join(temp, 'wt2');
  git(root, 'worktree', 'add', '-q', '-b', 'lane/w1', wt1);
  git(root, 'worktree', 'add', '-q', '-b', 'lane/w2', wt2);
  for (const dir of [wt1, wt2]) fs.mkdirSync(path.join(dir, 'src'));
  foreign = path.join(temp, 'foreign'); fs.mkdirSync(foreign); git(foreign, 'init', '-q');
  plain = path.join(temp, 'plain'); fs.mkdirSync(plain);
  // F-1235: um `.git` arquivo apontando para o repositório tem o mesmo
  // git-common-dir, mas não é worktree registrada (`git worktree list`).
  unregistered = path.join(temp, 'unregistered'); fs.mkdirSync(unregistered);
  fs.writeFileSync(path.join(unregistered, '.git'), `gitdir: ${path.join(root, '.git')}\n`);
});
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

/** One pane token: every subagent of the pane presents this same context. */
const pane = () => ({ token: 'pane-token', sessionId: 'pane-session', role: 'user', scope: testProjectScope({ rootRealPath: root }) }) as AgentGateContext;

function harness(waitMs: number) {
  const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 64_000, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }),
    refreshMemory: async () => {}, pollMs: 10, waitMs, maxActive: 4 });
  const gone = new Set<string>(); const lanes: string[] = []; let closing = false;
  const native = new NativeHeavyCommands({ current: () => true, claim: async (_session, pid) => `claim-${pid}`,
    probe: async (_session, claim) => closing || gone.has(claim) ? 'gone' : 'live',
    acquire: (request) => { lanes.push(request.scope.rootRealPath); return pool.acquire(request); },
    executionRoot: sameRepositoryExecutionRoot });
  return { pool, native, gone, lanes, close: async () => { closing = true; await native.drain(); pool.close(); } };
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

describe('F-1229: a fila de comando pesado é a raiz Git real do job', () => {
  it('o mesmo token em worktrees diferentes do mesmo repositório (e no checkout) roda junto', async () => {
    const h = harness(400); const ctx = pane();
    try {
      const results = await Promise.all([
        h.native.admit(ctx, { pid: 101, kind: 'tests', cwd: wt1 }),
        h.native.admit(ctx, { pid: 102, kind: 'tests', cwd: path.join(wt2, 'src') }),
        h.native.admit(ctx, { pid: 103, kind: 'tests', cwd: root }),
      ]);
      expect(results.map((result) => result.allow)).toEqual([true, true, true]);
      expect(h.pool.snapshot().active).toBe(3);
      expect([...h.lanes].sort()).toEqual([root, wt1, wt2].sort());
    } finally { await h.close(); }
  });

  it('ponta a ponta: request.cjs de duas worktrees com o mesmo token recebe duas licenças ao mesmo tempo', async () => {
    const h = harness(2_000); const ctx = pane();
    const server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (part) => { raw += part; });
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
        void h.native.admit(ctx, JSON.parse(raw)).then((result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook/heavy-command`;
    const request = (cwd: string, pid: number) => new Promise<{ code: number | null; lease: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(resources, 'request.cjs'), String(pid), 'tests'], {
        cwd, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', NEXUS_HEAVY_COMMAND_URL: url, NEXUS_GATE_TOKEN: ctx.token },
      });
      let lease = ''; child.stdout!.on('data', (data) => { lease += data; });
      child.once('close', (code) => resolve({ code, lease }));
    });
    try {
      // Antes: as duas caíam na fila do checkout do token; a segunda esperava
      // até o prazo e saía 78 (o supervisor transforma em 74).
      const [first, second] = await Promise.all([request(wt1, 4101), request(path.join(wt2, 'src'), 4102)]);
      expect([first.code, second.code]).toEqual([0, 0]);
      expect(first.lease).not.toBe(''); expect(second.lease).not.toBe(first.lease);
      expect([...h.lanes].sort()).toEqual([wt1, wt2].sort());
    } finally { server.close(); await h.close(); }
  });

  it('os mesmos pedidos na mesma raiz serializam: o segundo só entra quando o primeiro sai', async () => {
    const h = harness(10_000); const ctx = pane();
    try {
      expect((await h.native.admit(ctx, { pid: 201, kind: 'tests', cwd: wt1 })).allow).toBe(true);
      let admitted = false;
      const second = h.native.admit(ctx, { pid: 202, kind: 'tests', cwd: path.join(wt1, 'src') }).then((result) => { admitted = true; return result; });
      await until(() => h.pool.snapshot().waiting === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(admitted).toBe(false);
      h.gone.add('claim-201');
      expect(await second).toMatchObject({ allow: true });
      expect(h.lanes).toEqual([wt1, wt1]);
    } finally { await h.close(); }
  });

  it('raiz fora do repositório (outro repo, pasta sem Git, inexistente, relativa) cai na lane do token; o 74 diz que foi fila', async () => {
    const h = harness(300); const ctx = pane();
    try {
      expect((await h.native.admit(ctx, { pid: 301, kind: 'tests', cwd: root })).allow).toBe(true);
      const outside = [foreign, plain, path.join(temp, 'missing'), 'relative/dir'];
      const results = await Promise.all(outside.map((cwd, index) => h.native.admit(ctx, { pid: 310 + index, kind: 'tests', cwd })));
      expect(h.lanes).toEqual([root, root, root, root, root]);
      for (const result of results) expect(result).toMatchObject({ allow: false, reason: 'heavy_command_wait_timeout' });
      expect(results[0]!.message).toMatch(/^nexus-heavy: gave up after \d+ s in the admission queue of .+: 1 job\(s\) running there, \d+ more waiting \(one job per root at a time\); machine 1\/4 heavy jobs running\.$/);
      expect(results[0]!.message).toContain(root);
    } finally { await h.close(); }
  });
});

describe('F-1235: a lane declarada pelo pedido só vale para raiz registrada e fica no trace', () => {
  it('raiz com o mesmo git-common-dir que não é worktree registrada cai na lane do token', async () => {
    expect(git(unregistered, 'rev-parse', '--show-toplevel')).toBe(unregistered);
    expect(await sameRepositoryExecutionRoot(testProjectScope({ rootRealPath: root }), unregistered)).toBeUndefined();
    expect((await sameRepositoryExecutionRoot(testProjectScope({ rootRealPath: root }), wt1))?.rootRealPath).toBe(wt1);
    const h = harness(400); const ctx = pane();
    try {
      expect((await h.native.admit(ctx, { pid: 501, kind: 'tests', cwd: unregistered })).allow).toBe(true);
      expect(h.lanes).toEqual([root]);
    } finally { await h.close(); }
  });

  it('o trace do Main registra a raiz e o pid quando a lane difere da do token', async () => {
    const h = harness(400); const ctx = pane(); traces.length = 0;
    try {
      expect((await h.native.admit(ctx, { pid: 601, kind: 'tests', cwd: path.join(wt1, 'src') })).allow).toBe(true);
      expect((await h.native.admit(ctx, { pid: 602, kind: 'tests', cwd: root })).allow).toBe(true);
      expect(traces.filter((event) => event.kind === 'heavy-command-lane'))
        .toEqual([{ kind: 'heavy-command-lane', sessionId: 'pane-session', pid: 601, root: wt1, paneRoot: root }]);
    } finally { await h.close(); }
  });
});

describe('F-1229: o cwd chega ao Main pelo próprio pedido', () => {
  it('leadingCd só nomeia o alvo literal de um cd inicial', () => {
    expect(catalog.leadingCd('cd /wt && node node_modules/vitest/vitest.mjs run x.test.ts')).toBe('/wt');
    expect(catalog.leadingCd("cd '/a b'; npm test")).toBe('/a b');
    expect(catalog.leadingCd('cd ../wt && npm test')).toBe('../wt');
    for (const command of ['npm test', 'cd && npm test', 'cd - && npm test', 'cd ~/wt && npm test', 'cd "$WT" && npm test', 'cd -P /wt && npm test', 'echo cd /wt && npm test']) {
      expect(catalog.leadingCd(command)).toBeNull();
    }
  });

  it('job-launch passa ao job o diretório do cd inicial e descarta uma dica herdada', async () => {
    const run = (command: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(resources, 'job-launch.cjs'), 'tests', '/bin/sh', '-c', command], {
        cwd: temp, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', NEXUS_HEAVY_CWD: '/stale', NEXUS_HEAVY_JOB_BASE: JSON.stringify({ file: '/usr/bin/perl', args: ['-e', 'print $ENV{NEXUS_HEAVY_CWD} // "unset"', 'heavy-job'] }) },
      });
      let output = ''; child.stdout!.on('data', (data) => { output += data; }); child.stderr!.resume();
      child.once('error', reject); child.once('close', () => resolve(output));
    });
    expect(await run(`cd ${wt1} && npm test`)).toBe(wt1);
    expect(await run('cd wt2 && npm test')).toBe(wt2);
    expect(await run('npm test')).toBe('unset');
  });

  it('job-launch exits with the direct child while a grandchild still holds stdout', async () => {
    const marker = path.join(temp, 'grandchild.pid');
    const script = path.join(temp, 'grandchild.pl');
    fs.writeFileSync(script, `if (fork()) { exit 9 } else { open my $f, '>', ${JSON.stringify(marker)}; print $f $$; close $f; sleep 30; exit 0 }\n`);
    const started = Date.now();
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(resources, 'job-launch.cjs'), 'build', '/usr/bin/perl', script], {
        cwd: temp, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', NEXUS_HEAVY_JOB_BASE: JSON.stringify({ file: '/usr/bin/perl', args: ['-e', 'while (@ARGV && $ARGV[0] ne "--") { shift @ARGV } shift @ARGV; exec @ARGV or die $!', 'heavy-job'] }) },
      });
      child.stdout!.resume(); child.stderr!.resume();
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('job-launch still alive after the direct child exited')); }, 2_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ code: 9, signal: null });
    const deadline = Date.now() + 500;
    let pid = 0;
    while (Date.now() < deadline && !pid) {
      try { pid = Number(fs.readFileSync(marker, 'utf8')); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    if (pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
  });

  // pthread_get_qos_class_np: QOS_CLASS_UTILITY is 0x11 under taskpolicy -c utility.
  let priorityProbeSequence = 0;
  const darwinPriority = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ qos: string; clamps: string[][] }>((resolve, reject) => {
    const trace = path.join(temp, `qos-${++priorityProbeSequence}.jsonl`);
    const preload = path.join(temp, `qos-${priorityProbeSequence}.cjs`);
    // Observe the entrypoint's actual spawn, without rewriting any shipped
    // resource. Background QoS alone cannot distinguish a missing wrapper.
    fs.writeFileSync(preload, `const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function(file, args, options) {
  if (file === '/usr/sbin/taskpolicy') require('node:fs').appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args.slice(0, 2)) + '\\n');
  return spawn.call(this, file, args, options);
};\n`);
    const child = spawn(process.execPath, ['--require', preload, ...args], { cwd: temp, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '', err = '';
    child.stdout!.on('data', (data) => { output += data; });
    child.stderr!.on('data', (data) => { err += data; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`priority probe hung: ${err}`)); }, 8_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}: ${err || output}`));
      else {
        try {
          const clamps = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [];
          resolve({ qos: output.trim(), clamps });
        } catch (error) { reject(error); }
      }
    });
  });
  const probe = [
      'import ctypes',
      'libc=ctypes.CDLL("/usr/lib/libSystem.B.dylib")',
      'fn=libc.pthread_get_qos_class_np',
      'fn.restype=ctypes.c_int',
      'fn.argtypes=[ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_int)]',
      'self=libc.pthread_self',
      'self.restype=ctypes.c_void_p',
      'self.argtypes=[]',
      'qos=ctypes.c_uint(); rel=ctypes.c_int()',
      'fn(self(), ctypes.byref(qos), ctypes.byref(rel))',
      'print(hex(qos.value))',
    ].join('; ');
  // A launchd Background job inherits a stricter class (0x9). Compare with
  // taskpolicy itself under the SAME process policy, not a foreground literal.
  const referencePriority = (utility: boolean) => execFileSync(
    utility ? '/usr/sbin/taskpolicy' : '/usr/bin/python3',
    [...(utility ? ['-c', 'utility', '/usr/bin/python3'] : []), '-c', probe],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
  ).trim();

  it('requests the utility clamp explicitly and leaves the opt-out command intact', () => {
    if (process.platform !== 'darwin') return;
    const policy = require('../../../resources/heavy-command/qos.cjs') as {
      spawnBackground(cp: { spawn: (...args: unknown[]) => unknown }, file: string, args: string[], options: object): unknown;
    };
    const spawnJob = vi.fn();
    const options = { env: { PATH: '/usr/bin:/bin' }, stdio: 'inherit' };
    const before = process.env.NEXUS_HEAVY_QOS;
    try {
      delete process.env.NEXUS_HEAVY_QOS;
      policy.spawnBackground({ spawn: spawnJob }, '/usr/bin/python3', ['-c', probe], options);
      expect(spawnJob).toHaveBeenLastCalledWith('/usr/sbin/taskpolicy', ['-c', 'utility', '/usr/bin/python3', '-c', probe], options);
      process.env.NEXUS_HEAVY_QOS = '0';
      policy.spawnBackground({ spawn: spawnJob }, '/usr/bin/python3', ['-c', probe], options);
      expect(spawnJob).toHaveBeenLastCalledWith('/usr/bin/python3', ['-c', probe], options);
    } finally {
      if (before === undefined) delete process.env.NEXUS_HEAVY_QOS;
      else process.env.NEXUS_HEAVY_QOS = before;
    }
  });

  const priorityJob = JSON.stringify({ file: '/usr/bin/perl', args: ['-e', 'while (@ARGV && $ARGV[0] ne "--") { shift @ARGV } shift @ARGV; exec @ARGV or die $!', 'heavy-job'] });

  it('job-launch runs the job at darwin utility QoS, unless NEXUS_HEAVY_QOS=0', async () => {
    if (process.platform !== 'darwin') return;

    const launch = (qos?: string) => darwinPriority(
      [path.join(resources, 'job-launch.cjs'), 'build', '/usr/bin/python3', '-c', probe],
      { PATH: '/usr/bin:/bin', ...(qos ? { NEXUS_HEAVY_QOS: qos } : {}), NEXUS_HEAVY_JOB_BASE: priorityJob },
    );
    const utility = referencePriority(true);
    expect(['0x9', '0x11']).toContain(utility);
    expect(await launch()).toEqual({ qos: utility, clamps: [['-c', 'utility']] });
    expect(await launch('0')).toEqual({ qos: referencePriority(false), clamps: [] });
  });

  it('dispatch runs the admitted job at darwin utility QoS', async () => {
    if (process.platform !== 'darwin') return;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ allow: true, leaseId: 'qos-lease' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {

      const priority = await darwinPriority(
        [path.join(resources, 'dispatch.cjs'), 'build', '/usr/bin/python3', JSON.stringify(['-c', probe]), 'false'],
        { PATH: '/usr/bin:/bin', NEXUS_GATE_TOKEN: 'finite-qos', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command` },
      );
      const utility = referencePriority(true);
      expect(['0x9', '0x11']).toContain(utility);
      expect(priority).toEqual({ qos: utility, clamps: [['-c', 'utility']] });
    } finally { server.close(); }
  }, 10_000);

  it('request.cjs envia o cwd do job (ou a dica do darwin-job) e imprime o motivo do Main', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const message = 'nexus-heavy: gave up after 300 s in the admission queue of /repo: 1 job(s) running there, 5 more waiting';
    const server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (part) => { raw += part; });
      req.on('end', () => { bodies.push(JSON.parse(raw)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ allow: false, reason: 'heavy_command_wait_timeout', message })); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook/heavy-command`;
    const request = (cwd: string, extra: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(resources, 'request.cjs'), String(process.pid), 'tests', ...extra], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', NEXUS_HEAVY_COMMAND_URL: url, NEXUS_GATE_TOKEN: 'fixture', ...env },
      });
      let stderr = ''; child.stderr!.on('data', (data) => { stderr += data; }); child.stdout!.resume();
      child.once('close', (code) => resolve({ code, stderr }));
    });
    try {
      const [own, hinted] = await Promise.all([request(wt1, []), request(temp, ['darwin-job'], { NEXUS_HEAVY_CWD: wt2 })]);
      expect(own).toEqual({ code: 78, stderr: `${message}\n` });
      expect(hinted.code).toBe(78);
      expect(bodies.map((body) => body.cwd).sort()).toEqual([wt1, wt2].sort());
    } finally { server.close(); }
  });
});
