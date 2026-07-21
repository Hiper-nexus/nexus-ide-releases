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
  version: '0.19.23',
  date: '2026-07-21',
  codename: 'Piloto Automático Real',
  summary:
    'Orquestração com prova de aceite por evento, recuperação automática de reviewers, OMP multiprovider sem falso bloqueio e notificações responsivas.',
  highlights: [
    {
      title: 'Entrega sem duplicação',
      detail:
        'Prompts e handoffs capturam até turnos muito rápidos pela borda idle→busy, sem depender de polling tardio.',
    },
    {
      title: 'Recuperação autônoma',
      detail:
        'Reviewer preservado inválido é fechado e substituído na mesma passagem do Doctor.',
    },
    {
      title: 'OMP e AGY alinhados ao runtime',
      detail:
        'O cofre multiprovider do OMP deixa de ser bloqueado pelo Nexus e o catálogo AGY acompanha os modelos realmente publicados pelo CLI.',
    },
  ],
  fixes: [
    {
      title: 'Quorum independente honesto',
      detail:
        'Um provider bloqueia review cruzado; dois liberam a missão e providers adicionais permanecem recomendados.',
    },
    {
      title: 'Inbox responsivo',
      detail:
        'Notificações permanecem inteiras e roláveis em janelas estreitas ou baixas.',
    },
  ],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.22',
  date: '2026-07-21',
  codename: 'Jarvis Operacional + Fluxo Rápido',
  summary:
    'Jarvis Live mais responsiva e recuperável, wake passivo protegido contra TV/ambiente e melhorias de operação inspiradas na paridade Orca/Overclock.',
  highlights: [
    {
      title: 'Jarvis Live sem estados presos',
      detail:
        'Drenagem de PCM, follow-up e watchdog encerram ou recuperam o turno antes de liberar a interface.',
    },
    {
      title: 'Wake passivo resistente a ambiente',
      detail:
        'TV e áudio contínuo são barrados localmente, sem loop de STT.',
    },
    {
      title: 'Missões com menos atrito',
      detail:
        'Drop de arquivos, atalho de missão, activity stream, marketplace, status Git, fan-out e editor refinado encurtam o fluxo operacional.',
    },
  ],
  fixes: [
    {
      title: 'Fallback Live mudo mais rápido',
      detail:
        'O prazo antes de degradar para Classic caiu de seis para 3,5 segundos.',
    },
    {
      title: 'Companion e superfícies coerentes',
      detail:
        'Tabs, comparação por missão e scaffold mobile compartilham o contrato operacional.',
    },
  ],
};
