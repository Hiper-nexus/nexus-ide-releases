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

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.25',
  date: '2026-07-22',
  codename: 'Piloto Automático de Verdade',
  summary:
    'Lane ops para infra sem PREVC, fila de bootstrap destravada, bootstrap convergente sem segundo provider, panes Codex sem review de hooks e login OMP sem aba fantasma.',
  highlights: [
    {
      title: 'Lane ops (Operação/infra)',
      detail:
        'Missões de deploy, backup e SSH executam terminal/browser sem exigir contexto PREVC, com aprovação de intenção e auditoria mantidas.',
    },
    {
      title: 'Bootstrap destravado',
      detail:
        'Retry faz join em vez de prompt_queue_busy, watchdog libera slot preso e o usuário aprova o contexto pela UI — sem depender de segundo provider.',
    },
    {
      title: 'Panes Codex sobem direto',
      detail:
        'Hooks de status pré-confiados via trusted_hash no config.toml e bypass com guard de versão — sem a tela "hooks need review".',
    },
  ],
  fixes: [
    {
      title: 'Login OMP sem aba fantasma',
      detail:
        'Autorização OAuth em janela in-app endurecida que abre e fecha sozinha.',
    },
    {
      title: 'Fila sem deadlock',
      detail:
        'Awaits de orientation com bound e watchdog de 10 min no slot executing — missão nunca mais trava esperando o mapa do projeto.',
    },
  ],
};
