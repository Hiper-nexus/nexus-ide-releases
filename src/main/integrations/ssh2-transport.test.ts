import { createHash } from 'node:crypto';
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
  destroy(): void;
  exec(
    command: string,
    callback: (error?: Error, channel?: Ssh2ChannelShape) => void,
  ): void;
  shell(
    options: Record<string, unknown>,
    callback: (error?: Error, channel?: Ssh2ChannelShape) => void,
  ): void;
  sftp(callback: (error?: Error, sftp?: Ssh2SftpShape) => void): void;
};
type Ssh2ChannelShape = EventEmitter & {
  stderr: PassThrough;
  write(data: string): boolean;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  close(): void;
  destroy(): void;
};
type Ssh2SftpShape = {
  readFile(path: string, callback: (error?: Error, data?: Buffer) => void): void;
  writeFile(path: string, data: Buffer, callback: (error?: Error) => void): void;
  readdir(
    path: string,
    callback: (error?: Error, entries?: Array<{ filename: string }>) => void,
  ): void;
  end(): void;
};
type AgentCallback<T> = (error?: Error | null, value?: T) => void;
type AgentLike = {
  getIdentities(callback: AgentCallback<unknown[]>): void;
  sign(
    publicKey: unknown,
    data: Buffer,
    optionsOrCallback: Record<string, unknown> | AgentCallback<Buffer>,
    callback?: AgentCallback<Buffer>,
  ): void;
};
type Ssh2Module = {
  Client: new () => Ssh2ClientShape;
  BaseAgent: new () => AgentLike;
  createAgent(socketPath: string): AgentLike;
  utils: { parseKey(value: unknown): unknown };
};

const requireForTest = createRequire(import.meta.url);

function sshString(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function ed25519PublicBlob(fill: number): Buffer {
  return Buffer.concat([
    sshString(Buffer.from('ssh-ed25519')),
    sshString(Buffer.alloc(32, fill)),
  ]);
}

function fingerprint(publicBlob: Buffer): string {
  return `SHA256:${createHash('sha256')
    .update(publicBlob)
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

function getIdentities(agent: AgentLike): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    agent.getIdentities((error, identities) => {
      if (error) reject(error);
      else resolve(identities ?? []);
    });
  });
}

function sign(agent: AgentLike, publicKey: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    agent.sign(publicKey, Buffer.from('payload'), (error, signature) => {
      if (error) reject(error);
      else resolve(signature ?? Buffer.alloc(0));
    });
  });
}

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

function fakeSshChannel(): Ssh2ChannelShape & {
  writes: string[];
  windows: Array<[number, number, number, number]>;
  closeCalls: number;
  destroyCalls: number;
} {
  const channel = new EventEmitter() as Ssh2ChannelShape & {
    writes: string[];
    windows: Array<[number, number, number, number]>;
    closeCalls: number;
    destroyCalls: number;
  };
  channel.stderr = new PassThrough();
  channel.writes = [];
  channel.windows = [];
  channel.closeCalls = 0;
  channel.destroyCalls = 0;
  channel.write = (data) => {
    channel.writes.push(data);
    return true;
  };
  channel.setWindow = (rows, cols, height, width) => {
    channel.windows.push([rows, cols, height, width]);
  };
  channel.close = () => {
    channel.closeCalls += 1;
  };
  channel.destroy = () => {
    channel.destroyCalls += 1;
  };
  return channel;
}

const PROXIED_OPTIONS: SshConnectOptions = {
  host: 'dev.internal',
  port: 2222,
  username: 'alice',
  auth: { kind: 'password', password: 'x' },
};

describe('createSsh2Transport with vendored proxy transports', () => {
  const originalAgentSocket = process.env.SSH_AUTH_SOCK;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalAgentSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalAgentSocket;
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

  it('passes a filtered agent object to ssh2 and refuses signing with other loaded keys', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    const cfgs = mockClientConnect(ssh2, 'ready');
    const allowed = ed25519PublicBlob(0x31);
    const denied = ed25519PublicBlob(0x32);
    const backingSign = vi.fn((
      _publicKey: unknown,
      _data: Buffer,
      optionsOrCallback: Record<string, unknown> | AgentCallback<Buffer>,
      callback?: AgentCallback<Buffer>,
    ) => {
      const done = typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : callback;
      done?.(undefined, Buffer.from('signature'));
    });
    const backingAgent: AgentLike = {
      getIdentities(callback) {
        callback(undefined, [allowed, denied]);
      },
      sign: backingSign,
    };
    vi.spyOn(ssh2, 'createAgent').mockReturnValue(backingAgent);
    process.env.SSH_AUTH_SOCK = '/private/test-agent.sock';

    const transport = createSsh2Transport();
    await transport.connect({
      host: 'agent.internal',
      username: 'alice',
      auth: { kind: 'agent', allowedFingerprints: [fingerprint(allowed)] },
    });

    expect(cfgs).toHaveLength(1);
    const cfg = cfgs[0]!;
    expect(cfg.agent).not.toBe(process.env.SSH_AUTH_SOCK);
    expect(cfg.agent).toBeInstanceOf(ssh2.BaseAgent);
    const agent = cfg.agent as AgentLike;
    await expect(getIdentities(agent)).resolves.toEqual([allowed]);
    await expect(sign(agent, allowed)).resolves.toEqual(Buffer.from('signature'));
    await expect(sign(agent, denied)).rejects.toThrow(/not allowlisted/i);
    expect(backingSign).toHaveBeenCalledOnce();
    expect(ssh2.createAgent).toHaveBeenCalledWith('/private/test-agent.sock');
    expect(typeof cfg.hostVerifier).toBe('function');

    await transport.disconnect();
  });

  it('times out connect, sets ssh2 readyTimeout, and ignores a late ready event', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    vi.useFakeTimers();
    const clients: Ssh2ClientShape[] = [];
    const cfgs: Array<Record<string, unknown>> = [];
    vi.spyOn(ssh2.Client.prototype, 'connect').mockImplementation(function (
      this: Ssh2ClientShape,
      ...args: unknown[]
    ) {
      clients.push(this);
      cfgs.push(args[0] as Record<string, unknown>);
    });
    const end = vi.spyOn(ssh2.Client.prototype, 'end').mockImplementation(() => {});
    const destroy = vi.spyOn(ssh2.Client.prototype, 'destroy').mockImplementation(() => {});
    const transport = createSsh2Transport({
      timeouts: { connectMs: 25, operationMs: 50, ptyOpenMs: 50 },
    });

    const connect = transport.connect(PROXIED_OPTIONS);
    let outcome = 'pending';
    void connect.then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );
    await vi.advanceTimersByTimeAsync(25);
    const timedOutOutcome = outcome;
    clients[0]!.emit('ready');
    await Promise.resolve();

    expect(cfgs[0]!.readyTimeout).toBe(25);
    expect(timedOutOutcome).toBe('rejected');
    expect(transport.isConnected()).toBe(false);
    expect(end.mock.calls.length + destroy.mock.calls.length).toBeGreaterThan(0);
  });

  it('fences late close from an old client across disconnect and reconnect', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    const clients: Ssh2ClientShape[] = [];
    vi.spyOn(ssh2.Client.prototype, 'connect').mockImplementation(function (
      this: Ssh2ClientShape,
    ) {
      clients.push(this);
      queueMicrotask(() => this.emit('ready'));
    });
    vi.spyOn(ssh2.Client.prototype, 'end').mockImplementation(() => {});
    const transport = createSsh2Transport();

    await transport.connect(PROXIED_OPTIONS);
    await transport.disconnect();
    await transport.connect(PROXIED_OPTIONS);
    expect(transport.isConnected()).toBe(true);

    clients[0]!.emit('close');
    expect(transport.isConnected()).toBe(true);
    clients[1]!.emit('close');
    expect(transport.isConnected()).toBe(false);
  });

  it('rejects an exec timeout once and closes a channel returned by a late callback', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    vi.useFakeTimers();
    mockClientConnect(ssh2, 'ready');
    let execCallback: ((error?: Error, channel?: Ssh2ChannelShape) => void) | null = null;
    vi.spyOn(ssh2.Client.prototype, 'exec').mockImplementation((...args: unknown[]) => {
      execCallback = args[1] as (error?: Error, channel?: Ssh2ChannelShape) => void;
    });
    const transport = createSsh2Transport({
      timeouts: { connectMs: 50, operationMs: 20, ptyOpenMs: 50 },
    });
    await transport.connect(PROXIED_OPTIONS);

    const operation = transport.exec('touch /tmp/maybe-happened');
    let outcome = 'pending';
    void operation.then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );
    await vi.advanceTimersByTimeAsync(20);
    const lateChannel = fakeSshChannel();
    (execCallback as ((error?: Error, channel?: Ssh2ChannelShape) => void) | null)?.(
      undefined,
      lateChannel,
    );
    lateChannel.emit('close', 0);

    expect(outcome).toBe('rejected');
    await expect(operation).rejects.toMatchObject({
      code: 'operation_timeout',
      outcomeUnknown: true,
    });
    expect(lateChannel.closeCalls + lateChannel.destroyCalls).toBeGreaterThan(0);
  });

  it('opens a production shell PTY and wires output, resize, write, and close', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    mockClientConnect(ssh2, 'ready');
    const channel = fakeSshChannel();
    const shell = vi.spyOn(ssh2.Client.prototype, 'shell').mockImplementation((
      ...args: unknown[]
    ) => {
      const callback = args[1] as (
        error?: Error,
        opened?: Ssh2ChannelShape,
      ) => void;
      callback(undefined, channel);
    });
    const transport = createSsh2Transport();
    await transport.connect(PROXIED_OPTIONS);

    const pty = await transport.openPty!(100, 35);
    const chunks: string[] = [];
    pty.onData((data) => chunks.push(data));
    channel.emit('data', Buffer.from('ready'));
    pty.write('echo ok\n');
    pty.resize(120, 40);
    pty.close();

    expect(shell).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 100, rows: 35, term: 'xterm-256color' }),
      expect.any(Function),
    );
    expect(chunks).toEqual(['ready']);
    expect(channel.writes).toEqual(['echo ok\n']);
    expect(channel.windows).toEqual([[40, 120, 0, 0]]);
    expect(channel.closeCalls + channel.destroyCalls).toBeGreaterThan(0);
  });

  it('does not dispatch a pre-aborted SFTP operation', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    mockClientConnect(ssh2, 'ready');
    const sftp = vi.spyOn(ssh2.Client.prototype, 'sftp').mockImplementation(() => {});
    const transport = createSsh2Transport();
    await transport.connect(PROXIED_OPTIONS);
    const abort = new AbortController();
    abort.abort();

    await expect(
      transport.readFile('/remote/file', { signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'operation_aborted', outcomeUnknown: false });
    expect(sftp).not.toHaveBeenCalled();
  });

  it('closes a shell channel returned after the bounded PTY-open timeout', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    vi.useFakeTimers();
    mockClientConnect(ssh2, 'ready');
    let shellCallback: ((error?: Error, channel?: Ssh2ChannelShape) => void) | null = null;
    vi.spyOn(ssh2.Client.prototype, 'shell').mockImplementation((...args: unknown[]) => {
      shellCallback = args[1] as (
        error?: Error,
        channel?: Ssh2ChannelShape,
      ) => void;
    });
    const transport = createSsh2Transport({
      timeouts: { connectMs: 50, operationMs: 50, ptyOpenMs: 15 },
    });
    await transport.connect(PROXIED_OPTIONS);

    const opening = transport.openPty!(80, 24);
    await vi.advanceTimersByTimeAsync(15);
    await expect(opening).rejects.toMatchObject({
      code: 'operation_timeout',
      outcomeUnknown: false,
    });
    const lateChannel = fakeSshChannel();
    (shellCallback as ((error?: Error, channel?: Ssh2ChannelShape) => void) | null)?.(
      undefined,
      lateChannel,
    );
    expect(lateChannel.closeCalls + lateChannel.destroyCalls).toBeGreaterThan(0);
  });

  it('disconnect closes a live PTY channel owned by the current generation', async () => {
    const ssh2 = loadSsh2Module();
    if (!ssh2) return;
    mockClientConnect(ssh2, 'ready');
    const channel = fakeSshChannel();
    vi.spyOn(ssh2.Client.prototype, 'shell').mockImplementation((
      ...args: unknown[]
    ) => {
      const callback = args[1] as (
        error?: Error,
        opened?: Ssh2ChannelShape,
      ) => void;
      callback(undefined, channel);
    });
    const transport = createSsh2Transport();
    await transport.connect(PROXIED_OPTIONS);
    await transport.openPty!(80, 24);

    await transport.disconnect();

    expect(channel.closeCalls + channel.destroyCalls).toBeGreaterThan(0);
    expect(transport.isConnected()).toBe(false);
  });
});
