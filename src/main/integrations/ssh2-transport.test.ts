import { describe, expect, it, vi } from 'vitest';
import { remoteWorktreeCreate } from './ssh2-transport';
import type { SshTransport } from '../remote/ssh/ssh-session-manager';

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
