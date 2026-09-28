import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildTerminalTools,
  resolveTerminalSandboxProfile,
} from '../tools-terminal';
import { testProjectScope } from './scope-fixture';
import { processSandboxRuntimeAvailable } from '../../runtime/process-sandbox-capability';

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-terminal');
/** Real exec through Seatbelt/bwrap — skip when host userns is blocked (GHA Linux). */
const sandboxAvailable = processSandboxRuntimeAvailable();
const itSandboxed = it.runIf(sandboxAvailable);

describe('tools-terminal', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('defaults foreground commands to web in Autopilot and keeps Hardened strict', () => {
    expect(resolveTerminalSandboxProfile('', 'operator-choice')).toBe(
      'workspace-net',
    );
    expect(resolveTerminalSandboxProfile('', 'governed')).toBeUndefined();
    expect(
      resolveTerminalSandboxProfile('workspace-only', 'operator-choice'),
    ).toBe('workspace-only');
    expect(resolveTerminalSandboxProfile('yolo', 'governed')).toBe('yolo');
  });

  itSandboxed('nexus_terminal_run executes a simple command', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      { command: 'echo "hello world"', timeoutMs: 5000 },
      fakeCtx(),
    ) as { exitCode: number; stdout: string };
    expect(result).toHaveProperty('exitCode', 0);
    expect(result).toHaveProperty('stdout');
    expect(result.stdout).toContain('hello world');
  });

  itSandboxed('nexus_terminal_run returns exit code for failed commands', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      { command: 'exit 42', timeoutMs: 5000 },
      fakeCtx(),
    ) as { exitCode: number };
    expect(result).toHaveProperty('exitCode', 42);
  });

  itSandboxed('nexus_terminal_run captures stderr', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      { command: 'echo error >&2', timeoutMs: 5000 },
      fakeCtx(),
    ) as { stderr: string };
    expect(result.stderr).toContain('error');
  });

  itSandboxed('drops environment variables outside the allowlist', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      {
        command: 'node -e "console.log(process.env.NODE_OPTIONS || \\"missing\\")"',
        timeoutMs: 5000,
        env: { NODE_OPTIONS: '--require ./malicious.js' },
      },
      fakeCtx(),
    ) as { stdout: string };
    expect(result.stdout.trim()).toBe('missing');
  });

  itSandboxed('caps stdout at 1 MB with a truncation marker', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      {
        command: 'node -e "process.stdout.write(\\"x\\".repeat(1024 * 1024 + 10))"',
        timeoutMs: 5000,
      },
      fakeCtx(),
    ) as { stdout: string };
    expect(result.stdout).toContain('[TRUNCATED: output exceeded 1048576 bytes]');
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1024 * 1024 + 200);
  });

  it('denies cwd outside the active workspace', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    await expect(
      run.handler({ command: 'pwd', cwd: os.tmpdir(), timeoutMs: 5000 }, fakeCtx()),
    ).rejects.toThrow(/escapes workspace/);
  });

  it.runIf(process.platform === 'darwin' && sandboxAvailable)(
    'denies absolute reads and writes outside the project',
    async () => {
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'nexus-terminal-outside-'),
      );
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'outside-secret', { mode: 0o600 });
      try {
        const tools = buildTerminalTools();
        const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
        const result = await run.handler(
          {
            command:
              `cat ${JSON.stringify(outsideFile)}; ` +
              `printf hacked > ${JSON.stringify(outsideFile)}`,
            timeoutMs: 5000,
          },
          fakeCtx(),
        ) as { exitCode: number; stdout: string; stderr: string };

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).not.toContain('outside-secret');
        expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside-secret');
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'darwin' && sandboxAvailable)(
    'terminates the whole process group on timeout',
    async () => {
      const pidFile = path.join(testDir, 'child.pid');
      fs.rmSync(pidFile, { force: true });
      const tools = buildTerminalTools();
      const run = tools.find((t) => t.name === 'nexus_terminal_run')!;

      // Write $$ before parking so the kill window cannot race the pidfile.
      // `exec sleep` keeps the same pid/process-group identity under Seatbelt.
      const result = await run.handler(
        {
          command: `printf '%s' "$$" > ${JSON.stringify(pidFile)}; exec sleep 60`,
          timeoutMs: 1_500,
        },
        fakeCtx(),
      ) as { killed: boolean };

      expect(result.killed).toBe(true);
      expect(fs.existsSync(pidFile)).toBe(true);
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(childPid).toBeGreaterThan(0);
      // FLAKE: SIGKILL no grupo é assíncrono — o kernel só reap depois.
      // Espera limitada: o que o teste prova é que o processo MORRE.
      const deadline = Date.now() + 5_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    },
  );

  it('nexus_terminal_kill returns ok when no process', async () => {
    const tools = buildTerminalTools();
    const kill = tools.find((t) => t.name === 'nexus_terminal_kill')!;
    const result = await kill.handler({}, fakeCtx());
    expect(result).toHaveProperty('killed', false);
  });
});

function fakeCtx() {
  return {
    token: 'test',
    label: 'test',
    role: 'user' as const,
    allowedTools: null as string[] | null,
    allowedSkills: null as string[] | null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope: testProjectScope({ rootRealPath: fs.realpathSync(testDir) }),
  };
}
