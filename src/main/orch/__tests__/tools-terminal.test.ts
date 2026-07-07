import { describe, expect, it } from 'vitest';
import { buildTerminalTools } from '../tools-terminal';

describe('tools-terminal', () => {
  it('nexus_terminal_run executes a simple command', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      { command: 'echo "hello world"', timeoutMs: 5000 },
      fakeCtx(),
    );
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
    );
    expect(result).toHaveProperty('exitCode', 42);
  });

  it('nexus_terminal_run captures stderr', async () => {
    const tools = buildTerminalTools();
    const run = tools.find((t) => t.name === 'nexus_terminal_run')!;
    const result = await run.handler(
      { command: 'echo error >&2', timeoutMs: 5000 },
      fakeCtx(),
    );
    expect(result.stderr).toContain('error');
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