import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import minimaxRaw from '../../adapters/builtin/minimax-code.json';
import { adapterSchema } from '../../shared/adapter-types';
import { createCliBenchmarkExecutor } from './cli-benchmark-executor';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../adapters/adapter-registry', () => ({ getAdapter: vi.fn() }));

const minimax = adapterSchema.parse(minimaxRaw);
if (minimax.kind !== 'cli-pty') throw new Error('MiniMax must expose the CLI benchmark path');

describe('MiniMax registered benchmark contract', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.write('benchmark answer');
        child.emit('close', 0, null);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
  });

  it.each(minimax.models.list)('passes the exact model %s to the official headless CLI', async (modelId) => {
    const executor = createCliBenchmarkExecutor({
      resolveAdapter: (id) => id === 'minimax-code' ? minimax : null,
      cwd: process.cwd(), allowExternalExecution: true,
      baseEnv: { PATH: '/test/bin', MINIMAX_API_KEY: 'sk-fixture', UNRELATED_SECRET: 'not-forwarded' },
    });
    const result = await executor({
      caseId: 'case-1', prompt: '-leading-dash; $HOME',
      subject: { id: `minimax-code/${modelId}`, adapterId: 'minimax-code', modelId },
    });
    expect(result.answer).toBe('benchmark answer');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(file).toBe('mcode');
    // `--` keeps a prompt that starts with `-` from being read as an option.
    expect(args).toEqual([
      'exec', '--output-format', 'text', '--model', modelId, '--', '-leading-dash; $HOME',
    ]);
    expect(args.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(opts?.shell).toBe(false);
    // OAuth lives in ~/.minimax (HOME is allowlisted); no key or foreign secret leaks.
    expect(opts?.env).toEqual({ PATH: '/test/bin' });
  });

  it('does not spawn a fabricated MiniMax variant', async () => {
    const executor = createCliBenchmarkExecutor({
      resolveAdapter: () => minimax, cwd: process.cwd(), allowExternalExecution: true,
    });
    await expect(executor({
      caseId: 'case-1', prompt: 'test',
      subject: { id: 'unknown', adapterId: 'minimax-code', modelId: 'minimax/MiniMax-M9' },
    })).rejects.toThrow('benchmark model is not available');
    expect(spawn).not.toHaveBeenCalled();
  });
});
