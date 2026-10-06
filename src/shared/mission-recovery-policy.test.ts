import { describe, expect, it } from 'vitest';
import type { MissionIntentContract } from './mission-intent';
import {
  formatRecoveryAttemptBlock,
  hasAutomaticTechnicalRecovery,
  hasCurrentMissionRuntimeCloseVerdict,
  parseRecoveryAttemptBlock,
  RECOVERY_ATTEMPT_BLOCK_MARKER,
  replaceRecoveryAttemptBlock,
  TERMINAL_OPERATIONAL_FAILURE_MARKER,
  wasMissionRuntimeClosedByOperator,
} from './mission-recovery-policy';

const RUNTIME_CLOSED_VERDICT =
  '<!-- nexus:runtime-closed -->\n' +
  '[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador; histórico e receipts preservados.';
const AGENT_BLOCK_VERDICT =
  '<!-- nexus:agent-status-block -->\n' +
  '[NEXUS_AGENT_STATUS_BLOCK] O orquestrador declarou status=blocked: pergunta de escopo sem resposta.';

function blockedMission(...paragraphs: string[]) {
  return {
    status: 'blocked',
    intentState: 'blocked_user',
    description: paragraphs.join('\n\n'),
  };
}

describe('wasMissionRuntimeClosedByOperator (F-738)', () => {
  it('o selo como último veredito prova o encerramento pelo operador', () => {
    expect(
      wasMissionRuntimeClosedByOperator(blockedMission('objetivo', RUNTIME_CLOSED_VERDICT)),
    ).toBe(true);
  });

  it('bloqueio do Maestro depois de um selo velho não é encerramento (caso de 02/10)', () => {
    // O selo sobreviveu à retomada das 09:14; às 10:01 o Maestro bloqueou a
    // missão esperando o operador. Lida como "encerrada", ela ia para o
    // Arquivo e o Retomar seguia o caminho errado.
    expect(
      wasMissionRuntimeClosedByOperator(
        blockedMission('objetivo', RUNTIME_CLOSED_VERDICT, AGENT_BLOCK_VERDICT),
      ),
    ).toBe(false);
  });

  it('"dormindo" depois do selo não o substitui', () => {
    expect(
      wasMissionRuntimeClosedByOperator(
        blockedMission(
          RUNTIME_CLOSED_VERDICT,
          '<!-- nexus:leftover-parked -->\n[NEXUS_LEFTOVER_PARKED] sessão antiga.',
        ),
      ),
    ).toBe(true);
  });

  it('só missão blocked pode estar encerrada', () => {
    expect(
      wasMissionRuntimeClosedByOperator({
        status: 'running',
        intentState: 'executing',
        description: RUNTIME_CLOSED_VERDICT,
      }),
    ).toBe(false);
    expect(wasMissionRuntimeClosedByOperator(blockedMission('objetivo'))).toBe(false);
  });
});

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


it('F-429: the latest Stop verdict survives inconsistent running status, without changing UI classification', () => {
  const legacy = { ...blockedMission(RUNTIME_CLOSED_VERDICT), status: 'running', intentState: 'executing' };
  expect(hasCurrentMissionRuntimeCloseVerdict(legacy)).toBe(true);
  expect(wasMissionRuntimeClosedByOperator(legacy)).toBe(false);
  expect(hasCurrentMissionRuntimeCloseVerdict(blockedMission(RUNTIME_CLOSED_VERDICT, '<!-- nexus:leftover-parked --> Dormindo'))).toBe(true);
  expect(hasCurrentMissionRuntimeCloseVerdict(blockedMission(RUNTIME_CLOSED_VERDICT, AGENT_BLOCK_VERDICT))).toBe(false);
});
