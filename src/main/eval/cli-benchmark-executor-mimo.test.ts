import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mimoRaw from '../../adapters/builtin/mimo-code.json';
import { adapterSchema } from '../../shared/adapter-types';
import { createCliBenchmarkExecutor } from './cli-benchmark-executor';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../adapters/adapter-registry', () => ({ getAdapter: vi.fn() }));

const mimo = adapterSchema.parse(mimoRaw);
if (mimo.kind !== 'cli-pty') throw new Error('MiMo must expose the CLI benchmark path');

describe('MiMo registered benchmark contract', () => {
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

  it.each(mimo.models.list)('passes the exact model %s to the official headless CLI', async (modelId) => {
    const executor = createCliBenchmarkExecutor({
      resolveAdapter: (id) => id === 'mimo-code' ? mimo : null,
      cwd: process.cwd(), allowExternalExecution: true,
      baseEnv: { PATH: '/test/bin', XIAOMI_API_KEY: 'sk-api-fixture', UNRELATED_SECRET: 'not-forwarded' },
    });
    const result = await executor({
      caseId: 'case-1', prompt: 'literal; $HOME',
      subject: { id: `mimo-code/${modelId}`, adapterId: 'mimo-code', modelId },
    });
    expect(result.answer).toBe('benchmark answer');
    expect(spawn).toHaveBeenCalledWith('mimo', [
      'run', 'literal; $HOME', '--model', modelId,
    ], expect.objectContaining({
      shell: false,
      env: expect.objectContaining({ PATH: '/test/bin', XIAOMI_API_KEY: 'sk-api-fixture', MIMOCODE_DISABLE_AUTOUPDATE: '1', MIMOCODE_HOME: expect.stringContaining('nexus-mimo-benchmark-') }),
    }));
  });

  it('does not spawn a fabricated MiMo variant', async () => {
    const executor = createCliBenchmarkExecutor({
      resolveAdapter: () => mimo, cwd: process.cwd(), allowExternalExecution: true,
    });
    await expect(executor({
      caseId: 'case-1', prompt: 'test',
      subject: { id: 'unknown', adapterId: 'mimo-code', modelId: 'xiaomi/mimo-v9' },
    })).rejects.toThrow('benchmark model is not available');
    expect(spawn).not.toHaveBeenCalled();
  });
});
