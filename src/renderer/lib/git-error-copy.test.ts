import { describe, expect, it } from 'vitest';
import { gitErrorCopy } from './git-error-copy';

describe('gitErrorCopy — a causa nomeada, não o stderr', () => {
  it('nomeia as causas que o operador realmente encontra', () => {
    const casos: ReadonlyArray<readonly [string, RegExp]> = [
      ['fatal: not a git repository (or any of the parent directories)', /não é um repositório/iu],
      ['nothing to commit, working tree clean', /Não há mudanças para salvar/iu],
      ['no changes added to commit', /Adicionar tudo/iu],
      ['*** Please tell me who you are.', /quem é você/iu],
      ['Permission denied (publickey). fatal: Could not read from remote repository.', /Sem acesso ao repositório remoto/iu],
      ['CONFLICT (content): Merge conflict in src/app.ts', /conflitos/iu],
      ['fatal: Unable to create index.lock: File exists', /Outra operação de Git/iu],
    ];
    for (const [raw, esperado] of casos) {
      expect(gitErrorCopy(raw).message).toMatch(esperado);
    }
  });

  it('nunca devolve o texto cru como mensagem', () => {
    const raw = 'fatal: alguma coisa em ingles com exit code 128 em /Users/x/y';
    const copy = gitErrorCopy(raw, 'commit');
    expect(copy.message).not.toContain('exit code');
    expect(copy.message).not.toContain('/Users/');
    expect(copy.message).toBe(
      'Não foi possível salvar as mudanças. Veja os detalhes técnicos.',
    );
  });

  it('preserva o original para o disclosure técnico', () => {
    const copy = gitErrorCopy(new Error('fatal: index.lock exists'));
    expect(copy.detail).toBe('fatal: index.lock exists');
  });

  it('a frase de fallback muda com a ação', () => {
    expect(gitErrorCopy('???', 'diff').message).toMatch(/diferenças/iu);
    expect(gitErrorCopy('???', 'stage').message).toMatch(/marcar/iu);
    expect(gitErrorCopy('???', 'desconhecida').message).toMatch(/operação de Git/iu);
  });

  it('erro não-Error não quebra', () => {
    expect(gitErrorCopy(undefined).detail).toBe('');
    expect(gitErrorCopy(null).message).toBeTruthy();
  });
});
