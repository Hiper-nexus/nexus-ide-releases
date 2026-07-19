// Nexus-authored tests for the proxied-connect glue. The invariant under test:
// a connection built on the vendored emdash proxy transports can NEVER exist
// without the known-hosts hostVerifier attached (upstream emdash attached none).

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  buildProxiedConnectFragment,
  type SshHostVerifier,
} from './proxied-connect-config';
import { buildProxyJumpArgs, type SpawnProcess } from '../../../vendor/emdash/ssh/transports';

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; shell?: boolean }> = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killSignals: NodeJS.Signals[];
    kill: (signal: NodeJS.Signals) => boolean;
  };
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
  const spawn: SpawnProcess = (command, args, options) => {
    calls.push({ command, args, shell: options.shell });
    return child as never;
  };
  return { calls, child, spawn };
}

const DESTINATION = { host: 'dev.internal', port: 2222, username: 'alice' } as const;

describe('buildProxiedConnectFragment', () => {
  it('REQUIRES a hostVerifier — a proxied connection cannot be built without one', () => {
    const { spawn } = fakeSpawn();

    // No verifier at all (what upstream emdash effectively did): fail closed.
    expect(() =>
      buildProxiedConnectFragment(
        { kind: 'jump', jumpSpec: 'bastion' },
        DESTINATION,
        undefined as unknown as SshHostVerifier,
        spawn,
      ),
    ).toThrow(/hostVerifier is required/);

    // A non-function value must fail the same way.
    expect(() =>
      buildProxiedConnectFragment(
        { kind: 'jump', jumpSpec: 'bastion' },
        DESTINATION,
        null as unknown as SshHostVerifier,
        spawn,
      ),
    ).toThrow(/hostVerifier is required/);
  });

  it('binds the vendored ProxyJump transport and carries the verifier next to the socket', () => {
    const { calls, child, spawn } = fakeSpawn();
    const hostVerifier: SshHostVerifier = (_key, verify) => verify(true);

    const fragment = buildProxiedConnectFragment(
      { kind: 'jump', jumpSpec: 'bastion' },
      DESTINATION,
      hostVerifier,
      spawn,
    );

    expect(calls).toEqual([
      {
        command: 'ssh',
        args: buildProxyJumpArgs('bastion', 'dev.internal', 2222),
        shell: undefined,
      },
    ]);
    expect(fragment.hostVerifier).toBe(hostVerifier);
    expect(fragment.sock.readable).toBe(true);
    expect(fragment.debugLogs).toEqual([]);

    fragment.cleanup();
    expect(child.killSignals).toContain('SIGTERM');
  });

  it('expands ProxyCommand tokens against the destination and spawns via shell', () => {
    const { calls, spawn } = fakeSpawn();
    const hostVerifier: SshHostVerifier = (_key, verify) => verify(true);

    const fragment = buildProxiedConnectFragment(
      { kind: 'command', command: 'cloudflared access ssh --hostname %h' },
      { ...DESTINATION, originalHost: 'corp-dev' },
      hostVerifier,
      spawn,
    );

    expect(calls).toEqual([
      {
        command: 'cloudflared access ssh --hostname dev.internal',
        args: [],
        shell: true,
      },
    ]);
    expect(fragment.hostVerifier).toBe(hostVerifier);
    fragment.cleanup();
  });

  it('still enforces the vendored allowlists even when a verifier is supplied', () => {
    const { calls, spawn } = fakeSpawn();
    const hostVerifier: SshHostVerifier = vi.fn();

    expect(() =>
      buildProxiedConnectFragment(
        { kind: 'jump', jumpSpec: '-oProxyCommand=evil' },
        DESTINATION,
        hostVerifier,
        spawn,
      ),
    ).toThrow('Invalid ProxyJump');
    // Nothing was spawned: rejection happens before any process exists.
    expect(calls).toEqual([]);
    expect(hostVerifier).not.toHaveBeenCalled();
  });
});
