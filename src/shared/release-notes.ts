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
  version: '0.13.12',
  date: '2026-07-11',
  codename: 'Operator UX',
  summary:
    'Navegação operacional mais clara, contas verificáveis e configurações responsivas, sem perder as melhorias realtime, de autenticação e descoberta dinâmica de CLIs.',
  highlights: [
    {
      title: 'Voltar às missões',
      detail:
        'Configurações mantém localização e saída visíveis no topo, inclusive após rolar e em telas menores.',
    },
    {
      title: 'Contas sem ambiguidade',
      detail:
        'Claude, Codex, Kimi e demais CLIs mostram login, conta ativa, reservas e resultado da verificação com linguagem direta.',
    },
    {
      title: 'Configurações responsivas',
      detail:
        'Providers, Squads, credenciais e formulários reorganizam conteúdo e ações sem sobreposição em diferentes tamanhos de tela.',
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
