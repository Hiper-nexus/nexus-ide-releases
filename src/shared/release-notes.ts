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
  version: '0.19.24',
  date: '2026-07-21',
  codename: 'Terminal ao Vivo',
  summary:
    'Terminal com digitação visível em tempo real, workspace inequívoco e piloto automático mais simples, seguro e confiável.',
  highlights: [
    {
      title: 'Digitação sempre visível',
      detail:
        'Ao digitar, o terminal volta ao trecho ao vivo, prioriza a saída interativa e repinta o composer sem esperar Enter.',
    },
    {
      title: 'Workspace sem ambiguidade',
      detail:
        'A barra identifica o workspace ativo, mostra o caminho completo no seletor e mantém Novo workspace sempre acessível.',
    },
    {
      title: 'Piloto automático primeiro',
      detail:
        'O fluxo recomendado monta, executa, revisa e testa o trabalho; objetivo, controles e Oh My Pi usam linguagem mais direta.',
    },
  ],
  fixes: [
    {
      title: 'Renderer de terminal recuperável',
      detail:
        'Perda de contexto WebGL força fallback repintado, foco recupera backlog e resize sincroniza PTY e viewport imediatamente.',
    },
    {
      title: 'OMP sem duplicação nem vazamento',
      detail:
        'Auto-companion usa single-flight por missão e falhas de readiness ou prompt inicial encerram a sessão incompleta.',
    },
  ],
};

export const PREVIOUS_RELEASE: AppRelease = {
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
