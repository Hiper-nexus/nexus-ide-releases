import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ on: vi.fn(), trace: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { on: hoisted.on } }));
vi.mock('../observability/main-trace', () => ({ trace: hoisted.trace }));

import { GitCommandError } from './git-command';
import { bootStep, bootStepAsync, describeBootFailure } from './git-boot-guard';

function gitFailure(code: string): GitCommandError {
  return new GitCommandError(
    'Git process could not complete',
    ['rev-parse', '--show-toplevel'],
    {},
    Object.assign(new Error(`spawnSync git ${code}`), { code }),
  );
}

describe('passos do boot e falha de git', () => {
  beforeEach(() => {
    hoisted.trace.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('um passo que dá certo devolve o valor e não registra nada', () => {
    expect(bootStep('configure', () => 42)).toBe(42);
    expect(hoisted.trace).not.toHaveBeenCalled();
  });

  it('falha de git num passo é registrada e o boot segue (passo devolve undefined)', () => {
    const result = bootStep('initUsageTelemetry', () => {
      throw gitFailure('ETIMEDOUT');
    });
    expect(result).toBeUndefined();
    expect(hoisted.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'git-ipc-failure',
        where: 'boot:initUsageTelemetry',
        subcommand: 'rev-parse',
        reason: 'ETIMEDOUT',
      }),
    );
  });

  it('erro que não é de git num passo continua derrubando o boot', () => {
    expect(() =>
      bootStep('registerPtyIpc', () => {
        throw new TypeError('bug de programação');
      }),
    ).toThrow(TypeError);
    expect(hoisted.trace).not.toHaveBeenCalled();
  });

  it('versão assíncrona: falha de git é registrada e o boot segue', async () => {
    const result = await bootStepAsync('nativeHeavyJobEnvironment', async () => {
      throw gitFailure('ENOBUFS');
    });
    expect(result).toBeUndefined();
    expect(hoisted.trace).toHaveBeenCalledWith(
      expect.objectContaining({ where: 'boot:nativeHeavyJobEnvironment', reason: 'ENOBUFS' }),
    );
  });

  it('versão assíncrona: erro que não é de git continua rejeitando', async () => {
    await expect(
      bootStepAsync('initUsageTelemetry', async () => {
        throw new Error('bug de programação');
      }),
    ).rejects.toThrow('bug de programação');
  });

  it('describeBootFailure resume o erro com nome, mensagem e código', () => {
    const error = Object.assign(new Error('falha de leitura'), { code: 'EACCES' });
    expect(describeBootFailure(error)).toBe('Error: falha de leitura (EACCES)');
    expect(describeBootFailure('texto solto')).toBe('texto solto');
  });
});
