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

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.18',
  date: '2026-07-17',
  codename: 'Deixa de Travar',
  summary:
    'Auditoria completa das causas de freeze. "Toda hora um limite diferente" tinha raiz numa pilha de gates onde quase tudo exigia contrato congelado. Dois desgates seguros: documentar/planejar (todo_manager, clarify) não exigem mais freeze, e sensores typecheck/unit ausentes viram aviso em vez de bloquear. A integridade de mutação de código fica intacta.',
  highlights: [
    {
      title: 'Documentar e planejar sem trava',
      detail:
        'Gerenciar tarefas e perguntar ao usuário vêm antes de congelar contexto — não exigem mais contrato PREVC congelado.',
    },
    {
      title: 'Sensores recomendados, não obrigatórios',
      detail:
        'Faltar typecheck/unit vira aviso; o freeze passa e os sensores existentes seguem rodando no PREVC.',
    },
  ],
  fixes: [],
};
