import { describe, expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { createCliBenchmarkExecutor } from './cli-benchmark-executor';

function adapter(headless: string[], promptMethod: 'arg' | 'stdin' = 'arg'): CliPtyAdapter {
  return {
    kind: 'cli-pty',
    id: 'fake-cli',
    label: 'Fake CLI',
    version: '1',
    icon: 'F',
    bin: process.execPath,
    detect: `${process.execPath} --version`,
    install: { method: 'manual', command: 'test-only' },
    auth: { method: 'none' },
    spawn: {
      interactive: [process.execPath],
      headless,
      ptyRequired: false,
      resumeArgs: [],
      extraArgs: [],
    },
    env: { static: {}, passthrough: [], ephemeralHome: false },
    models: { flag: '', list: ['fake-model'], default: 'fake-model' },
    promptInjection: { method: promptMethod, trailingNewline: false, bracketedPaste: false },
    stateParsing: { idle: { type: 'timeout', ms: 100 }, shellIntegration: false, busy: undefined, exitCodes: {} },
    quirks: { altScreen: false, requiresNoAutoUpdate: false, mcpAutoload: false, nexusMcp: 'none' },
    control: {},
  };
}

const subject = { id: 'fake', adapterId: 'fake-cli', modelId: 'fake-model' };

describe('CLI benchmark executor', () => {
  it('uses argv/stdin without a shell and preserves prompt data as output', async () => {
    const fake = adapter([
      process.execPath,
      '-e',
      'process.stdout.write(process.argv[1] ?? "")',
      '{{PROMPT}}',
    ]);
    const executor = createCliBenchmarkExecutor({
      resolveAdapter: () => fake,
      cwd: process.cwd(),
      baseEnv: { PATH: process.env.PATH },
      allowExternalExecution: true,
    });

    const result = await executor({
      caseId: 'case-1',
      prompt: 'literal; $HOME && never execute',
      subject,
    });

    expect(result.answer).toBe('literal; $HOME && never execute');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('supports stdin prompt injection and blocks external execution by default', async () => {
    const fake = adapter([
      process.execPath,
      '-e',
      'process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => process.stdout.write(chunk))',
    ], 'stdin');
    const options = { resolveAdapter: () => fake, cwd: process.cwd(), baseEnv: {} };
    const disabled = createCliBenchmarkExecutor(options);
    await expect(disabled({ caseId: 'case-1', prompt: 'blocked', subject })).rejects.toThrow(
      /allowExternalExecution/,
    );

    const enabled = createCliBenchmarkExecutor({ ...options, allowExternalExecution: true });
    const result = await enabled({ caseId: 'case-1', prompt: 'stdin payload', subject });
    expect(result.answer).toBe('stdin payload');
  });

  it('rejects a model outside the resolved adapter catalog before executing the CLI', async () => {
    const resolveAdapter = vi.fn(() => adapter([process.execPath, '-e', 'process.exit(99)', '{{PROMPT}}']));
    const executor = createCliBenchmarkExecutor({
      resolveAdapter, cwd: process.cwd(), allowExternalExecution: true,
    });
    await expect(executor({
      caseId: 'case-1', prompt: 'test', subject: { ...subject, modelId: 'unknown-model' },
    })).rejects.toThrow('benchmark model is not available for adapter fake-cli');
  });
});
