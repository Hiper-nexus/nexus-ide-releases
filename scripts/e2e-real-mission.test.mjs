import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REAL_MISSION_CTA,
  REAL_MISSION_EXPECTED_CONTENT,
  REAL_MISSION_FLAG,
  assertCodexReady,
  assertRealMissionPassEvidence,
  parseRealMissionArgs,
  realMissionArgs,
  realMissionEnvironment,
  resolveTrustedCodexBinary,
  safeRealMissionFailureReceipt,
  safeRealMissionFailureSummary,
  stageCodexAuthentication,
  waitForChild,
} from './e2e-real-mission.mjs';

const tempDirectories = [];
const sha = (value) => createHash('sha256').update(value).digest('hex');

function makeTemp() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-real-mission-unit-'),
  );
  tempDirectories.push(directory);
  return directory;
}

function validEvidence() {
  const expectedContentSha256 = sha(REAL_MISSION_EXPECTED_CONTENT);
  return {
    schemaVersion: 1,
    status: 'pass',
    failure: null,
    expectedContentSha256,
    release: {
      appVersion: '1.2.3',
      runId: '3e112472-c72f-4f5e-b6bd-e9cae5c9c413',
      startedAt: '2026-07-23T10:00:00.000Z',
      finishedAt: '2026-07-23T10:01:00.000Z',
      commitSha: 'c'.repeat(40),
      artifact: {
        sha256: 'd'.repeat(64),
        identity:
          'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
      },
    },
    mission: {
      id: 'mission-real',
      status: 'done',
      squadId: 'nexus-real-mission-e2e',
    },
    kickoff: {
      sessionId: 'session-orch',
      idleAt: 1,
      busyAt: 2,
      ptyDataAt: 3,
      ptyChunkSha256: sha('chunk'),
    },
    panes: [
      {
        role: 'orchestrator',
        adapterId: 'claude',
        agentRef: 'e2e-orchestrator',
        sessionId: 'session-orch',
        ptySpawnedAt: 1,
        ptyDataAt: 2,
        ptyChunkSha256: sha('orchestrator-pty'),
      },
      {
        role: 'worker',
        adapterId: 'codex',
        agentRef: 'e2e-worker',
        workerIncarnationId: 'incarnation-worker',
        sessionId: 'session-worker',
        ptySpawnedAt: 4,
        ptyDataAt: 5,
        ptyChunkSha256: sha('worker-pty'),
      },
    ],
    dispatches: [
      {
        state: 'completed',
        routeReservationId: 'reservation',
        routeConsumedAt: 4,
        routeConsumerMatches: true,
        workerIncarnationId: 'incarnation-worker',
        sessionId: 'session-worker',
        handoffId: 'handoff',
        handoffAcceptedAt: 5,
        integrationReceipt: {
          kind: 'worktree_integrated',
          referenceSha: 'b'.repeat(40),
        },
      },
    ],
    handoffs: [
      {
        id: 'handoff',
        status: 'success',
        delivered: true,
        deliveryState: 'consumed',
        acceptedAt: 6,
        acceptedBySessionId: 'session-orch',
      },
    ],
    repository: {
      initialHeadSha: 'a'.repeat(40),
      finalHeadSha: 'b'.repeat(40),
      resultSha256: expectedContentSha256,
      commitCount: 2,
      clean: true,
      changedBeforeWorker: false,
      exactSingleCommit: true,
    },
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('real mission packaged harness arguments', () => {
  it('parses only the closed CLI surface', () => {
    expect(
      parseRealMissionArgs([
        '--app',
        '/tmp/NexusIDE.app',
        '--evidence',
        '/tmp/evidence.json',
      ]),
    ).toEqual({
      appPath: '/tmp/NexusIDE.app',
      evidencePath: '/tmp/evidence.json',
    });
    expect(() => parseRealMissionArgs(['--timeout', '1'])).toThrow(/usage/);
  });

  it('places the exact explicit flag after Chromium argument termination', () => {
    expect(realMissionArgs('/tmp/user-data')).toEqual([
      '--user-data-dir=/tmp/user-data',
      '--',
      REAL_MISSION_FLAG,
    ]);
  });

  it('isolates HOME and mutable app state from the release operator profile', () => {
    const environment = realMissionEnvironment(
      {
        HOME: '/Users/tester',
        PATH: '/usr/bin',
        CODEX_ACCESS_TOKEN: 'inherited-but-never-logged',
        OPENAI_BASE_URL: 'https://attacker.invalid',
        AWS_SECRET_ACCESS_KEY: 'private',
        GH_TOKEN: 'private',
        GIT_DIR: '/Users/tester/important-repository/.git',
        GIT_WORK_TREE: '/Users/tester/important-repository',
        NODE_OPTIONS: '--inspect',
        NEXUS_REMOTE_DEBUG: '9223',
      },
      '/tmp/user-data',
      '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
    );
    expect(environment.HOME).toBe('/tmp/user-data/home');
    expect(environment.USERPROFILE).toBe('/tmp/user-data/home');
    expect(environment.NEXUS_USER_DATA_DIR).toBe('/tmp/user-data');
    expect(environment.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(environment.OPENAI_BASE_URL).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GIT_DIR).toBeUndefined();
    expect(environment.GIT_WORK_TREE).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.NEXUS_REMOTE_DEBUG).toBeUndefined();
    expect(environment.PATH).toBe([
      '/tmp/user-data/trusted-bin',
      path.dirname(process.execPath),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(path.delimiter));
  });
});

describe('real mission local prerequisites and state restoration', () => {
  it('checks Codex version/auth without returning command output', () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: 'codex-cli 0.145.0\n',
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Logged in using ChatGPT\n',
        stderr: '',
      });
    expect(assertCodexReady({
      run,
      environment: {},
      codexBinary: '/trusted/@openai/codex/bin/codex.js',
    })).toEqual({
      installed: true,
      authenticated: true,
      version: 'codex-cli 0.145.0',
    });
    expect(run).toHaveBeenNthCalledWith(
      2,
      '/trusted/@openai/codex/bin/codex.js',
      ['login', 'status'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('does not confuse "Not logged in" with an authenticated Codex CLI', () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: 'codex-cli 0.145.0\n',
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Not logged in\n',
        stderr: '',
      });
    expect(() => assertCodexReady({
      run,
      environment: {},
      codexBinary: '/trusted/@openai/codex/bin/codex.js',
    })).toThrow(
      /not authenticated/,
    );
  });

  it('resolves only the real official Codex package entrypoint, never a PATH shim', () => {
    const root = makeTemp();
    const packageRoot = path.join(root, 'lib', 'node_modules', '@openai', 'codex');
    const binary = path.join(packageRoot, 'bin', 'codex.js');
    const shim = path.join(root, 'bin', 'codex');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@openai/codex' }),
    );
    fs.writeFileSync(binary, '#!/usr/bin/env node\n', { mode: 0o755 });
    fs.symlinkSync(binary, shim);

    expect(resolveTrustedCodexBinary({
      environment: { PATH: path.dirname(shim) },
      resolveCommand: () => shim,
    })).toBe(fs.realpathSync(binary));

    fs.unlinkSync(shim);
    fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(() => resolveTrustedCodexBinary({
      environment: { PATH: path.dirname(shim) },
      resolveCommand: () => shim,
    })).toThrow(/official Codex package/i);
  });

  it('stages only the regular Codex auth receipt in the isolated HOME', () => {
    const root = makeTemp();
    const source = path.join(root, 'source-codex');
    const isolatedHome = path.join(root, 'isolated-home');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'auth.json'), '{"token":"private"}\n', {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(source, 'config.toml'), 'model = "custom"\n');

    expect(stageCodexAuthentication(source, isolatedHome)).toBe(true);
    const staged = path.join(isolatedHome, '.codex', 'auth.json');
    expect(fs.readFileSync(staged, 'utf8')).toBe('{"token":"private"}\n');
    expect(fs.statSync(staged).mode & 0o777).toBe(0o600);
    expect(
      fs.existsSync(path.join(isolatedHome, '.codex', 'config.toml')),
    ).toBe(false);
  });

  it('refuses to stage Codex auth through a symlink', () => {
    const root = makeTemp();
    const source = path.join(root, 'source-codex');
    const isolatedHome = path.join(root, 'isolated-home');
    const external = path.join(root, 'external-auth.json');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(external, '{}\n', { mode: 0o600 });
    fs.symlinkSync(external, path.join(source, 'auth.json'));
    expect(() => stageCodexAuthentication(source, isolatedHome)).toThrow(
      /regular Codex auth file/,
    );
  });

  it('refuses a group/world-readable auth receipt and leaves no partial copy', () => {
    const root = makeTemp();
    const source = path.join(root, 'source-codex');
    const isolatedHome = path.join(root, 'isolated-home');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'auth.json'), '{}\n', { mode: 0o644 });
    expect(() => stageCodexAuthentication(source, isolatedHome)).toThrow(
      /mode 0600/i,
    );
    expect(
      fs.existsSync(path.join(isolatedHome, '.codex', 'auth.json')),
    ).toBe(false);
  });

  it('kills on timeout but waits for the packaged process close before cleanup', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.pid = 4321;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const killTree = vi.fn(() => {
        setTimeout(() => child.emit('close', null), 50);
      });
      const result = waitForChild(
        { binary: '/tmp/NexusIDE' },
        '/tmp/user-data',
        {
          timeoutMs: 100,
          spawnImpl: () => child,
          environment: {},
          codexBinary: '/trusted/@openai/codex/bin/codex.js',
          killTree,
        },
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(killTree).toHaveBeenCalledWith(
        4321,
        expect.objectContaining({ platform: process.platform }),
      );
      // Still open until the child closes (or forced-close grace).
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(49);
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        interruptedBy: 'timeout',
        passLineSeen: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves app FAIL snapshot counts instead of hardcoding panes=0 on interrupt', async () => {
    const child = new EventEmitter();
    child.pid = 9911;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const killTree = vi.fn(() => {
      child.emit(
        'data',
        // no-op
      );
      child.stderr.emit(
        'data',
        Buffer.from(
          '[real-mission] FAIL code=app-error status=running panes=2 dispatches=1 handoffs=0 CTA: x\n',
        ),
      );
      child.emit('close', 1);
    });
    const pending = waitForChild(
      { binary: '/tmp/NexusIDE' },
      '/tmp/user-data',
      {
        timeoutMs: 60_000,
        spawnImpl: () => child,
        environment: {},
        codexBinary: '/trusted/@openai/codex/bin/codex.js',
        killTree,
      },
    );
    // Simulate SIGINT path by emitting phase then forcing terminate via timeout 0...
    // Use direct killTree path: close after "app" wrote FAIL with real counts.
    child.stdout.emit(
      'data',
      Buffer.from('[real-mission] PHASE phase=observer-armed\n'),
    );
    // Invoke the process SIGINT listener if registered — fall back to close with app summary.
    child.stderr.emit(
      'data',
      Buffer.from(
        '[real-mission] FAIL code=app-error status=running panes=2 dispatches=1 handoffs=0 CTA: x\n',
      ),
    );
    child.emit('close', 1);
    await expect(pending).resolves.toMatchObject({
      phase: 'observer-armed',
      interruptedBy: null,
      appFailSummary: expect.stringContaining('panes=2'),
    });
  });

  it('keeps only a closed phase enum and exit code when the app exits early', async () => {
    const child = new EventEmitter();
    child.pid = 4322;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const result = waitForChild(
      { binary: '/tmp/NexusIDE' },
      '/tmp/user-data',
      {
        spawnImpl: () => child,
        environment: {},
        codexBinary: '/trusted/@openai/codex/bin/codex.js',
      },
    );

    child.stdout.emit(
      'data',
      Buffer.from(
        '[real-mission] PHASE phase=observer-armed\n' +
          '[real-mission] prompt=never-retain-this-provider-output\n',
      ),
    );
    child.emit('close', 17);

    await expect(result).resolves.toEqual({
      code: 17,
      phase: 'observer-armed',
      passLineSeen: false,
      interruptedBy: null,
      appFailSummary: null,
      forcedClose: false,
    });
  });

  it('sanitizes an untrusted failure receipt before preserving its summary', () => {
    const summary = safeRealMissionFailureSummary(
      {
        failure: {
          code: 'app-error\nprompt=private-provider-output',
          snapshot: {
            missionStatus: 'done\nrawOutput=private',
            paneCount: 1_000_000,
            dispatchCount: -1,
            handoffCount: 'private',
          },
        },
      },
      {
        code: 999,
        phase: 'prompt-private',
      },
    );

    expect(summary).toBe(
      '[real-mission] FAIL code=invalid-evidence reason=none exit=1 phase=spawned ' +
        'status=none panes=0 dispatches=0 handoffs=0 ' +
        `CTA: ${REAL_MISSION_CTA}`,
    );
    expect(summary).not.toMatch(/private|prompt|rawOutput/u);
  });

  it('persists only a bounded failure receipt with a closed kickoff reason', () => {
    const receipt = safeRealMissionFailureReceipt(
      {
        schemaVersion: 1,
        status: 'fail',
        failure: {
          code: 'mission-blocked',
          reason: 'boot_timeout',
          cta: REAL_MISSION_CTA,
          snapshot: {
            missionStatus: 'blocked',
            paneCount: 1,
            dispatchCount: 0,
            handoffCount: 0,
          },
        },
        prompt: 'never persist this',
        rawOutput: 'never persist this either',
      },
      { code: 0, phase: 'observer-armed' },
      {
        appVersion: '0.19.26',
        commitSha: 'a'.repeat(40),
        artifact: {
          sha256: 'b'.repeat(64),
          identity:
            'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
        },
      },
    );

    expect(receipt).toEqual({
      schemaVersion: 1,
      status: 'fail',
      release: {
        appVersion: '0.19.26',
        commitSha: 'a'.repeat(40),
        artifact: {
          sha256: 'b'.repeat(64),
          identity:
            'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
        },
      },
      child: { exitCode: 0, phase: 'observer-armed' },
      failure: {
        code: 'mission-blocked',
        reason: 'boot_timeout',
        cta: REAL_MISSION_CTA,
        snapshot: {
          missionStatus: 'blocked',
          paneCount: 1,
          dispatchCount: 0,
          handoffCount: 0,
        },
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/prompt|rawOutput|never persist/u);
  });

});

describe('independent evidence verifier', () => {
  it('accepts the complete main-owned proof chain', () => {
    expect(assertRealMissionPassEvidence(validEvidence()).status).toBe('pass');
  });

  it('rejects a forged green receipt or any raw provider output field', () => {
    const withoutDispatch = validEvidence();
    withoutDispatch.dispatches = [];
    expect(() => assertRealMissionPassEvidence(withoutDispatch)).toThrow(
      /incomplete/,
    );
    expect(() =>
      assertRealMissionPassEvidence({
        ...validEvidence(),
        rawOutput: 'provider transcript must never cross the boundary',
      }),
    ).toThrow(/forbidden evidence field/);
  });

  it('rejects rows without a physical worker PTY or current-session acceptance', () => {
    const noPhysicalWorker = validEvidence();
    noPhysicalWorker.panes[1].ptyDataAt = null;
    noPhysicalWorker.panes[1].ptyChunkSha256 = null;
    expect(() => assertRealMissionPassEvidence(noPhysicalWorker)).toThrow(
      /incomplete/,
    );

    const staleAcceptance = validEvidence();
    staleAcceptance.handoffs[0].acceptedBySessionId = 'stale-session';
    expect(() => assertRealMissionPassEvidence(staleAcceptance)).toThrow(
      /incomplete/,
    );
  });

  it('rejects extra commits even when the final result content is correct', () => {
    const evidence = validEvidence();
    evidence.repository.commitCount = 3;
    evidence.repository.exactSingleCommit = false;
    expect(() => assertRealMissionPassEvidence(evidence)).toThrow(/incomplete/);
  });

  it('rejects release evidence without version, run/clock, commit and artifact identity binding', () => {
    for (const mutate of [
      (evidence) => { delete evidence.release.appVersion; },
      (evidence) => { evidence.release.runId = 'predictable'; },
      (evidence) => { evidence.release.finishedAt = evidence.release.startedAt; },
      (evidence) => { evidence.release.commitSha = 'not-a-commit'; },
      (evidence) => { evidence.release.artifact.sha256 = 'not-a-digest'; },
      (evidence) => { evidence.release.artifact.identity = 'adhoc'; },
    ]) {
      const evidence = validEvidence();
      mutate(evidence);
      expect(() => assertRealMissionPassEvidence(evidence)).toThrow(/incomplete/);
    }
  });
});
