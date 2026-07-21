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
  version: '0.19.22',
  date: '2026-07-21',
  codename: 'Jarvis Operacional + Fluxo Rápido',
  summary:
    'Jarvis Live mais responsiva e recuperável, wake passivo protegido contra TV/ambiente e nove melhorias de operação inspiradas na paridade Orca/Overclock, incluindo fan-out e companion mobile.',
  highlights: [
    {
      title: 'Jarvis Live sem estados presos',
      detail:
        'Drenagem de PCM, follow-up e watchdog agora encerram ou recuperam o turno completo antes de liberar a interface.',
    },
    {
      title: 'Wake passivo resistente a ambiente',
      detail:
        'TV e áudio contínuo são barrados localmente por assinatura forcedByMax e backoff de até 60 segundos, sem loop de STT.',
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
        'O prazo antes de degradar para Classic caiu de seis para 3,5 segundos, preservando margem para respostas saudáveis.',
    },
    {
      title: 'Companion e superfícies coerentes',
      detail:
        'Tabs se adaptam ao modo atual, comparação fica escopada por missão e o scaffold mobile compartilha o contrato operacional.',
    },
  ],
};

export const PREVIOUS_RELEASE: AppRelease = {
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
