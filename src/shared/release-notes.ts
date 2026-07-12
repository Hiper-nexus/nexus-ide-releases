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
  version: '0.13.13',
  date: '2026-07-11',
  codename: 'Account Hot-Swap',
  summary:
    'Troca multi-conta operacional, failover por limite e credenciais isoladas para as principais CLIs, com panes mais claros e todas as melhorias anteriores.',
  highlights: [
    {
      title: 'Hot-swap multi-conta',
      detail:
        'Codex, Grok, Kimi, OpenCode e AGY recebem credenciais isoladas por conta, com troca operacional e sessão preservada.',
    },
    {
      title: 'Failover por limite',
      detail:
        'O Nexus reconhece limites de uso e prepara a retomada em uma conta reserva compatível.',
    },
    {
      title: 'Panes mais claros',
      detail:
        'A toolbar usa ações rotuladas, tooltips não recortados e um menu compacto para reduzir ruído sem esconder capacidade.',
    },
  ],
  fixes: [
    {
      title: 'Pacotes Linux',
      detail: 'O nome do executável agora coincide com o esperado pelos instaladores DEB e RPM.',
    },
    {
      title: 'Build macOS resiliente',
      detail: 'Downloads transitórios de dependências nativas recebem tentativas controladas antes da assinatura.',
    },
    {
      title: 'Continuidade preservada',
      detail: 'A release mantém wake local, Gemini Live pré-aquecido e execução operacional das melhorias anteriores.',
    },
  ],
};
