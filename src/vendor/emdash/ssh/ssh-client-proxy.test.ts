// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/core/ssh/lifecycle/ssh-client-proxy.test.ts
// See src/vendor/emdash/ssh/LICENSE.md. Nexus changes: the remote-shell-profile
// suite is dropped together with the profile layer it covered (see
// ./ssh-client-proxy.ts header). The channel-health cases are verbatim; the
// "stable client reference" describe is Nexus-authored to pin the
// reconnect-survival semantics the profile suite used to exercise indirectly.

import { describe, expect, it, vi } from 'vitest';
import { SshClientProxy } from './ssh-client-proxy';

describe('SshClientProxy stable client reference', () => {
  it('throws when the SSH connection is unavailable', () => {
    const proxy = new SshClientProxy('ssh-1');

    expect(proxy.isConnected).toBe(false);
    expect(() => proxy.client).toThrow('SSH connection is not available');
  });

  it('always hands out the most recently updated client (survives reconnect)', () => {
    const firstClient = {};
    const secondClient = {};
    const proxy = new SshClientProxy('ssh-1');

    proxy.update(firstClient as never);
    expect(proxy.isConnected).toBe(true);
    expect(proxy.client).toBe(firstClient);

    // Reconnect: the same proxy instance now serves the new live client, so
    // long-lived holders of the proxy never need to be rebuilt.
    proxy.update(secondClient as never);
    expect(proxy.client).toBe(secondClient);
  });

  it('drops the reference on invalidate and accepts a fresh update afterwards', () => {
    const firstClient = {};
    const secondClient = {};
    const proxy = new SshClientProxy('ssh-1');

    proxy.update(firstClient as never);
    proxy.invalidate();

    expect(proxy.isConnected).toBe(false);
    expect(() => proxy.client).toThrow('SSH connection is not available');

    proxy.update(secondClient as never);
    expect(proxy.isConnected).toBe(true);
    expect(proxy.client).toBe(secondClient);
  });
});

describe('SshClientProxy channel health reporting', () => {
  it('reports exec channel success and failure', () => {
    const successCallback = vi.fn();
    const error = new Error('open failed');
    const reporter = {
      reportChannelError: vi.fn(),
    };
    const client = {
      exec: vi
        .fn()
        .mockImplementationOnce((_command, callback) => callback(undefined, {}))
        .mockImplementationOnce((_command, callback) => callback(error, undefined)),
    };
    const proxy = new SshClientProxy('ssh-1', reporter);
    proxy.update(client as never);

    proxy.exec('true', successCallback);
    proxy.exec('false', vi.fn());

    expect(successCallback).toHaveBeenCalledWith(undefined, {});
    expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', error);
  });

  it('reports pty and sftp channel failures', () => {
    const ptyError = new Error('pty failed');
    const sftpError = new Error('sftp failed');
    const reporter = {
      reportChannelError: vi.fn(),
    };
    const client = {
      exec: vi.fn((_command, _options, callback) => callback(ptyError, undefined)),
      sftp: vi.fn((callback) => callback(sftpError, undefined)),
    };
    const proxy = new SshClientProxy('ssh-1', reporter);
    proxy.update(client as never);

    proxy.execPty('bash', { pty: true }, vi.fn());
    proxy.sftp(vi.fn());

    expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', ptyError);
    expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', sftpError);
  });
});
