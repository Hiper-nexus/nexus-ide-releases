import { describe, expect, it } from 'vitest';
import {
  missionBlockCause,
  missionBlockCauseText,
  MISSION_BLOCK_CAUSE_TEXT_LIMIT,
} from './mission-block-cause';
import { orphanSealedPlanMessage } from './mission-plan-orphan';

/**
 * O operador só decide se souber O QUE aconteceu e O QUE fazer. Estes testes
 * fixam o texto EXATO por causa — a regressão que interessa é voltar a dizer
 * "aguardando decisão" quando a razão real existe e é durável.
 */

const blocked = (description: string, intentState = 'blocked_technical') => ({
  status: 'blocked',
  intentState,
  description,
});

describe('missionBlockCause — uma causa nomeada por caso', () => {
  it('falha de despacho: o despacho abortou antes do worker começar', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo do operador\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\nA transação de despacho abortou.\n',
      ),
    );

    expect(cause.code).toBe('dispatch-failed');
    expect(cause.headline).toBe(
      'O despacho da tarefa abortou antes de o worker começar.',
    );
    expect(cause.action).toBe(
      'Abra o diagnóstico da missão e clique em Retomar missão.',
    );
  });

  it('worker sem handoff: o worker encerrou sem entregar', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n' +
          '[NEXUS_FAILURE:terminal] O worker não entregou um handoff após 3 tentativas físicas.\n',
      ),
    );

    expect(cause.code).toBe('worker-no-handoff');
    expect(cause.headline).toBe(
      'O worker encerrou sem entregar o resultado da tarefa.',
    );
    expect(cause.action).toBe(
      'Confira login e cota do provider em Providers e retome a missão.',
    );
  });

  it('provider indisponível: a CLI do roster não está utilizável', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n## Rota\nroster_route_unavailable: CLI codex do agente Scout A não está instalada\n',
      ),
    );

    expect(cause.code).toBe('provider-unavailable');
    expect(cause.headline).toBe(
      'A CLI selada no roster não está disponível para esta tarefa.',
    );
    expect(cause.action).toBe(
      'Abra Providers, corrija instalação ou login, e retome a missão.',
    );
  });

  it('conflito de ownership: o worktree já está reservado', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_INTERRUPTED_WORKTREE_RESERVATION] reserva pendente\n',
      ),
    );

    expect(cause.code).toBe('ownership-conflict');
    expect(cause.headline).toBe(
      'Outra tarefa já reservou os mesmos arquivos desta missão.',
    );
    expect(cause.action).toBe(
      'Abra o diagnóstico, libere a reserva presa e retome a missão.',
    );
  });

  it('handoff não entregue: o resultado não chegou ao orquestrador', () => {
    const cause = missionBlockCause(
      blocked('objetivo\n\n<!-- nexus:handoff-delivery-failed:h1 -->\n'),
    );

    expect(cause.code).toBe('handoff-not-delivered');
    expect(cause.headline).toBe(
      'O worker terminou, mas a entrega não chegou ao orquestrador.',
    );
    expect(cause.action).toBe(
      'Abra o diagnóstico da missão e reenvie a entrega pendente.',
    );
  });

  it('decisão humana de verdade: só quando existe pergunta pendente', () => {
    const cause = missionBlockCause({
      status: 'blocked',
      intentState: 'blocked_user',
      description: 'objetivo do operador',
      pendingQuestion: true,
    });

    expect(cause.code).toBe('human-decision');
    expect(cause.headline).toBe('A missão está esperando uma resposta sua.');
    expect(cause.action).toBe('Abra a missão e responda a pergunta pendente.');
  });

  it('a pergunta pendente vence a nota técnica — é o que o operador faz agora', () => {
    const cause = missionBlockCause({
      status: 'blocked',
      intentState: 'blocked_user',
      description: 'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\nfalhou\n',
      pendingQuestion: true,
    });

    expect(cause.code).toBe('human-decision');
  });
});

describe('missionBlockCause — plano selado órfão', () => {
  it('nomeia o plano preso numa versão anterior da intenção', () => {
    const cause = missionBlockCause(
      blocked(
        `objetivo\n\n## Plano\n${orphanSealedPlanMessage({
          missionIntentVersion: 2,
          sealedIntentVersions: [1],
        })}\n`,
      ),
    );

    expect(cause.code).toBe('orphan-plan');
    expect(cause.headline).toBe(
      'O plano selado ficou numa versão anterior da intenção.',
    );
    expect(cause.action).toBe(
      'Retome a missão para re-selar o plano na versão atual.',
    );
  });

  it('o órfão vence os outros marcadores — é a causa-raiz', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n' +
          'orphan_sealed_plan: o plano selado está na versão 1 da intenção\n',
      ),
    );

    expect(cause.code).toBe('orphan-plan');
  });
});

describe('missionBlockCause — descrição real de campo', () => {
  // Copiada de uma missão bloqueada de verdade no runtime.sqlite3 do operador.
  const FIELD = [
    'quero testar o nexus ao extremo onde possa ver todos os panes trabalhando',
    '',
    '[NEXUS_TASK_DISPATCH_BLOCKED]',
    '## Worker bloqueado',
    '[NEXUS_FAILURE:terminal] O worker não entregou um handoff após 3 tentativas físicas. Isso normalmente indica autenticação, configuração ou falha persistente da CLI. Corrija a sessão do provider e retome a missão. Última causa: O worker encerrou sem entregar um handoff confiável.',
    'Clique em “Retomar missão” para revisar a tarefa e escolher a próxima ação.',
    '',
    '<!-- nexus:kickoff-not-accepted -->',
    '<!-- nexus:kickoff-failure:timeout -->',
    '## Kickoff não aceito',
    'O terminal não confirmou o início do turno após o envio.',
  ].join('\n');

  it('escolhe a causa mais específica, não o primeiro marcador gravado', () => {
    const cause = missionBlockCause(blocked(FIELD));

    expect(cause.code).toBe('worker-no-handoff');
    expect(missionBlockCauseText(cause)).toBe(
      'O worker encerrou sem entregar o resultado da tarefa. ' +
        'Confira login e cota do provider em Providers e retome a missão.',
    );
  });

  it('o objetivo do operador nunca vira "causa"', () => {
    expect(missionBlockCause(blocked(FIELD)).detail).not.toContain(
      'quero testar o nexus',
    );
  });
});

describe('missionBlockCause — honestidade quando a causa não existe', () => {
  it('bloqueio sem nenhuma nota durável admite que não sabe', () => {
    const cause = missionBlockCause({
      status: 'blocked',
      intentState: 'blocked_user',
      description: 'quero testar o nexus ao extremo',
    });

    expect(cause.code).toBe('unknown');
    expect(cause.headline).toBe('Motivo não registrado.');
    expect(cause.action).toBe('Abra o diagnóstico da missão para ver o que aconteceu.');
    expect(cause.detail).toBeNull();
  });

  it('descrição vazia/ausente também é honesta, nunca inventa', () => {
    expect(missionBlockCause({ status: 'blocked' }).code).toBe('unknown');
    expect(missionBlockCause({ status: 'blocked', description: null }).code).toBe(
      'unknown',
    );
  });

  it('nunca promete "aguardando decisão" sem pergunta pendente', () => {
    const cause = missionBlockCause({
      status: 'blocked',
      intentState: 'blocked_user',
      description: 'objetivo',
    });

    expect(`${cause.headline} ${cause.action}`).not.toMatch(/aguardando decis/iu);
  });
});

describe('missionBlockCause — detalhe saneado', () => {
  it('leva a primeira linha real da nota técnica como detalhe', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\nA transação de despacho abortou em 4s.\nClique em Retomar.\n',
      ),
    );

    expect(cause.detail).toContain('A transação de despacho abortou em 4s.');
  });

  it('não vaza caminho absoluto', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n' +
          'worktree /Users/alguem/dev/nexus-ide/.worktrees/task-1 ocupado\n',
      ),
    );

    expect(cause.detail).not.toContain('/Users/');
    expect(cause.detail).toContain('<caminho>');
  });

  it('não vaza caminho Windows', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n' +
          'checkout C:\\Users\\alguem\\dev\\nexus falhou\n',
      ),
    );

    expect(cause.detail).not.toMatch(/C:\\/u);
    expect(cause.detail).toContain('<caminho>');
  });

  it('não vaza token nem hash opaco', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n' +
          'auth sk-live-9f2b7c41a8de55210bcd falhou no roster 45e08a41fcbb2f6626d6c2e7aa11bb2244\n',
      ),
    );

    expect(cause.detail).not.toContain('sk-live-9f2b7c41a8de55210bcd');
    expect(cause.detail).not.toContain('45e08a41fcbb2f6626d6c2e7aa11bb2244');
    expect(cause.detail).toContain('<token>');
  });

  it('não vaza e-mail', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n' +
          'conta retornoja@gmail.com sem assinatura ativa\n',
      ),
    );

    expect(cause.detail).not.toContain('@gmail.com');
    expect(cause.detail).toContain('<e-mail>');
  });

  it('detalhe respeita o teto de tamanho', () => {
    const cause = missionBlockCause(
      blocked(
        `objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n${'muito detalhe '.repeat(80)}\n`,
      ),
    );

    expect(cause.detail!.length).toBeLessThanOrEqual(160);
  });
});

describe('missionBlockCauseText — cabe no balão sem perder o acionável', () => {
  it('junta o porquê e o que fazer quando cabe', () => {
    const cause = missionBlockCause(
      blocked('objetivo\n\n<!-- nexus:handoff-delivery-failed:h1 -->\n'),
    );

    expect(missionBlockCauseText(cause)).toBe(
      'O worker terminou, mas a entrega não chegou ao orquestrador. ' +
        'Abra o diagnóstico da missão e reenvie a entrega pendente.',
    );
  });

  it('trunca o PORQUÊ e preserva o acionável inteiro', () => {
    const cause = missionBlockCause(
      blocked('objetivo\n\n<!-- nexus:handoff-delivery-failed:h1 -->\n'),
    );

    const text = missionBlockCauseText(cause, 80);

    expect(text.length).toBeLessThanOrEqual(80);
    expect(text.endsWith(cause.action)).toBe(true);
    expect(text).toContain('…');
  });

  it('com espaço só para o acionável, entrega o acionável', () => {
    const cause = missionBlockCause(
      blocked('objetivo\n\n<!-- nexus:handoff-delivery-failed:h1 -->\n'),
    );

    expect(missionBlockCauseText(cause, cause.action.length + 4)).toBe(
      cause.action,
    );
  });

  it('nunca ultrapassa o teto padrão, qualquer que seja a causa', () => {
    for (const description of [
      '[NEXUS_TASK_DISPATCH_BLOCKED] x',
      'roster_route_unavailable y',
      '[NEXUS_INTERRUPTED_WORKTREE_RESERVATION] z',
      '<!-- nexus:handoff-delivery-failed:h1 -->',
      'nada de especial',
    ]) {
      const text = missionBlockCauseText(missionBlockCause(blocked(description)));
      expect(text.length).toBeLessThanOrEqual(MISSION_BLOCK_CAUSE_TEXT_LIMIT);
    }
  });
});
