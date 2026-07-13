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
  version: '0.15.3',
  date: '2026-07-13',
  codename: 'Reliable Orchestration',
  summary:
    'Ralph Loop, Doctor, panes e Jarvis agora compartilham autoridade durável, evidência verificável e recuperação em tempo real.',
  highlights: [
    {
      title: 'Ralph Loop verificável',
      detail:
        'O Mission Driver persiste tentativas e só conclui marcos por receipts PREVC ligados a evidência Nexus atual e confiável.',
    },
    {
      title: 'Recuperação atômica de panes',
      detail:
        'Panes mortos renascem na mesma identidade; recap e Enter são confirmados na nova sessão antes de o orquestrador ser religado.',
    },
    {
      title: 'Jarvis realmente realtime',
      detail:
        'Wake descarta sockets Live zumbis, preserva áudio pendente e transforma fala natural em briefing executável para o squad correto.',
    },
  ],
  fixes: [
    {
      title: 'Autopilot com evidência',
      detail:
        'Sensores e revisão final publicam um handoff idempotente, e cada marco recebe apenas sua própria evidência antes de avançar.',
    },
    {
      title: 'Supervisão sem falsos travamentos',
      detail:
        'O Doctor respeita panes vivos e atividade real, com timeouts finitos e sem fechar ou duplicar trabalho que continua operando.',
    },
    {
      title: 'Wake PT-BR instalado',
      detail:
        'O pacote treinado é verificado e instalado por padrão como custom.onnx; modelos treinados localmente pelo usuário permanecem intactos.',
    },
    {
      title: 'Squads e pets operacionais',
      detail:
        'Seleção de squads usa nomes reais e fuzzy matching; galeria de pets mantém preview, compactação e Pet Studio com dependências disponíveis.',
    },
    {
      title: 'Versões alinhadas',
      detail:
        'Aplicativo, servidor, lockfile, changelog e notas internas avançam juntos para impedir releases mistos.',
    },
  ],
};
