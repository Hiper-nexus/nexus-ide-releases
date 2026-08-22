import { describe, expect, it } from 'vitest';
import type { MissionIntentContract } from './mission-intent';
import {
  formatRecoveryAttemptBlock,
  hasAutomaticTechnicalRecovery,
  parseRecoveryAttemptBlock,
  RECOVERY_ATTEMPT_BLOCK_MARKER,
  replaceRecoveryAttemptBlock,
  TERMINAL_OPERATIONAL_FAILURE_MARKER,
} from './mission-recovery-policy';

function approvedContract(): MissionIntentContract {
  return {
    goal: 'Corrigir o projeto',
    intentVersion: 3,
    approvedAt: 100,
  } as MissionIntentContract;
}

describe('hasAutomaticTechnicalRecovery', () => {
  it('accepts only a current approved technical block', () => {
    expect(
      hasAutomaticTechnicalRecovery({
        status: 'blocked',
        intentState: 'blocked_technical',
        description: 'Falha transitória.',
        intentVersion: 3,
        intentContract: approvedContract(),
      }),
    ).toBe(true);
    expect(
      hasAutomaticTechnicalRecovery({
        status: 'blocked',
        intentState: 'dispatched',
        description: 'Persistência legada desalinhada.',
        intentVersion: 3,
        intentContract: approvedContract(),
      }),
    ).toBe(true);
  });

  it('rejects terminal, stale and human blocks', () => {
    const base = {
      status: 'blocked',
      intentState: 'blocked_technical',
      description: 'Falha transitória.',
      intentVersion: 3,
      intentContract: approvedContract(),
    };

    expect(
      hasAutomaticTechnicalRecovery({
        ...base,
        description: `${TERMINAL_OPERATIONAL_FAILURE_MARKER} autoridade divergente`,
      }),
    ).toBe(false);
    expect(
      hasAutomaticTechnicalRecovery({ ...base, intentVersion: 4 }),
    ).toBe(false);
    expect(
      hasAutomaticTechnicalRecovery({
        ...base,
        intentState: 'blocked_user',
      }),
    ).toBe(false);
  });

  it('rejects pre-boot leftovers — nenhum retry vivo é dono delas', () => {
    const base = {
      status: 'blocked',
      intentState: 'blocked_technical',
      description: 'Falha transitória.',
      intentVersion: 3,
      intentContract: approvedContract(),
    };
    // Linha tocada por ESTE processo: recovery continua de pé.
    expect(
      hasAutomaticTechnicalRecovery({ ...base, updatedAt: Date.now() }),
    ).toBe(true);
    // Linha de um boot anterior: sem dono vivo, não prometer "Recuperando".
    expect(
      hasAutomaticTechnicalRecovery({ ...base, updatedAt: 1 }),
    ).toBe(false);
    // Quem não sabe a idade da linha falha aberto (comportamento anterior).
    expect(hasAutomaticTechnicalRecovery(base)).toBe(true);
  });
});

describe('bloco de tentativa de recuperação automática', () => {
  const at = '2026-08-03T12:00:00.000Z';

  it('format escreve e parse lê de volta os mesmos dados', () => {
    const block = formatRecoveryAttemptBlock(3, 8, 'timeout no resume', at);
    const parsed = parseRecoveryAttemptBlock(`histórico\n\n${block}`);
    expect(parsed).toEqual({
      attempt: 3,
      maxAttempts: 8,
      reason: 'timeout no resume',
      at,
    });
  });

  it('corta a razão em 240 caracteres', () => {
    const block = formatRecoveryAttemptBlock(1, 8, 'x'.repeat(500), at);
    const parsed = parseRecoveryAttemptBlock(block);
    expect(parsed?.reason).toBe(`${'x'.repeat(240)}…`);
  });

  it('preserva " · " dentro da razão sem confundir com o timestamp', () => {
    const block = formatRecoveryAttemptBlock(
      2,
      8,
      'lock ocupado · fila cheia',
      at,
    );
    const parsed = parseRecoveryAttemptBlock(block);
    expect(parsed?.reason).toBe('lock ocupado · fila cheia');
    expect(parsed?.at).toBe(at);
  });

  it('devolve null para descrição sem marcador ou bloco rasgado', () => {
    expect(parseRecoveryAttemptBlock('sem nada aqui')).toBeNull();
    expect(
      parseRecoveryAttemptBlock(
        `${RECOVERY_ATTEMPT_BLOCK_MARKER}\n## Recuperação automática\nlinha rasgada`,
      ),
    ).toBeNull();
  });

  it('substitui o bloco anterior em vez de empilhar', () => {
    const first = formatRecoveryAttemptBlock(1, 8, 'primeira', at);
    const withFirst = replaceRecoveryAttemptBlock('objetivo da missão', first);
    const second = formatRecoveryAttemptBlock(2, 8, 'segunda', at);
    const replaced = replaceRecoveryAttemptBlock(withFirst, second);

    expect(replaced).toContain('Tentativa 2 de 8');
    expect(replaced).not.toContain('Tentativa 1 de 8');
    expect(replaced).toContain('objetivo da missão');
    expect(
      replaced.split(RECOVERY_ATTEMPT_BLOCK_MARKER).length - 1,
    ).toBe(1);
  });

  it('preserva a seção seguinte ao bloco substituído', () => {
    const first = formatRecoveryAttemptBlock(1, 8, 'primeira', at);
    const description = `objetivo\n\n${first}\n\n## Learnings\n- algo`;
    const second = formatRecoveryAttemptBlock(2, 8, 'segunda', at);
    const replaced = replaceRecoveryAttemptBlock(description, second);

    expect(replaced).toContain('## Learnings\n- algo');
    expect(parseRecoveryAttemptBlock(replaced)?.attempt).toBe(2);
  });
});
