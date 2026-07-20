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

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.19',
  date: '2026-07-18',
  codename: 'Missão Que Começa',
  summary:
    'Modo agêntico deixa de travar no Começar: falso positivo de evidência ("em seguida… do print") não prende mais a missão em awaiting_goal; shell Sem objetivo reabre o wizard em vez de erro de panes; power-off da Jarvis corta narração de verdade.',
  highlights: [
    {
      title: 'Começar missão no agêntico',
      detail:
        'Objetivos que só citam print existente despacham normalmente; approveIntent promove contrato compilado em vez de falhar com awaiting_goal.',
    },
    {
      title: 'Retomar shell armado',
      detail:
        'Missões Na fila / Sem objetivo (intent-first) reabrem Nova Missão com o objetivo pré-preenchido — sem "sem panes registrados".',
    },
    {
      title: 'Jarvis desliga de verdade',
      detail:
        'O botão power-off para a fila de narração e o áudio em voo; idle não reacende a fala até o próximo wake/PTT.',
    },
  ],
  fixes: [
    {
      title: 'Gate de evidência futura mais conservador',
      detail:
        'Exige ação de envio/anexo (ou "com prints") — não basta "em seguida" perto de "print".',
    },
  ],
};
