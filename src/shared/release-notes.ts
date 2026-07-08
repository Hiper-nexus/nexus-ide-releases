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
  version: '0.10.34',
  date: '2026-07-08',
  codename: 'Jarvis Live Responsiveness',
  summary:
    'A Jarvis ficou mais responsiva no clique e no bridge realtime: quando já há áudio local válido, ela cai rápido para o executor Classic em vez de esperar vários segundos por transcript final.',
  highlights: [
    {
      title: 'Clique mais operacional',
      detail:
        'O wake por mouse continua falando o ACK antes de ouvir, mas deixa de segurar oito segundos depois que já detectou fala.',
    },
    {
      title: 'Fallback realtime mais rápido',
      detail:
        'Wake e clique ainda dão mais tempo ao realtime quando o mic está fraco; com fala local aproveitável, o fallback para STT Classic acontece em janela curta.',
    },
    {
      title: 'Bridge MCP mais auditável',
      detail:
        'A cobertura agora trava o fluxo invoke → confirmação nativa → retry para comandos e delegação de panes.',
    },
  ],
  fixes: [
    {
      title: 'Menos sensação de travamento',
      detail:
        'Quando o provider realtime não devolve transcript final a tempo, a Jarvis não fica esperando a janela longa se o WAV local já pode seguir para STT.',
    },
    {
      title: 'Ações de terminal protegidas',
      detail:
        'O caminho MCP de run_command mantém confirmação nativa e retorna user_denied sem retry quando o usuário recusa.',
    },
    {
      title: 'Release auditável',
      detail:
        'Typecheck, suíte completa e varredura de nomes proibidos seguem como gates antes de publicar o build assinado.',
    },
  ],
};
