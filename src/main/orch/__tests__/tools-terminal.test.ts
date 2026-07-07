import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildTerminalTools } from '../tools-terminal';

const workspace = vi.hoisted(() => ({ current: '' }));
vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-terminal');

describe('tools-terminal', () => {
  beforeAll(() => {
    workspace.current = testDir;
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('nexus_terminal_run executes a simple command', async () => {
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

  it('nexus_terminal_run returns exit code for failed commands', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      { command: 'exit 42', timeoutMs: 5000 },
      fakeCtx(),
    ) as { exitCode: number };
    expect(result).toHaveProperty('exitCode', 42);
  });

  it('nexus_terminal_run captures stderr', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      { command: 'echo error >&2', timeoutMs: 5000 },
      fakeCtx(),
    ) as { stderr: string };
    expect(result.stderr).toContain('error');
  });

  it('denies cwd outside the active workspace', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    await expect(
      run.handler({ command: 'pwd', cwd: os.tmpdir(), timeoutMs: 5000 }, fakeCtx()),
    ).rejects.toThrow(/escapes workspace/);
  });

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
  };
}
