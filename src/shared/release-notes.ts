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
  version: '0.13.1',
  date: '2026-07-11',
  codename: 'Mission Rail',
  summary:
    'Activity Rail de missões, multi-missão sem kill quando seguro, integrações forge/Linear/SSH e polimento Jarvis/Design Mode para operação diária em paralelo.',
  highlights: [
    {
      title: 'Activity Rail e multi-missão segura',
      detail:
        'Missões pinned/em progresso/fila/done na trilha; retomar foca panes vivos; segunda missão faz merge sem matar agentes quando não há conflito de login Claude.',
    },
    {
      title: 'Integrações forge, Linear e SSH',
      detail:
        'Create PR, issues no rail, Linear, anotar diffs, port-forward e transporte ssh2 com remote worktree — com avisos de terceiros opcionais no pacote.',
    },
    {
      title: 'Jarvis e Design Mode mais claros',
      detail:
        'Mute/gate de saída de voz, smoke live com ownership estável e outline verde no elemento selecionado no browser (hover azul separado).',
    },
  ],
  fixes: [
    {
      title: 'Reabrir missão já aberta não destrói o grid',
      detail:
        'Soft-focus nos panes vivos; confirmação e kill seletivo só quando um segundo orquestrador Claude partilharia o keychain.',
    },
    {
      title: 'Lançar squad em paralelo sem wipe total',
      detail:
        'killLiveAgents em massa deixa de ser o default; só orquestradores em conflito exclusivo são encerrados.',
    },
  ],
};
