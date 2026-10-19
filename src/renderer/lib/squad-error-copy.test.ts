import { describe, expect, it } from 'vitest';
import { squadErrorCopy } from './squad-error-copy';

describe('squadErrorCopy (F-1577)', () => {
  it('troca a recusa crua de escopo do Main por uma instrução em português', () => {
    expect(
      squadErrorCopy('renderer has no authorized workspace scope', 'importar equipes'),
    ).toBe('Abra um projeto para importar equipes.');
    expect(
      squadErrorCopy(
        "Error invoking remote method 'orch:squads.save': Error: renderer has no authorized workspace scope",
        'salvar a equipe',
      ),
    ).toBe('Abra um projeto para salvar a equipe.');
  });

  it('mantém as outras mensagens como vieram', () => {
    expect(squadErrorCopy('O nome do squad já existe.', 'salvar a equipe')).toBe(
      'O nome do squad já existe.',
    );
  });
});
