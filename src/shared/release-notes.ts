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
  version: '0.19.21',
  date: '2026-07-20',
  codename: 'Estúdio Seguro',
  summary:
    'Estúdio de Mídia para imagem e vídeo, OMP cli-rpc como pane de primeira classe e hardening de auth, credenciais e acesso remoto após três rodadas de revisão.',
  highlights: [
    {
      title: 'Estúdio de Mídia operacional',
      detail:
        'Geração de imagem e vídeo ganhou uma superfície para usuário final, cancelamento e custo de vídeo visível.',
    },
    {
      title: 'OMP cli-rpc no grid',
      detail:
        'O runtime OMP por RPC passa a funcionar como pane de primeira classe junto aos demais agentes.',
    },
    {
      title: 'Segurança revisada em profundidade',
      detail:
        'Auth, credenciais e acesso remoto receberam hardening em três passes de revisão.',
    },
  ],
  fixes: [
    {
      title: 'Motor de mídia previsível',
      detail:
        'Timeout de imagem agora representa o prazo real e referências ausentes falham explicitamente.',
    },
    {
      title: 'Achados críticos e altos encerrados',
      detail:
        'As correções das auditorias de segurança reduziram os achados residuais para severidade baixa.',
    },
  ],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.20',
  date: '2026-07-19',
  codename: 'Sci-Fi de Verdade',
  summary:
    'Redesign sci-fi da interface com paridade mac/win/linux, GitHub Device Flow com gate de push→PR, stack SSH colhida do emdash (ProxyJump, port-forward resiliente), security floor do router fail-closed e cards de pane com atividade real — zero LLM.',
  highlights: [
    {
      title: 'UI sci-fi refinada e multiplataforma',
      detail:
        'Redesign visual completo com paridade de renderização entre macOS, Windows e Linux.',
    },
    {
      title: 'GitHub Device Flow com gate push→PR',
      detail:
        'OAuth por device code com erros tipados; push vira PR com gate explícito (emdash W2).',
    },
    {
      title: 'Panes com atividade real, zero LLM',
      detail:
        'Cards de pane mostram atividade real do terminal sem custo de modelo (colheita Overclock).',
    },
  ],
  fixes: [
    {
      title: 'Security floor fail-closed',
      detail:
        'Classificação incerta de modelo liga o security floor — na dúvida o tier sobe, nunca desce.',
    },
    {
      title: 'Credencial probada antes do spawn',
      detail:
        'Probe pré-spawn + watchdog de login-stuck evitam panes presos em tela de login (Overclock F-256).',
    },
  ],
};
