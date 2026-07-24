export interface ReleaseNote {
  title: string;
  detail: string;
}

export interface AppRelease {
  version: string;
  date: string;
  codename: string;
  summary: string;
  highlights: ReleaseNote[];
  fixes: ReleaseNote[];
}

export const CURRENT_RELEASE: AppRelease = {
  version: '0.19.27',
  date: '2026-07-23',
  codename: 'Golden Path',
  summary:
    'Missões aprovadas agora percorrem uma rota selada do kickoff ao handoff, com autoridade durável, execução observável e conclusão baseada em recibos verificáveis.',
  highlights: [
    {
      title: 'Rota selada e diversa',
      detail:
        'RouteReservation vincula missão, revisão, adapter, modelo e esforço antes do spawn; o roster permanece sticky e o router distribui trabalho sem degradar qualidade.',
    },
    {
      title: 'Kickoff com prova real',
      detail:
        'O processo principal materializa o orquestrador e só libera o scheduler após observar uma borda idle→busy com saída real, preservando missão, sessão e revisão exatas.',
    },
    {
      title: 'Handoff até a integração',
      detail:
        'Dispatcher, worktrees e merge queue usam leases e receipts duráveis; uma missão só chega a concluída quando a entrega aceita também possui integração ou validação verificável.',
    },
  ],
  fixes: [
    {
      title: 'Recuperação sem duplicação',
      detail:
        'Reinício, troca de renderer, saída física e failover preservam a autoridade do main, revogam sessões antigas e retomam apenas o trabalho que ainda é atual.',
    },
    {
      title: 'Aprovação compacta e bootstrap correto',
      detail:
        'A confirmação nativa mantém ações visíveis em telas pequenas; o bootstrap respeita o modelo padrão aprovado e o orquestrador Codex usa MCP auditado sem uma segunda confirmação invisível.',
    },
    {
      title: 'Release fail-closed',
      detail:
        'Build local limpo, Node/npm fixados, assinatura, notarização, Gatekeeper, SBOM, auditoria e missão E2E pertencem obrigatoriamente ao mesmo commit e aos mesmos artefatos.',
    },
  ],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.26',
  date: '2026-07-22',
  codename: 'Piloto Automático sem Modal',
  summary:
    'Aprovar a missão autoriza a execução inteira: o agente não para em modal a cada comando, o PREVC garante sem bloquear e o wizard virou fluxo único sem jargão.',
  highlights: [
    {
      title: 'Execução sem interrupção',
      detail:
        'A aprovação da missão é a autorização — deploy, SSH, edição de código e browser fluem direto, tudo auditado; só comandos destrutivos pedem confirmação.',
    },
    {
      title: 'PREVC que garante sem limitar',
      detail:
        'Sem contrato congelado a missão executa normalmente; com contrato, stage, drift e receipts continuam valendo. Tarefas mistas de infra + código funcionam.',
    },
    {
      title: 'Wizard fluxo único',
      detail:
        'Objetivo + lançar. Tipos de entrega viraram Opções avançadas colapsadas, em linguagem simples, com Sem restrições como padrão.',
    },
  ],
  fixes: [
    {
      title: 'Fim do stall de confirmação',
      detail:
        'O agente não fica mais minutos parado esperando clique em modal a cada ação — a autorização vem da missão aprovada, com auditoria fail-closed.',
    },
    {
      title: 'Kickoff anti-travamento',
      detail:
        'O orquestrador executa direto e trata freeze/bootstrap PREVC como best-effort em segundo plano, nunca como pré-condição.',
    },
  ],
};
