import { describe, expect, it, vi } from 'vitest';
import { createDestructiveReversibilityPreparer } from './destructive-reversibility-production';
import type { ReversibilityIo } from './destructive-reversibility-io';

function io(overrides: Partial<ReversibilityIo> = {}): ReversibilityIo {
  return {
    trash: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    revParse: vi.fn(async () => 'c'.repeat(40)),
    updateRef: vi.fn(async () => {}),
    resolvePath: (cwd, target) => `${cwd}/${target}`,
    ...overrides,
  };
}

describe('preparador de produção', () => {
  it('devolve a frase de desfazer que o operador vai ler', async () => {
    const prepare = createDestructiveReversibilityPreparer(io(), () => 42);
    const result = await prepare({
      command: 'git reset --hard HEAD~1',
      cwd: '/repo',
    });

    expect(result.reversible).toBe(true);
    expect(result.revertPath).toContain('refs/nexus-undo/head-42');
  });

  it('manda para a lixeira antes de o comando existir', async () => {
    const trash = vi.fn(async () => {});
    const prepare = createDestructiveReversibilityPreparer(io({ trash }));
    await prepare({ command: 'rm -rf dist', cwd: '/repo' });

    expect(trash).toHaveBeenCalledWith('/repo/dist');
  });

  /**
   * A regra que sustenta a remoção do prompt: se o desfazer não pôde ser
   * construído, a rejeição SOBE e o dispatch aborta antes do efeito. Engolir
   * aqui trocaria a fricção que o dono removeu por perda de dados silenciosa —
   * o único desfecho pior que a pergunta.
   */
  it('preparo que falha rejeita, para o comando destrutivo não rodar', async () => {
    const prepare = createDestructiveReversibilityPreparer(
      io({
        trash: vi.fn(async () => {
          throw new Error('lixeira indisponível');
        }),
      }),
    );

    await expect(
      prepare({ command: 'rm -rf dist', cwd: '/repo' }),
    ).rejects.toThrow('lixeira indisponível');
  });

  it('irreversível é declarado, não silenciado', async () => {
    const prepare = createDestructiveReversibilityPreparer(io());
    const result = await prepare({ command: 'DROP TABLE users;', cwd: '/repo' });

    expect(result.reversible).toBe(false);
    expect(result.revertPath).toContain('Sem desfazer');
  });
});
