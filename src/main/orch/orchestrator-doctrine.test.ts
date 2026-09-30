import { describe, expect, it } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import {
  MAESTRO_STANDING_DOCTRINE,
  buildMaestroKickoffBrief,
  buildOrchestratorDoctrine,
  maestroStandingDoctrine,
} from './orchestrator-doctrine';

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
    learnings: '',
    ...overrides,
  } as Mission;
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

describe('orchestrator doctrine', () => {
  it('ensina a espera dirigida por handoff e o anti-polling (idle-delivery)', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toMatch(/idle/i);
    // anti-polling: proíbe vigiar worker vivo em loop de read/wait
    expect(text).toMatch(/nexus_pane_read|pane_wait/);
    expect(text).toMatch(/delegar e encerrar o turno/i);
    expect(text).toMatch(/olhar o que o pane/i);
  });

  it('ensina delegação de 1 chamada e relay fiel do pedido humano', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toContain('nexus_pane_spawn');
    expect(text).toMatch(/nasce executando/);
    expect(text).toMatch(/relay/i);
  });

  it('carrega a política de workspace same_checkout sem stash/reset/checkout/clean', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toContain('same_checkout');
    expect(text).toContain('isolatedWriter:true');
    expect(text).toContain('integre as branches ao final, na ordem de dependência');
    expect(text).toMatch(/stash/);
    expect(text).toMatch(/reset/);
    expect(text).toMatch(/checkout/);
    expect(text).toMatch(/clean/);
  });

  it('ensina que revisão/análise read-only abre em paralelo (não serializa)', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toMatch(/readOnly:true/);
    expect(text).toMatch(/paralelo/);
  });

  it('carrega a nota de voz PT/tradução respondendo em PT-BR', () => {
    const text = buildOrchestratorDoctrine(squad(), mission());
    expect(text).toMatch(/ditar em PT|ditado traduzido/i);
    expect(text).toMatch(/PT-BR/);
  });

  it('anexa orchestratorInstructions do squad VERBATIM quando existir', () => {
    const playbook =
      '# Playbook do operador\nRode os gates verdes antes de fechar a missão.';
    const text = buildOrchestratorDoctrine(
      squad({ orchestratorInstructions: playbook }),
      mission(),
    );
    expect(text).toContain(playbook);
  });

  it('não quebra sem squad e não injeta seção de playbook quando vazio', () => {
    expect(() => buildOrchestratorDoctrine(null, mission())).not.toThrow();
    const empty = buildOrchestratorDoctrine(
      squad({ orchestratorInstructions: '   ' }),
      mission(),
    );
    expect(empty).not.toMatch(/PLAYBOOK DO SQUAD/i);
    // a doutrina base continua presente
    expect(empty).toMatch(/idle/i);
  });

  it('a doutrina base (sem playbook do operador) fica curta (<2KB)', () => {
    const text = buildOrchestratorDoctrine(null, mission());
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(2048);
  });
});


// Campo (14/08): orquestrador respondeu SOZINHO tarefa trivial e a missão
// parou até o SLA do supervisor. A doutrina agora fecha a brecha.
describe('buildMaestroKickoffBrief', () => {
  const directMission = {
    title: 'Diagnóstico',
    objective: 'Explique por que o processo encerrou.',
    orchestratorName: 'Maestro',
    teamNames: ['Maestro', 'Investigar'],
  };

  it('consulta permite resposta direta sem exigir um arquivo de plano ou delegação', () => {
    const text = buildMaestroKickoffBrief({ ...directMission, lane: 'consult' });

    expect(text).toMatch(/responda.*diretamente/i);
    expect(text).toContain(directMission.objective);
    expect(text).toMatch(/Não abra trabalhadores/);
    expect(text).not.toMatch(/docs\/plan\.md|só documentação|NUNCA executa|TODO pedido.*worker/);
    expect(text).toContain('nexus_handoff_submit');
    expect(text).toContain('fullText');
    expect(text).toMatch(/missionId.*note/);
  });

  it('planejamento produz o plano solicitado sem exigir execução por workers', () => {
    const text = buildMaestroKickoffBrief({
      ...directMission,
      objective: 'Planeje a migração sem alterar o código.',
      lane: 'plan',
    });

    expect(text).toMatch(/elabore.*plano.*objetivo/i);
    expect(text).toMatch(/Não abra trabalhadores/);
    expect(text).toContain('docs/plan.md');
    expect(text).toContain('nexus_handoff_submit');
    expect(text).not.toMatch(/NUNCA executa|TODO pedido.*worker|Para cada tarefa: nexus_pane_spawn/);
  });

  it('orçamento zero permite executar o objetivo sem transformá-lo em documentação', () => {
    const text = buildMaestroKickoffBrief({
      ...directMission,
      objective: 'Corrija o parser e valide o resultado.',
      lane: 'standard',
      maxWorkers: 0,
    });

    expect(text).toMatch(/execute.*diretamente/i);
    expect(text).toMatch(/Não abra trabalhadores/);
    expect(text).not.toMatch(/docs\/plan\.md|só documentação|NUNCA executa|TODO pedido.*worker/);
    expect(text).toContain('nexus_handoff_submit');
    expect(text).toMatch(/recus|rejei|bloque/i);
  });

  it.each(['consult', 'plan'])('a doutrina avulsa respeita o modo direto %s da missão', (lane) => {
    const text = buildOrchestratorDoctrine(squad(), mission({
      intentContract: { lane } as Mission['intentContract'],
    }));

    expect(text).toMatch(/Não abra trabalhadores/);
    expect(text).toContain('nexus_handoff_submit');
    expect(text).not.toMatch(/NUNCA executa|TODO pedido.*worker/);
  });

  it.each([false, true])('primeira onda gerenciada pelo main não é duplicada (resume=%s)', (resume) => {
    const text = buildMaestroKickoffBrief({
      ...directMission,
      resume,
      firstWaveDispatched: true,
      sealedPlanTitles: ['Investigar a causa', 'Validar a correção'],
    });

    expect(text).toMatch(/main.*inicialização/i);
    expect(text).toMatch(/não duplique.*first-wave/i);
    expect(text).toContain('nexus_handoff_list({full:true})');
    expect(text).toMatch(/sem dispatch|ainda não despachad|não despachad/);
    expect(text).not.toMatch(/Equipe para abrir|Para cada tarefa:|Spawne UM worker por task|JÁ abriu|já estão abertos/);
    expect(text).toContain('nexus_handoff_submit');
  });

  it('preserva playbook verbatim, nota de segurança e voz nos modos diretos', () => {
    const playbook = '\n  # Instruções originais\nRespeite o objetivo.\n  ';
    const text = buildMaestroKickoffBrief({
      ...directMission,
      lane: 'consult',
      playbook,
      securityNote: 'SEGURANÇA: preserve os dados do usuário.',
    });

    expect(text).toContain(`verbatim):\n${playbook}`);
    expect(text).toContain('SEGURANÇA: preserve os dados do usuário.');
    expect(text).toContain('PT-BR');
  });

  it('exporta o kickoff com tools de coordenação e a equipe', () => {
    const text = buildMaestroKickoffBrief({
      title: 'Prova',
      objective: 'Leia brief.txt',
      orchestratorName: 'Coordenar e revisar',
      teamNames: ['Coordenar e revisar', 'Implementar motor'],
    });
    expect(text).toContain('ORQUESTRAÇÃO');
    expect(text).toContain('nexus_pane_spawn');
    expect(text).toContain('nexus_handoff_list');
    expect(text).toContain('nexus_mission_set_status');
    expect(text).toContain('Implementar motor');
  });

  it('cita first-wave quando há plano selado', () => {
    const text = buildMaestroKickoffBrief({
      title: 'Prova',
      objective: '### Plano selado\nO board já rastreia 20 tasks do objetivo.',
      orchestratorName: 'Maestro',
      teamNames: ['Maestro'],
      sealedPlanTitles: Array.from({ length: 20 }, (_, i) => `Story ${i + 1}`),
    });
    expect(text).toContain('task selada pendente');
    expect(text).toContain('first-wave');
  });

  it('missão-pergunta não manda o Maestro abrir pane extra', () => {
    const text = buildMaestroKickoffBrief({
      title: 'How much is 2x2',
      objective: 'How much is 2x2 and they have to answer you.',
      orchestratorName: 'Coordenar e revisar',
      teamNames: [
        'Coordenar e revisar',
        'Implementar interface',
        'Implementar motor',
        'Verificar o resultado',
      ],
      metaPane: true,
    });
    expect(text).toMatch(/main.*inicialização.*first-wave/);
    expect(text).not.toMatch(/JÁ abriu|já estão abertos/);
    expect(text).toContain('NÃO chame nexus_pane_spawn');
    expect(text).toContain('NÃO liste panes');
    expect(text).toContain('nexus_pane_ask');
    expect(text).toContain('Implementar interface');
    expect(text).not.toMatch(/abra os panes da equipe/i);
  });

  it('ASK mantém respostas reais de todos os panes e seu fecho único mesmo com modo direto', () => {
    const text = buildMaestroKickoffBrief({
      ...directMission,
      objective: 'Pergunte aos panes quanto é 2+2 e cite cada resposta.',
      lane: 'consult',
      maxWorkers: 0,
      firstWaveDispatched: true,
      metaPane: true,
    });

    expect(text).toContain('nexus_pane_ask');
    expect(text).toContain('respostas de TODOS');
    expect(text).toContain('um só nexus_handoff_submit');
    expect(text).toContain('não chame set_status done');
    expect(text).not.toMatch(/JÁ abriu|já estão abertos/);
    expect(text).not.toMatch(/responda.*diretamente|NUNCA executa|docs\/plan\.md/);
  });
});

describe('doutrina exige delegação total (nem o trivial é respondido no pane)', () => {
  it('diz que TODO pedido do objetivo vira dispatch de worker', () => {
    const doctrine = buildOrchestratorDoctrine(null, {} as never);
    expect(doctrine).toContain('EXECUÇÃO');
    expect(doctrine).toContain('inclusive uma pergunta trivial');
    expect(doctrine).toContain('dispatch de worker');
  });
});

describe('meta-tarefas e fecho por evidência (missão 1+1 de 20/08)', () => {
  it('meta-tarefa sobre os próprios panes é do Maestro — workers não têm ferramenta de pane', () => {
    // Campo: worker entregou handoff partial "não há ferramenta para
    // perguntar a outro pane" — a delegação era estruturalmente impossível.
    const doctrine = buildOrchestratorDoctrine(null, {} as never);
    expect(doctrine).toContain('meta-tarefa');
    expect(doctrine).toContain('nexus_pane_write');
  });

  it('missão-informação fecha com handoff final do próprio Maestro', () => {
    // Campo: resposta validada nos panes mas missão eterna em running porque
    // ninguém tinha slot de handoff sobrando — exceto o Maestro, que pode
    // (canSubmitMissionHandoff aceita orchestrator) e nunca soube.
    const doctrine = buildOrchestratorDoctrine(null, {} as never);
    expect(doctrine).toContain('FECHO');
    expect(doctrine).toContain('submeta VOCÊ o handoff final');
  });
});

describe('doutrina de segurança chega ao coordenador', () => {
  const base = {
    title: 'Proteger o admin',
    objective: 'revise as permissões e proteja as rotas de admin',
    orchestratorName: 'Coordenar',
    teamNames: ['Coordenar', 'Executar'],
  };

  it('quem delega recebe a doutrina ANTES de escrever o prompt do worker', () => {
    // A nota ia só para o worker: o coordenador montava a tarefa sem saber
    // das regras que ela precisa respeitar.
    const brief = buildMaestroKickoffBrief({
      ...base,
      securityNote: 'Este pedido envolve SEGURANÇA. Regras: segredo nunca...',
    });
    expect(brief).toContain('envolve SEGURANÇA');
  });

  it('missão comum não carrega doutrina de segurança', () => {
    const brief = buildMaestroKickoffBrief(base);
    expect(brief).not.toContain('SEGURANÇA');
  });
});

describe('doutrina permanente do Maestro (F-701)', () => {
  it('missão que despacha workers recebe a doutrina curta de delegar', () => {
    expect(maestroStandingDoctrine(mission())).toBe(MAESTRO_STANDING_DOCTRINE);
    expect(MAESTRO_STANDING_DOCTRINE).toContain('nexus_pane_spawn');
    expect(MAESTRO_STANDING_DOCTRINE).toContain('depois de compactar');
    // Vai no prompt de sistema de toda sessão do Maestro: fica curta.
    expect(MAESTRO_STANDING_DOCTRINE.length).toBeLessThan(1_500);
  });

  it('execução direta e pergunta aos panes têm doutrina própria, que contradiz "delegue"', () => {
    for (const intentContract of [
      { lane: 'consult' },
      { lane: 'plan' },
      { budgets: { maxWorkers: 0 } },
    ]) {
      expect(maestroStandingDoctrine(mission({ intentContract } as Partial<Mission>))).toBeNull();
    }
    expect(maestroStandingDoctrine(mission({ title: 'pergunte aos panes quanto é 1+1' }))).toBeNull();
    expect(maestroStandingDoctrine(null)).toBeNull();
  });
});
