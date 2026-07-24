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
  version: '0.19.29',
  date: '2026-07-24',
  codename: 'Encerrar de Verdade',
  summary:
    'Encerrar uma missão passa a exigir prova física de saída, a lista volta a esvaziar (Encerradas + Arquivar) e toda retomada de missão bloqueada é do processo principal, adotando o PTY vivo ou selando um pane novo.',
  highlights: [
    {
      title: 'Encerramento com prova física',
      detail:
        'Sessão viva que a missão aponta e nenhuma autoridade de pane consegue atribuir agora NEGA o encerramento com erro nomeado, preservando o vínculo — antes o Nexus devolvia sucesso e apagava o ponteiro, deixando o processo órfão.',
    },
    {
      title: 'A lista esvazia',
      detail:
        'O rail agrupa por runtime físico: missão sem sessão e sem pane sai de Em progresso e cai em Encerradas, fechada por padrão. Arquivar tira do rail e do board sem apagar nada durável, com desarquivar no próprio card.',
    },
    {
      title: 'Retomada main-owned',
      detail:
        'Toda missão bloqueada retoma pelo processo principal, que adota o PTY ainda vivo ou limpa a identidade comprovadamente morta e sela um pane novo — fim do pane fantasma e do beco circular do Retomar missão.',
    },
  ],
  fixes: [
    {
      title: 'Aviso honesto de encerramento',
      detail:
        '"1 sessão encerrada" quando houve desligamento real versus "nenhum processo restava vivo" — o no-op deixou de ser indistinguível do encerramento de verdade.',
    },
    {
      title: 'Lista não trava mais',
      detail:
        'Recusa da autoridade virou resultado em vez de promessa rejeitada: o estado ocupado não fica mais preso desabilitando todos os botões sem explicação.',
    },
    {
      title: 'Reload de página não mata a sessão',
      detail:
        'Sessão que já pertence ao mesmo renderer reata após HMR, Cmd+R ou recuperação de crash, em vez de morrer na cerca de saída física.',
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
