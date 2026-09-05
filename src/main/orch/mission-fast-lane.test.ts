import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import {
  agentPrompt,
  decideExternalHeadChangeAction,
  decideFastLaneEmptyPaneAction,
  decideFastLaneResumeAction,
  mayResumeAfterOperatorDismiss,
  missionDesignContext,
  missionFastLaneEnabled,
  isPaneMetaTask,
  extractMetaPaneQuestion,
  isSecurityMissionText,
  readableMissionAttachmentPath,
  SECURITY_DOCTRINE_NOTE,
} from './mission-fast-lane';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Prova',
    description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    ...overrides,
  } as Mission;
}

function agent(overrides: Partial<SquadAgent> = {}): SquadAgent {
  return {
    id: 'exec-1',
    agentName: 'Implementar motor',
    category: 'executor',
    cli: 'codex',
    ...overrides,
  } as SquadAgent;
}

function squad(overrides: Partial<Squad> = {}): Squad {
  return {
    id: 'squad-1',
    name: 'Equipe',
    createdAt: '1',
    builtin: false,
    orchestratorInstructions: '',
    agents: [],
    ...overrides,
  } as Squad;
}

describe('mission fast lane', () => {
  it.each(['consult', 'plan', 'ops'] as const)('keeps routed questions solo when %s has no worker budget', (lane) => {
    const prompt = agentPrompt(
      agent({ category: 'orchestrator' }),
      mission({
        description: 'pergunte aos panes quanto é 2+2',
        intentContract: { lane, budgets: { maxWorkers: 0 }, routingAdvice: { source: 'router', kind: 'mission-question', question: 'Quanto é 2+2?', readOnlyWorkers: true } } as Mission['intentContract'],
      }),
      [], false,
    );
    expect(prompt).not.toContain('META-DE-PANE:');
    expect(prompt).not.toContain('O Nexus está inicializando');
    expect(prompt).toContain('Quanto é 2+2?');
  });

  it('uses the reviewed router question even without legacy pane keywords', () => {
    const prompt = agentPrompt(
      agent({ category: 'orchestrator', agentName: 'Coord' }),
      mission({
        description: 'Consulte a equipe e consolide os resultados.',
        intentContract: {
          routingAdvice: { source: 'router', kind: 'mission-question', question: 'Quanto é 2+2?', readOnlyWorkers: true },
        } as Mission['intentContract'],
      }),
      ['Coord', 'Implementar motor'], false,
    );
    expect(prompt).toContain('META-DE-PANE');
    expect(prompt).toContain('Quanto é 2+2?');
    expect(prompt).not.toContain('TODO pedido do objetivo');
  });

  it('passes router skill hints only within the worker existing grants', () => {
    const prompt = agentPrompt(
      agent({ allowedSkills: ['bridgesecurity'] }),
      mission({ intentContract: { routingAdvice: { source: 'router', kind: 'mission-work', skills: ['bridgesecurity', 'impeccable'] } } as Mission['intentContract'] }),
      [], false,
    );
    expect(prompt).toContain('bridgesecurity');
    expect(prompt).not.toContain('impeccable');
  });

  it('é o caminho único: o motor cerimonial e o env de opt-out morreram', () => {
    process.env.NEXUS_CEREMONIAL_MISSIONS = '1';
    try {
      expect(missionFastLaneEnabled()).toBe(true);
    } finally {
      delete process.env.NEXUS_CEREMONIAL_MISSIONS;
    }
  });

  it('prompt do worker é curto, com objetivo e instruções Overlock', () => {
    const prompt = agentPrompt(
      agent(),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
    );
    expect(prompt).toContain('Implementar motor');
    expect(prompt).toContain('Leia brief.txt');
    expect(prompt).toContain('trabalhador');
    // C-194.1: as regras de entrega vivem no contrato anexado no spawn —
    // o corpo do prompt aponta para o contrato em vez de citar a tool.
    expect(prompt).toMatch(/regras de entrega.*contrato/i);
    expect(prompt.length).toBeLessThan(2000);
  });

  it('prompt do orquestrador contém instruções Overlock de coordenação', () => {
    const prompt = agentPrompt(
      agent({ id: 'coord', agentName: 'Coordenar e revisar', category: 'orchestrator' }),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
    );
    expect(prompt).toContain('ORQUESTRAÇÃO');
    expect(prompt).toContain('nexus_pane_spawn');
    expect(prompt).toContain('nexus_handoff_list');
    expect(prompt).toContain('nexus_mission_set_status');
    expect(prompt).toContain('NUNCA');
    expect(prompt).toContain('Implementar motor');
  });

  it('readableMissionAttachmentPath prefere o caminho do checkout, não o selo fora do workspace', () => {
    expect(
      readableMissionAttachmentPath({
        path: '/sealed/checkout-a/print.png',
        sourcePath: '/workspace/.nexus/attachments/mission-context/print.png',
      }),
    ).toBe('.nexus/attachments/mission-context/print.png');
    expect(
      readableMissionAttachmentPath({
        path: '/sealed/checkout-a/print.png',
        sourcePath:
          '/workspace/.nexus/attachments/mission-context/../../secret.png',
      }),
    ).toBe('/sealed/checkout-a/print.png');
  });

  it('prompt do orquestrador lista anexos selados da missão', () => {
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission({
        intentContract: {
          version: 1,
          source: 'typed',
          goal: 'Corrigir a UI usando o print anexado.',
          acceptanceCriteria: ['A correção considera o print anexado.'],
          risk: 'normal',
          executionMode: 'autopilot',
          contextPolicy: 'minimal',
          intentVersion: 1,
          budgets: {
            planningTokens: 1,
            executionTokens: 1,
            maxWorkers: 1,
            maxSteps: 1,
          },
          attachmentPaths: ['/sealed/checkout-a/print.png'],
          attachmentSnapshots: [
            {
              path: '/sealed/checkout-a/print.png',
              sourcePath:
                '/workspace/.nexus/attachments/mission-context/print.png',
              sha256: 'b'.repeat(64),
              size: 5,
              sealId: 'c'.repeat(32),
              device: '10',
              inode: '20',
            },
          ],
        },
      }),
      ['Coordenar e revisar'],
      false,
    );

    expect(prompt).toContain('Anexos da missão');
    expect(prompt).toContain('.nexus/attachments/mission-context/print.png');
    expect(prompt).toMatch(/ferramenta Read/i);
    expect(prompt).not.toContain('/sealed/checkout-a/print.png');
  });

  it('plano selado de 20 stories entra no kickoff e proíbe colapso em papéis', () => {
    const titles = Array.from(
      { length: 20 },
      (_, index) => `Story ${index + 1} da waitlist`,
    );
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad(),
      titles,
    );
    expect(prompt).toContain('Plano selado');
    expect(prompt).toContain('São 20 entregas');
    expect(prompt).toMatch(/não reduza a lista aos papéis do squad/i);
    expect(prompt).toContain('Story 20 da waitlist');
    expect(prompt).toContain('task selada pendente');
  });

  it('missão-pergunta aos panes recebe brief PROPORCIONAL, sem doutrina de delegação contraditória', () => {
    const orchestrator = agent({
      id: 'coord',
      agentName: 'Coordenar e revisar',
      category: 'orchestrator',
    });
    const team = squad({
      agents: [
        {
          id: 'w1',
          agentName: 'Implementar interface',
          category: 'executor',
          cli: 'codex',
        },
        {
          id: 'w2',
          agentName: 'Implementar motor',
          category: 'executor',
          cli: 'codex',
        },
      ],
    });
    const prompt = agentPrompt(
      orchestrator,
      mission({ description: 'pergunte aos panes quanto é 1+1' }),
      ['Coordenar e revisar', 'Implementar interface', 'Implementar motor'],
      false,
      '',
      team,
      ['pergunte aos panes quanto é 1+1'],
    );

    // Contrato operacional completo no prompt…
    expect(prompt).toContain('META-DE-PANE');
    expect(prompt).toContain('quanto é 1+1');
    expect(prompt).toContain('nexus_pane_ask');
    // …sem a contradição "delegue" nem a doutrina pesada de execução.
    expect(prompt).not.toContain('Não execute o pedido — delegue');
    expect(prompt).not.toContain('DOUTRINA DE ORQUESTRAÇÃO (só para a coordenação)');
    // Sem plano selado redundante repetindo o objetivo.
    expect(prompt).not.toContain('Plano selado (1 entrega)');
    // Proporcional ao pedido: cabe em ~2 KB.
    expect(prompt.length).toBeLessThan(2_200);
  });

  it('retomada avisa que foi religado', () => {
    const prompt = agentPrompt(agent(), mission(), [], true);
    expect(prompt).toContain('religado');
  });

  it('missão de UI aponta DESIGN.md do projeto e o catálogo ~/.design-references sem atrito', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'fastlane-ws-'));
    const home = mkdtempSync(join(tmpdir(), 'fastlane-home-'));
    writeFileSync(join(workspace, 'DESIGN.md'), '# tokens');
    mkdirSync(join(home, '.design-references'));
    writeFileSync(join(home, '.design-references', 'README.md'), '# índice');

    const context = missionDesignContext(workspace, home);
    expect(context).toContain('DESIGN.md');
    expect(context).toContain('.design-references');

    const uiMission = mission({
      description:
        'Redesenhe a tela de login com um layout novo de interface e css.',
    });
    const prompt = agentPrompt(agent(), uiMission, [], false, context);
    expect(prompt).toContain('DESIGN.md');
    expect(prompt).toContain('.design-references');

    // Sem nada no disco: contexto vazio e prompt continua limpo.
    const emptyHome = mkdtempSync(join(tmpdir(), 'fastlane-vazio-'));
    expect(missionDesignContext(emptyHome, emptyHome)).toBe('');
  });

  it('missão sem cara de UI não carrega o catálogo de design', () => {
    const prompt = agentPrompt(
      agent(),
      mission(),
      [],
      false,
      'Catálogo: ~/.design-references',
    );
    expect(prompt).not.toContain('design-references');
  });

  it('kickoff do orquestrador injeta a doutrina + o playbook do squad', () => {
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad({
        orchestratorInstructions: 'Rode os gates verdes antes de fechar a missão.',
      }),
    );
    // doutrina de orquestração: instruções MCP
    expect(prompt).toContain('nexus_pane_spawn');
    expect(prompt).toContain('nexus_handoff_list');
    // playbook do squad, verbatim
    expect(prompt).toContain('Rode os gates verdes antes de fechar a missão.');
    // sem 'same_checkout' no novo formato (o orquestrador não precisa saber)
  });

  it('kickoff de worker NÃO recebe o bloco de delegação/doutrina', () => {
    const prompt = agentPrompt(
      agent(),
      mission(),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad({ orchestratorInstructions: 'Rode os gates verdes.' }),
    );
    expect(prompt).not.toContain('nexus_pane_spawn');
    expect(prompt).not.toContain('nexus_handoff_list');
    expect(prompt).not.toContain('Rode os gates verdes.');
  });

  it('kickoff do Maestro cita o plano selado de 20 stories', () => {
    const titles = Array.from({ length: 20 }, (_, i) => `Story ${i + 1}`);
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission({ description: '20 stories listadas no objetivo' }),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad(),
      titles,
    );
    expect(prompt).toContain('Plano selado');
    expect(prompt).toContain('São 20 entregas');
    expect(prompt).toContain('Story 1');
    expect(prompt).toContain('Story 20');
    expect(prompt).toContain('first-wave');
  });

  it('orquestrador sem orchestratorInstructions (ou sem squad) não quebra', () => {
    expect(() =>
      agentPrompt(
        agent({ id: 'coord', agentName: 'Coord', category: 'orchestrator' }),
        mission(),
        [],
        false,
        '',
        squad({ orchestratorInstructions: '' }),
      ),
    ).not.toThrow();
    const prompt = agentPrompt(
      agent({ id: 'coord', agentName: 'Coord', category: 'orchestrator' }),
      mission(),
      [],
      false,
    );
    // sem squad (default null), o orquestrador ainda recebe instruções Overlock
    expect(prompt).toContain('ORQUESTRAÇÃO');
    expect(prompt).toContain('nexus_pane_spawn');
  });
});

describe('decideFastLaneEmptyPaneAction', () => {
  it('com orçamento de respawn → respawna o orquestrador', () => {
    expect(
      decideFastLaneEmptyPaneAction({
        status: 'running',
        pendingHandoffs: 0,
        respawnBudgetLeft: 3,
      }),
    ).toBe('respawn-orchestrator');
  });

  it('com handoffs pendentes → respawna para consumir as entregas', () => {
    expect(
      decideFastLaneEmptyPaneAction({
        status: 'running',
        pendingHandoffs: 2,
        respawnBudgetLeft: 1,
      }),
    ).toBe('respawn-orchestrator');
  });

  it('sem orçamento e sem processo vivo → expõe bloqueio recuperável', () => {
    expect(
      decideFastLaneEmptyPaneAction({
        status: 'running',
        pendingHandoffs: 0,
        respawnBudgetLeft: 0,
      }),
    ).toBe('block-recovery-exhausted');
  });

  it('orquestrador fechado pelo operador → não respawna a missão inteira', () => {
    expect(
      decideFastLaneEmptyPaneAction({
        status: 'running',
        pendingHandoffs: 2,
        respawnBudgetLeft: 3,
        operatorDismissedOrchestrator: true,
      }),
    ).toBe('keep-running-watching');
  });
});

describe('mayResumeAfterOperatorDismiss (✕ do Maestro não é Retomar)', () => {
  it('sem dismiss → resume segue', () => {
    expect(
      mayResumeAfterOperatorDismiss({
        remountKind: 'automatic',
        operatorDismissedOrchestrator: false,
      }),
    ).toBe(true);
  });

  it('dismiss + remount automático / retry-kickoff → NÃO resume', () => {
    expect(
      mayResumeAfterOperatorDismiss({
        remountKind: 'automatic',
        operatorDismissedOrchestrator: true,
      }),
    ).toBe(false);
  });

  it('dismiss + Retomar explícito do operador → resume (e limpa o tombstone)', () => {
    expect(
      mayResumeAfterOperatorDismiss({
        remountKind: 'operator',
        operatorDismissedOrchestrator: true,
      }),
    ).toBe(true);
  });
});

describe('decideFastLaneResumeAction (retry-kickoff faz algo de verdade)', () => {
  it('running + orquestrador vivo → só religa o watcher', () => {
    expect(
      decideFastLaneResumeAction({
        status: 'running',
        liveOrchestratorSession: true,
      }),
    ).toBe('watch');
  });

  it('running + orquestrador morto → respawna (antes: retorno silencioso = botão morto)', () => {
    expect(
      decideFastLaneResumeAction({
        status: 'running',
        liveOrchestratorSession: false,
      }),
    ).toBe('respawn');
  });

  it('não-running → bootstrap normal', () => {
    expect(
      decideFastLaneResumeAction({
        status: 'pending',
        liveOrchestratorSession: false,
      }),
    ).toBe('bootstrap');
  });
});

describe('decideExternalHeadChangeAction (sentinela de HEAD — achado #14)', () => {
  it('HEAD igual → ignora', () => {
    expect(
      decideExternalHeadChangeAction({ baseline: 'a1', current: 'a1' }),
    ).toEqual({ action: 'ignore' });
  });

  it('HEAD mudou por fora → notifica com from/to', () => {
    const decision = decideExternalHeadChangeAction({
      baseline: 'a1',
      current: 'b2',
    });
    expect(decision).toEqual({ action: 'notify', from: 'a1', to: 'b2' });
  });

  it('sem HEAD legível (não é repo) → ignora', () => {
    expect(
      decideExternalHeadChangeAction({ baseline: null, current: 'b2' }),
    ).toEqual({ action: 'ignore' });
    expect(
      decideExternalHeadChangeAction({ baseline: 'a1', current: null }),
    ).toEqual({ action: 'ignore' });
  });

  it('HEAD que bate na escada de SHAs das entregas da própria missão é interno (A6)', () => {
    // Worker do same_checkout commitou e entregou handoff com headSha — o
    // commit É da missão. Avisar gasta um turno do Maestro para "revalidar"
    // o próprio trabalho dele (8× falsos positivos na missão real).
    const ladder = new Set(['h-work1', 'h-work2', 'b-work1']);
    expect(
      decideExternalHeadChangeAction({
        baseline: 'old',
        current: 'h-work2',
        missionShaLadder: ladder,
      }),
    ).toEqual({ action: 'internal', from: 'old', to: 'h-work2' });
    // baseSha de handoff posterior (worker B construiu sobre o trabalho de A).
    expect(
      decideExternalHeadChangeAction({
        baseline: 'old',
        current: 'b-work1',
        missionShaLadder: ladder,
      }),
    ).toEqual({ action: 'internal', from: 'old', to: 'b-work1' });
    // SHA fora da escada segue sendo aviso — a sentinela não pode cegar.
    expect(
      decideExternalHeadChangeAction({
        baseline: 'old',
        current: 'c-estranho',
        missionShaLadder: ladder,
      }),
    ).toEqual({ action: 'notify', from: 'old', to: 'c-estranho' });
  });
});

describe('isPaneMetaTask — meta-de-pane fica com o Maestro', () => {
  it('reconhece as formas reais ditadas pelo operador em 20/08', () => {
    expect(isPaneMetaTask('pergunte ao panes quanto e 1+1')).toBe(true);
    expect(isPaneMetaTask('abre os panes. e pergunta csadad um dles quanto e 1+1')).toBe(true);
    expect(isPaneMetaTask('chame o pane kimi e pergunte quanto é 1+1')).toBe(true);
    expect(isPaneMetaTask('cada pane responda quanto é 1+1 e reporte')).toBe(true);
  });

  it('ditado com typo no verbo ainda é meta-de-pane (destinatário + interrogação)', () => {
    // Caso de campo 20/08: "oergunta aos panes quwnto e 1+1" derrotou o
    // padrão por verbo e a task foi para um worker que saiu grepando o
    // código atrás de "panes".
    expect(isPaneMetaTask('oergunta  aos panes quwnto e 1+1')).toBe(true);
    expect(isPaneMetaTask('fala aos panes: qual o status?')).toBe(true);
  });

  it('ditado traduzido para inglês ainda é pergunta a todos os panes', () => {
    // Campo 24/08: "How much is 2x2 and they have to answer you."
    // A first-wave selou 1 entrega e abriu só o Codex — o VOZ já avisa
    // que o objetivo chega em inglês.
    expect(
      isPaneMetaTask('How much is 2x2 and they have to answer you.'),
    ).toBe(true);
    expect(
      isPaneMetaTask('ask the team how much is 2+2'),
    ).toBe(true);
    expect(
      isPaneMetaTask('each worker should answer: what is 1+1?'),
    ).toBe(true);
  });

  it('extrai a pergunta limpa do wrapper inglês e do "pergunte aos panes"', () => {
    expect(
      extractMetaPaneQuestion('How much is 2x2 and they have to answer you.'),
    ).toBe('How much is 2x2');
    expect(extractMetaPaneQuestion('pergunte aos panes quanto é 1+1')).toBe(
      'quanto é 1+1',
    );
    expect(extractMetaPaneQuestion('ask the team how much is 2+2')).toBe(
      'how much is 2+2',
    );
  });

  it('task de CÓDIGO que menciona pane continua indo para worker', () => {
    expect(isPaneMetaTask('corrigir o pane-close-guard do renderer')).toBe(false);
    expect(isPaneMetaTask('refatorar PaneToolbar para o novo layout')).toBe(false);
    expect(isPaneMetaTask('implementar dashboard de vendas')).toBe(false);
    // "aos panes" SEM carga interrogativa é feature de código, não pergunta.
    expect(isPaneMetaTask('adicionar suporte de drag aos panes')).toBe(false);
  });
});

describe('kickoff meta-de-pane — um pane por integrante, TODOS respondem', () => {
  it('injeta a diretiva com os nomes da equipe e o critério N/N', () => {
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission({ description: 'pergunte aos panes quanto é 1+1' }),
      ['Coordenar e revisar', 'Implementar motor'],
      false,
      '',
      squad({
        agents: [
          agent({ id: 'coord', agentName: 'Coordenar e revisar', category: 'orchestrator' }),
          agent({ id: 'w1', agentName: 'Implementar interface', category: 'executor' }),
          agent({ id: 'w2', agentName: 'Implementar motor', category: 'executor' }),
        ],
      }),
      ['pergunte aos panes quanto é 1+1'],
    );
    expect(prompt).toContain('META-DE-PANE');
    expect(prompt).toContain('UM pane por integrante');
    expect(prompt).toContain('Implementar motor');
    expect(prompt).toContain('TODOS os panes');
    expect(prompt).toContain('Nenhum pane sem resposta');
    expect(prompt).toContain('EXTRAIA do objetivo apenas a PERGUNTA');
    expect(prompt).toContain('readOnly: true');
    expect(prompt).toContain('artifacts');
    expect(prompt).toContain('não chame set_status done');
    expect(prompt).toContain('O Nexus está inicializando');
    expect(prompt).not.toContain('first-wave já abriu');
    expect(prompt).toContain('NÃO spawne de novo');
    expect(prompt).toContain('NÃO spawne ad-hoc');
    expect(prompt).toContain('sem agentName');
    expect(prompt).not.toContain('abra via nexus_pane_spawn');
    expect(prompt).not.toContain('1 entrega');
    expect(prompt).not.toContain('São 1 entregas');
  });

  it('ditado inglês ainda é META-DE-PANE — não colapsa em 1 entrega Codex', () => {
    const prompt = agentPrompt(
      agent({
        id: 'coord',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
      }),
      mission({
        title: 'How much is 2x2 and they have to answer you.',
        description: 'How much is 2x2 and they have to answer you.',
      }),
      [
        'Coordenar e revisar',
        'Implementar interface',
        'Implementar motor',
        'Verificar o resultado',
      ],
      false,
      '',
      squad({
        agents: [
          agent({
            id: 'coord',
            agentName: 'Coordenar e revisar',
            category: 'orchestrator',
          }),
          agent({
            id: 'w1',
            agentName: 'Implementar interface',
            category: 'executor',
          }),
          agent({
            id: 'w2',
            agentName: 'Implementar motor',
            category: 'executor',
          }),
          agent({
            id: 'w3',
            agentName: 'Verificar o resultado',
            category: 'reviewer',
          }),
        ],
      }),
      ['How much is 2x2 and they have to answer you.'],
    );
    expect(prompt).toContain('META-DE-PANE');
    expect(prompt).toContain('Implementar interface');
    expect(prompt).toContain('Implementar motor');
    expect(prompt).toContain('Verificar o resultado');
    expect(prompt).not.toContain('Plano selado (1 entrega)');
    expect(prompt).not.toContain('São 1 entregas');
  });

  it('missão sem meta-de-pane não carrega a diretiva', () => {
    const prompt = agentPrompt(
      agent({ category: 'orchestrator' }),
      mission(),
      [],
      false,
      '',
      squad(),
      ['implementar dashboard de vendas'],
    );
    expect(prompt).not.toContain('META-DE-PANE');
  });
});

describe('doutrina de segurança — a missão que o classificador não vê', () => {
  it('reconhece o pedido de segurança que sai como feature/unknown', () => {
    // Sonda 23/08: classifyWorkKind devolve `feature` para o primeiro e
    // `unknown` para o segundo — nenhum dos dois recebia doutrina.
    for (const goal of [
      'faça uma auditoria de segurança no login e corrija o que estiver vulnerável',
      'revise as permissões de acesso e proteja as rotas de admin',
      'guarde as credenciais do banco fora do código',
      'corrija o XSS do campo de comentário',
    ]) {
      expect(isSecurityMissionText(goal)).toBe(true);
    }
  });

  it('não dispara em missão comum', () => {
    for (const goal of [
      'crie uma landing page para minha barbearia',
      'corrija o botão de salvar no celular',
      'escreva a documentação da api de pedidos',
    ]) {
      expect(isSecurityMissionText(goal)).toBe(false);
    }
  });

  it('a nota é curta — prompt longo é token queimado em toda missão', () => {
    expect(SECURITY_DOCTRINE_NOTE.length).toBeLessThan(600);
    expect(SECURITY_DOCTRINE_NOTE).toContain('segredo');
    expect(SECURITY_DOCTRINE_NOTE).toContain('valide no servidor');
  });
});
