import { describe, expect, it } from 'vitest';
import {
  appendMissionVerdict,
  missionBlockCause,
  missionBlockCauseText,
  MISSION_BLOCK_CAUSE_TEXT_LIMIT,
  MISSION_DESCRIPTION_LIMIT,
  stripMissionVerdictParagraph,
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

  it('worker pediu decisão: não é falha técnica nem despacho abortado', () => {
    const cause = missionBlockCause(
      blocked(
        'quero story 1.4\n\n[NEXUS_WORKER_DECISION_BLOCKED]\n## Worker pediu decisão\n' +
          'Story 1.4 está backlog; o gate autoriza só a 1.3.\n' +
          'A missão ficou parada na pane — diga o que fazer: mudar o objetivo, autorizar o caminho, ou encerrar de propósito.\n',
        'blocked_user',
      ),
    );

    expect(cause.code).toBe('worker-decision');
    expect(cause.headline).toMatch(/pediu uma decisão|não falhou/i);
    expect(cause.action).toMatch(/dizer o que fazer|autorizar|encerrar/i);
    expect(cause.headline).not.toMatch(/despacho abortou/i);
  });

  it('kickoff falhou: não culpa cota do provider', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n<!-- nexus:kickoff-not-accepted -->\n' +
          '<!-- nexus:kickoff-failure:boot_timeout -->\n' +
          '## Kickoff não aceito\nO terminal não ficou ocioso a tempo.\n',
      ),
    );

    expect(cause.code).toBe('kickoff-failed');
    expect(cause.headline).toBe(
      'O Maestro abriu, mas o kickoff não foi aceito a tempo.',
    );
    expect(cause.action).toMatch(/pane do Maestro|retome a missão/i);
    expect(cause.action).not.toMatch(/cota/i);
  });

  it('Maestro saiu antes do dispatch: ação é diagnóstico, não cota', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n<!-- nexus:orchestrator-pre-dispatch-exit -->\n' +
          '## Maestro encerrou antes da delegação\n' +
          'Código técnico: `orchestrator_session_exited_before_first_dispatch`.\n',
      ),
    );

    expect(cause.code).toBe('maestro-pre-dispatch-exit');
    expect(cause.headline).toBe(
      'O Maestro encerrou antes de delegar a primeira tarefa.',
    );
    expect(cause.action).toMatch(/diagnóstico|Retomar missão/i);
    expect(cause.action).not.toMatch(/cota/i);
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

describe('missionBlockCause — vereditos do lado humano (fechamento sem silêncio)', () => {
  it('driver block-human: o piloto parou num ponto que precisa do operador', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n<!-- nexus:driver-block-human -->\n' +
          '[NEXUS_DRIVER_BLOCK_HUMAN] paneDead após 3 respawns; contexto sem progresso.\n',
        'blocked_user',
      ),
    );

    expect(cause.code).toBe('driver-block-human');
    expect(cause.headline).toBe(
      'O piloto automático parou a missão num ponto que precisa de você.',
    );
    expect(cause.detail).toContain('paneDead após 3 respawns');
  });

  it('agent-status-block: o orquestrador encerrou com nota própria', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n<!-- nexus:agent-status-block -->\n' +
          '[NEXUS_AGENT_STATUS_BLOCK] O orquestrador declarou status=blocked: ' +
          'bloqueio ambiental comprovado; worktree órfão nunca liberou a reserva.\n',
        'blocked_user',
      ),
    );

    expect(cause.code).toBe('agent-status-block');
    expect(cause.headline).toBe(
      'O próprio orquestrador encerrou a missão com um motivo registrado.',
    );
    expect(cause.detail).toContain('bloqueio ambiental comprovado');
  });

  it('exclusive-replacement: outra missão assumiu o orquestrador', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n<!-- nexus:exclusive-orchestrator-replacement -->\n' +
          '[NEXUS_EXCLUSIVE_ORCHESTRATOR_REPLACED] O orquestrador exclusivo foi assumido por outra missão/instância.\n',
        'blocked_user',
      ),
    );

    expect(cause.code).toBe('exclusive-replacement');
    expect(cause.action).toBe('Retome a missão para reabrir o Maestro.');
  });

  it('runtime-closed: o operador encerrou preservando histórico', () => {
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n<!-- nexus:runtime-closed -->\n' +
          '[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador; histórico e receipts preservados.\n',
        'blocked_user',
      ),
    );

    expect(cause.code).toBe('runtime-closed');
    expect(cause.headline).toBe(
      'A execução foi encerrada pelo operador; histórico preservado.',
    );
  });

  it('causa técnica citada no veredito humano ainda vence o veredito', () => {
    // O agente explicou fechando com ownership: a causa acionável é a reserva,
    // não o wrapper "o agente fechou".
    const cause = missionBlockCause(
      blocked(
        'objetivo\n\n[NEXUS_INTERRUPTED_WORKTREE_RESERVATION] reserva pendente\n\n' +
          '<!-- nexus:agent-status-block -->\n' +
          '[NEXUS_AGENT_STATUS_BLOCK] status=blocked: worktree ocupado por outra task.\n',
        'blocked_user',
      ),
    );

    expect(cause.code).toBe('ownership-conflict');
  });
});

describe('appendMissionVerdict — veredito durável sem destruir o existente', () => {
  it('anexa o bloco ao fim preservando a description', () => {
    const next = appendMissionVerdict(
      'objetivo do operador',
      '<!-- nexus:runtime-closed -->',
      '[NEXUS_RUNTIME_CLOSED]',
      'Execução encerrada pelo operador.',
    );

    expect(next.startsWith('objetivo do operador')).toBe(true);
    expect(next).toContain('<!-- nexus:runtime-closed -->');
    expect(next).toContain('[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador.');
  });

  it('idempotente: re-arm/recovery nunca duplicam o marcador', () => {
    const once = appendMissionVerdict(
      'objetivo',
      '<!-- nexus:runtime-closed -->',
      '[NEXUS_RUNTIME_CLOSED]',
      'motivo',
    );
    const twice = appendMissionVerdict(
      once,
      '<!-- nexus:runtime-closed -->',
      '[NEXUS_RUNTIME_CLOSED]',
      'motivo',
    );

    expect(twice).toBe(once);
  });

  it('description vazia vira só o veredito', () => {
    const next = appendMissionVerdict(
      '',
      '<!-- nexus:driver-block-human -->',
      '[NEXUS_DRIVER_BLOCK_HUMAN]',
      'contexto exausto',
    );

    expect(next).toBe(
      '<!-- nexus:driver-block-human -->\n[NEXUS_DRIVER_BLOCK_HUMAN] contexto exausto',
    );
  });

  it('o bloco novo sempre cabe: quem cede é o meio do texto antigo', () => {
    const huge = `objetivo\n${'ruído '.repeat(20_000)}`;
    const next = appendMissionVerdict(
      huge,
      '<!-- nexus:runtime-closed -->',
      '[NEXUS_RUNTIME_CLOSED]',
      'fim',
    );

    expect(next.length).toBeLessThanOrEqual(MISSION_DESCRIPTION_LIMIT);
    expect(next).toContain('[NEXUS_RUNTIME_CLOSED] fim');
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

describe('stripMissionVerdictParagraph — reabrir limpa o selo que fecha', () => {
  const RUNTIME_CLOSED = '<!-- nexus:runtime-closed -->';

  it('remove o parágrafo do veredito e preserva o resto', () => {
    const description = appendMissionVerdict(
      'objetivo do operador\n\ntrabalho feito na etapa 1',
      RUNTIME_CLOSED,
      '[NEXUS_RUNTIME_CLOSED]',
      'Execução encerrada pelo operador; histórico e receipts preservados.',
    );

    const stripped = stripMissionVerdictParagraph(description, RUNTIME_CLOSED);

    expect(stripped).toBe('objetivo do operador\n\ntrabalho feito na etapa 1');
    expect(stripped.includes(RUNTIME_CLOSED)).toBe(false);
  });

  it('é idempotente e inofensivo sem o marcador', () => {
    expect(stripMissionVerdictParagraph('só o objetivo', RUNTIME_CLOSED)).toBe(
      'só o objetivo',
    );
    expect(stripMissionVerdictParagraph('', RUNTIME_CLOSED)).toBe('');
    const once = stripMissionVerdictParagraph(
      appendMissionVerdict('base', RUNTIME_CLOSED, '[T]', 'motivo'),
      RUNTIME_CLOSED,
    );
    expect(stripMissionVerdictParagraph(once, RUNTIME_CLOSED)).toBe('base');
  });

  it('não toca veredito de outro marcador', () => {
    const description = appendMissionVerdict(
      'base',
      '<!-- nexus:outro -->',
      '[OUTRO]',
      'motivo',
    );

    expect(
      stripMissionVerdictParagraph(description, RUNTIME_CLOSED),
    ).toBe(description);
  });
});
