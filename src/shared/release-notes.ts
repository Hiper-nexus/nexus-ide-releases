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
  version: '0.19.30',
  date: '2026-07-25',
  codename: 'Encerra e Entra',
  summary:
    'O orquestrador volta a nascer autenticado e a começar de verdade: nem tela de login, nem diálogo de confiança da pasta, nem squad built-in que não despacha. E encerrar uma missão viva volta a funcionar.',
  highlights: [
    {
      title: 'O pane abre logado',
      detail:
        'O orquestrador roda num HOME isolado, e de lá o CLI não enxerga o login da máquina — a credencial só chega pelo ambiente do processo. Ela era justamente retirada quando a conta escolhida É o login nativo, então o pane abria em "Not logged in" escrevendo "Welcome back". A decisão agora conhece o HOME que o pane vai receber.',
    },
    {
      title: 'A missão realmente começa',
      detail:
        'O pane carrega a confiança de pasta que você já concedeu, em vez de parar no diálogo "Do you trust the files in this folder?" esperando uma tecla que ninguém manda. E squad built-in vira cópia editável na hora de despachar, em vez de travar o botão Começar.',
    },
    {
      title: 'Encerrar missão viva',
      detail:
        'A confirmação parou de brigar com a própria missão: qualquer escrita durável feita enquanto você lia o modal invalidava a aprovação. Quanto mais viva a missão, mais impossível encerrá-la.',
    },
  ],
  fixes: [
    {
      title: 'Histórico do terminal na largura certa',
      detail:
        'O conteúdo salvo de um pane era reescrito antes da primeira medição, numa grade estreita: a moldura da interface do agente caía por cima do texto quebrado. Agora o histórico só volta depois que o terminal conhece a largura real.',
    },
    {
      title: 'Falha de credencial com motivo',
      detail:
        'Pane de HOME isolado sem credencial legível recusa o spawn explicando o que fazer, em vez de entregar um orquestrador mudo que trava a missão inteira sem dizer por quê.',
    },
    {
      title: 'HOME real sem token de ambiente',
      detail:
        'Onde o CLI cuida da própria sessão, o Nexus não injeta mais um instantâneo estático que expira em horas e tem precedência sobre o login — a origem do erro de credencial expirada ao reabrir um pane.',
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
