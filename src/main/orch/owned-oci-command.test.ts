import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWindowsOciPlan, type ScopedShellPlan } from '../runtime/process-sandbox';
import { prepareOwnedOciCommand, type OwnedOciCommand } from './owned-oci-command';

interface KernelState {
  id: string;
  name: string;
  nonce: string;
  running: boolean;
  status: string;
  createArgs: string[];
}

// The fake engine persists independently of the attach client's process lifetime.
// This exercises real execFile/spawn/close events without pretending to prove Windows Docker.
const FAKE_DOCKER = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const stateFile = path.join(dir, 'kernel.json');
const controlFile = path.join(dir, 'control.json');
const args = process.argv.slice(2);
const control = fs.existsSync(controlFile) ? JSON.parse(fs.readFileSync(controlFile, 'utf8')) : {};
const read = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const write = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
const fail = () => { process.stderr.write('private command token=TEST_SECRET'); process.exit(1); };
if (control.transportError && args[0] !== 'create' && args[0] !== 'start') fail();
if (args[0] === 'create') {
  const name = args[args.indexOf('--name') + 1];
  const label = args[args.indexOf('--label') + 1];
  const state = { id: 'a'.repeat(64), name, nonce: label.slice(label.indexOf('=') + 1), running: false, status: 'created', createArgs: args };
  write(state);
  if (control.createError) fail();
  process.stdout.write(control.createOutput ?? state.id);
} else if (args[0] === 'start') {
  const state = read();
  if (!state || state.id !== args.at(-1)) fail();
  state.running = true; state.status = 'running'; write(state);
  process.stdout.write('started\\n');
  const timer = setInterval(() => { const state = read(); if (!state || !state.running) { clearInterval(timer); process.exit(0); } }, 15);
} else if (args[0] === 'container' && args[1] === 'ls') {
  const state = read();
  const filter = args[args.indexOf('--filter') + 1];
  if (state && (filter === 'id=' + state.id || filter.endsWith('=' + state.nonce))) process.stdout.write(state.id + '\\n');
  if (control.listOutput !== undefined) process.stdout.write(control.listOutput);
} else if (args[0] === 'container' && args[1] === 'inspect') {
  const state = read();
  if (!state || state.id !== args.at(-1)) fail();
  const values = [control.inspectId ?? state.id, '/' + (control.inspectName ?? state.name), control.inspectNonce ?? state.nonce, state.running, state.status];
  process.stdout.write(control.inspectOutput ?? values.map(value => JSON.stringify(value)).join('\\n'));
} else if (args[0] === 'container' && args[1] === 'stop') {
  const state = read();
  if (!state || state.id !== args.at(-1)) fail();
  if (control.stopError) fail();
  state.running = false; state.status = 'exited'; write(state);
} else if (args[0] === 'container' && args[1] === 'rm') {
  const state = read();
  if (!state || state.id !== args.at(-1) || state.running || control.removeError) fail();
  fs.unlinkSync(stateFile);
} else fail();
`;

const fixtures: Array<{ dir: string; owned?: OwnedOciCommand; proc?: ChildProcess }> = [];

function fixture(control: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-owned-oci-test-'));
  const checkout = path.join(dir, 'checkout');
  const runtime = path.join(dir, 'runtime');
  fs.mkdirSync(checkout);
  fs.mkdirSync(runtime);
  const file = path.join(dir, 'fake-docker');
  fs.writeFileSync(file, FAKE_DOCKER, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(control));
  const plan = buildWindowsOciPlan({
    platform: 'win32', executable: '/bin/sh', args: ['-c', 'TEST_SECRET build'],
    cwd: checkout, rootRealPath: checkout, sandboxDir: runtime,
    env: { PATH: process.env.PATH }, sandboxProfile: 'workspace-only',
  }, file, `nexus/sandbox@sha256:${'1'.repeat(64)}`);
  const entry = { dir, owned: undefined as OwnedOciCommand | undefined, proc: undefined as ChildProcess | undefined };
  fixtures.push(entry);
  return {
    plan, checkout, runtime, entry,
    state: () => JSON.parse(fs.readFileSync(path.join(dir, 'kernel.json'), 'utf8')) as KernelState,
    updateState: (patch: Partial<KernelState>) => {
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'kernel.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify({ ...state, ...patch }));
    },
    control: (patch: Record<string, unknown>) => fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(patch)),
    absent: () => !fs.existsSync(path.join(dir, 'kernel.json')),
    prepare: async (candidate: ScopedShellPlan = plan) => (entry.owned = await prepareOwnedOciCommand(candidate)),
    start: async (owned: OwnedOciCommand) => {
      const proc = spawn(owned.plan.file, owned.plan.args, { cwd: owned.plan.cwd, env: owned.plan.env, stdio: ['ignore', 'pipe', 'pipe'] });
      entry.proc = proc;
      const exit = owned.waitForExit(proc);
      await once(proc.stdout!, 'data');
      return { proc, exit };
    },
  };
}

async function isPending(promise: Promise<void>): Promise<boolean> {
  return Promise.race([promise.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100))]);
}

afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    fs.writeFileSync(path.join(entry.dir, 'control.json'), '{}');
    const kernel = path.join(entry.dir, 'kernel.json');
    if (fs.existsSync(kernel)) {
      const state = JSON.parse(fs.readFileSync(kernel, 'utf8'));
      state.running = false; state.status = 'exited'; fs.writeFileSync(kernel, JSON.stringify(state));
    }
    if (entry.proc && entry.proc.exitCode === null && entry.proc.signalCode === null) entry.proc.kill();
    if (entry.owned) await entry.owned.dispose();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe('Main-owned OCI command lifetime', () => {
  it('creates a proved dormant container and preserves confinement without a mounted ownership file', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const state = f.state();
    expect(state.running).toBe(false);
    expect(state.createArgs.slice(0, 5)).toEqual(['create', '--name', state.name, '--label', `app.nexuside.owned-command=${state.nonce}`]);
    expect(state.createArgs.slice(5)).toEqual(f.plan.args.slice(2));
    expect(state.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(state.name).toBe(`nexus-owned-command-${state.nonce}`);
    expect(owned.plan.args).toEqual(['start', '--attach', state.id]);
    expect(fs.readdirSync(f.checkout)).toEqual([]);
    expect(fs.readdirSync(f.runtime)).toEqual(['home', 'tmp']);
    expect(fs.readdirSync(path.join(f.runtime, 'home'))).toEqual([]);
    expect(fs.readdirSync(path.join(f.runtime, 'tmp'))).toEqual([]);
    await owned.dispose();
    expect(f.absent()).toBe(true);
  });

  it('holds physical ownership after the attach client dies while the kernel still runs', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const { proc, exit } = await f.start(owned);
    proc.kill();
    await once(proc, 'close');
    expect(f.state().running).toBe(true);
    expect(await isPending(exit)).toBe(true);
    f.updateState({ running: false, status: 'exited' });
    await exit;
    expect(f.absent()).toBe(true);
  });

  it('stops the exact owned container and still waits for the actual attach process close', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const { exit } = await f.start(owned);
    await owned.stop();
    await exit;
    expect(f.absent()).toBe(true);
  });

  it('requires the registered child close even after container removal is proved', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], { stdio: 'ignore' });
    f.entry.proc = proc;
    const exit = owned.waitForExit(proc);
    await owned.stop();
    expect(f.absent()).toBe(true);
    expect(await isPending(exit)).toBe(true);
    proc.kill();
    await exit;
  });

  it('handles a spawn error by waiting for close and removing its dormant container', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const proc = spawn(path.join(f.entry.dir, 'absent-runtime'), []);
    f.entry.proc = proc;
    await owned.waitForExit(proc);
    expect(f.absent()).toBe(true);
  });

  it('retains ownership through transport failures instead of treating inspect failure as exit', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const { proc, exit } = await f.start(owned);
    f.control({ transportError: true });
    proc.kill();
    await once(proc, 'close');
    const stopped = owned.stop();
    expect(await isPending(exit)).toBe(true);
    expect(await isPending(stopped)).toBe(true);
    expect(f.state().running).toBe(true);
    f.control({});
    await stopped;
    await exit;
    expect(f.absent()).toBe(true);
  });

  it.each([{ inspectNonce: 'b'.repeat(64) }, { inspectId: 'b'.repeat(64) }, { inspectName: 'operator-container' }, { inspectOutput: 'null' }])('refuses stop/removal with substituted ownership proof: %j', async (control) => {
    const f = fixture();
    const owned = await f.prepare();
    const { proc, exit } = await f.start(owned);
    proc.kill();
    await once(proc, 'close');
    f.control(control);
    const stopped = owned.stop();
    expect(await isPending(stopped)).toBe(true);
    expect(f.state().running).toBe(true);
    f.control({});
    await stopped;
    await exit;
  });

  it('requires absence proof after a stopped container cannot be removed', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const { proc, exit } = await f.start(owned);
    proc.kill();
    await once(proc, 'close');
    f.control({ removeError: true });
    f.updateState({ running: false, status: 'exited' });
    expect(await isPending(exit)).toBe(true);
    expect(f.absent()).toBe(false);
    f.control({});
    await exit;
    expect(f.absent()).toBe(true);
  });

  it('cleans a created container when creation response is lost and reports only a sanitized error', async () => {
    const f = fixture({ createError: true });
    await expect(f.prepare()).rejects.toThrow('Owned OCI container creation could not be proved');
    expect(f.absent()).toBe(true);
  });

  it('rejects promptly when the create client provably never spawned', async () => {
    const f = fixture();
    fs.unlinkSync(f.plan.file);
    const result = f.prepare().then(() => 'prepared', (error: Error) => error.message);
    try {
      expect(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve('pending'), 150))]))
        .toBe('Owned OCI container creation could not be proved');
    } finally {
      fs.writeFileSync(f.plan.file, FAKE_DOCKER, { mode: 0o700 });
      await result;
    }
    expect(f.absent()).toBe(true);
  });

  it.each(['a'.repeat(12), 'b'.repeat(64), `${'a'.repeat(64)}\n${'b'.repeat(64)}`])('does not start a shortened or substituted creation ID: %s', async (createOutput) => {
    const f = fixture({ createOutput });
    await expect(f.prepare()).rejects.toThrow('Owned OCI container creation could not be proved');
    expect(f.absent()).toBe(true);
  });

  it('keeps successful full-ID absence authoritative even when its generated name is reused', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const { proc, exit } = await f.start(owned);
    proc.kill();
    await once(proc, 'close');
    f.updateState({ id: 'b'.repeat(64), nonce: 'b'.repeat(64) });
    await exit;
    expect(f.state().id).toBe('b'.repeat(64));
    expect(f.state().running).toBe(true);
  });

  it('does not treat a failed inspect plus malformed full-ID list as absence', async () => {
    const f = fixture();
    const owned = await f.prepare();
    const { proc, exit } = await f.start(owned);
    proc.kill();
    await once(proc, 'close');
    f.updateState({ id: 'b'.repeat(64), nonce: 'b'.repeat(64) });
    f.control({ listOutput: 'a'.repeat(12) });
    expect(await isPending(exit)).toBe(true);
    f.control({});
    await exit;
    expect(f.state().running).toBe(true);
  });

  it('freezes runtime and environment authority against mutation of the original plan', async () => {
    const f = fixture();
    const owned = await f.prepare();
    f.plan.file = '/not-the-owned-runtime';
    f.plan.env.PATH = '/operator-secret';
    f.plan.args.splice(0, f.plan.args.length, 'stop', 'operator-container');
    await owned.dispose();
    expect(f.absent()).toBe(true);
  });

  it('preserves the read-only workspace and explicitly allowed network profile', async () => {
    const f = fixture();
    const args = [...f.plan.args];
    args[3] = 'bridge';
    args[14] += ',readonly';
    const owned = await f.prepare({ ...f.plan, args });
    expect(f.state().createArgs.slice(5)).toEqual(args.slice(2));
    await owned.dispose();
  });

  it.each(['--name', '--cidfile', '--label', '--privileged', '--volume'])('rejects caller ownership/mount additions before invoking the runtime: %s', async (option) => {
    const f = fixture();
    const candidate = { ...f.plan, args: ['run', '--rm', option, '/workspace/operator', ...f.plan.args.slice(2)] };
    await expect(f.prepare(candidate)).rejects.toThrow('Unsupported owned OCI sandbox plan');
    expect(f.absent()).toBe(true);
  });

  it.each(['relative-docker', '/docker\0injected'])('rejects an invalid runtime path before invocation: %s', async (file) => {
    const f = fixture();
    await expect(f.prepare({ ...f.plan, file })).rejects.toThrow('Unsupported owned OCI sandbox plan');
    expect(f.absent()).toBe(true);
  });
});
