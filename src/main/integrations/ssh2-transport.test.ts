import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSsh2Transport, remoteWorktreeCreate } from './ssh2-transport';
import type { SshConnectOptions, SshTransport } from '../remote/ssh/ssh-session-manager';
import { buildProxyJumpArgs } from '../../vendor/emdash/ssh/transports';

function mockTransport(execImpl: SshTransport['exec']): SshTransport & {
  exec: ReturnType<typeof vi.fn<SshTransport['exec']>>;
} {
  const exec = vi.fn(execImpl);
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: () => true,
    exec,
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => {}),
    listDir: vi.fn(async () => []),
  };
}

describe('remoteWorktreeCreate', () => {
  it('creates remote path and initializes git when needed', async () => {
    const t = mockTransport(async () => ({ code: 0, stdout: 'true\n', stderr: '' }));
    const r = await remoteWorktreeCreate(t, '/home/u/proj', 'feature/x');
    expect(r).toEqual({ ok: true, path: '/home/u/proj' });
    expect(t.exec).toHaveBeenCalledOnce();
    const cmd = String((t.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
    expect(cmd).toContain('/home/u/proj');
    expect(cmd).toContain('git init');
    expect(cmd).toContain('feature/x');
  });

  it('returns error on non-zero exit', async () => {
    const t = mockTransport(async () => ({
      code: 128,
      stdout: '',
      stderr: 'not a git repository',
    }));
    const r = await remoteWorktreeCreate(t, '/bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not a git repository');
  });

  it('shell-quotes remote paths', async () => {
    const t = mockTransport(async () => ({ code: 0, stdout: '', stderr: '' }));
    await remoteWorktreeCreate(t, `/tmp/o'brian`);
    const cmd = String((t.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
    // POSIX: '…' + escaped quote + '…'
    expect(cmd).toContain(`'/tmp/o'\\''brian'`);
  });
});

describe('createSsh2Transport availability', () => {
  it('loads ssh2 when installed, or throws a clear install hint', async () => {
    const { createSsh2Transport } = await import('./ssh2-transport');
    try {
      const transport = createSsh2Transport();
      expect(transport.isConnected()).toBe(false);
      expect(typeof transport.connect).toBe('function');
      expect(typeof transport.exec).toBe('function');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/ssh2 package is not installed|Cannot find module 'ssh2'/i);
    }
  });
});

// Proxy support: the transport dials through the vendored emdash proxy
// transports (cfg.sock) but ALWAYS keeps the known-hosts hostVerifier
// attached — the invariant that upstream emdash violated. ssh2 is an
// optionalDependency, so these cases no-op when it is absent from the
// install (mirroring the availability test above).
type Ssh2ClientShape = EventEmitter & {
  connect(cfg: Record<string, unknown>): void;
  end(): void;
};
type Ssh2Module = { Client: new () => Ssh2ClientShape };

const requireForTest = createRequire(import.meta.url);

function loadSsh2Module(): Ssh2Module | null {
  try {
    return requireForTest('ssh2') as Ssh2Module;
  } catch {
    return null;
  }
}

type FakeProxyChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killSignals: NodeJS.Signals[];
  kill: (signal: NodeJS.Signals) => boolean;
};

function fakeProxySpawn() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const child = new EventEmitter() as FakeProxyChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  const spawn = (command: string, args: string[]) => {
    calls.push({ command, args });
    return child as never;
  };
  return { calls, child, spawn };
}

const PROXIED_OPTIONS: SshConnectOptions = {
  host: 'dev.internal',
  port: 2222,
  username: 'alice',
  auth: { kind: 'password', password: 'x' },
};

describe('createSsh2Transport with vendored proxy transports', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockClientConnect(ssh2: Ssh2Module, event: 'ready' | 'error') {
    const cfgs: Array<Record<string, unknown>> = [];
    vi.spyOn(ssh2.Client.prototype, 'connect').mockImplementation(function (
      this: Ssh2ClientShape,
      ...args: unknown[]
    ) {
      cfgs.push(args[0] as Record<string, unknown>);
      queueMicrotask(() => {
        if (event === 'ready') this.emit('ready');
        else this.emit('error', new Error('boom'));
      });
    });
    vi.spyOn(ssh2.Client.prototype, 'end').mockImplementation(() => {});
    return cfgs;
  }

  it('dials ProxyJump through cfg.sock and ALWAYS attaches the known-hosts hostVerifier', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    const cfgs = mockClientConnect(ssh2, 'ready');
    const { calls, child, spawn } = fakeProxySpawn();
    const transport = createSsh2Transport({
      proxy: { kind: 'jump', jumpSpec: 'bastion' },
      spawnProcess: spawn,
    });

    await transport.connect(PROXIED_OPTIONS);

    // The vendored spawn happened with the allowlisted ssh -W argv.
    expect(calls).toEqual([
      { command: 'ssh', args: buildProxyJumpArgs('bastion', 'dev.internal', 2222) },
    ]);
    expect(cfgs).toHaveLength(1);
    const cfg = cfgs[0]!;
    expect(cfg.sock).toBeInstanceOf(Duplex);
    // host/port remain the pin identity for the FINAL destination.
    expect(cfg.host).toBe('dev.internal');
    expect(cfg.port).toBe(2222);
    // THE invariant: even through a vendored proxy transport the known-hosts
    // verifier is present — ssh2 never auto-accepts a host key here.
    expect(typeof cfg.hostVerifier).toBe('function');
    expect(transport.isConnected()).toBe(true);

    await transport.disconnect();
    expect(child.killSignals).toContain('SIGTERM');
    expect(transport.isConnected()).toBe(false);
  });

  it('reaps the proxy child when the connect fails', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    mockClientConnect(ssh2, 'error');
    const { child, spawn } = fakeProxySpawn();
    const transport = createSsh2Transport({
      proxy: { kind: 'jump', jumpSpec: 'bastion' },
      spawnProcess: spawn,
    });

    await expect(transport.connect(PROXIED_OPTIONS)).rejects.toThrow('boom');
    expect(child.killSignals).toContain('SIGTERM');
  });

  it('connects directly (no sock, no proxy spawn) when no proxy is configured', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    const cfgs = mockClientConnect(ssh2, 'ready');
    const { calls, spawn } = fakeProxySpawn();
    const transport = createSsh2Transport({ spawnProcess: spawn });

    await transport.connect({
      host: 'plain.internal',
      username: 'bob',
      auth: { kind: 'password', password: 'x' },
    });

    expect(calls).toEqual([]);
    expect(cfgs[0]!.sock).toBeUndefined();
    expect(typeof cfgs[0]!.hostVerifier).toBe('function');
    await transport.disconnect();
  });
});
