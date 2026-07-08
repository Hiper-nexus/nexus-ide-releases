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
  version: '0.10.28',
  date: '2026-07-08',
  codename: 'Jarvis Live Control',
  summary:
    'A Jarvis ficou mais operacional em wake, clique e realtime, com recuperação de fala fraca e contrato único para ações live.',
  highlights: [
    {
      title: 'Fala fraca não morre antes do STT',
      detail:
        'Turnos iniciados por Hey Jarvis ou clique agora usam RMS/pico da captura para tentar STT mesmo quando o gate principal marcou sinal baixo.',
    },
    {
      title: 'Realtime actions com contrato único',
      detail:
        'OpenAI Realtime e Classic compartilham o mesmo mapeamento de ações Nexus, reduzindo drift entre conversa live e executor auditável.',
    },
    {
      title: 'Perguntas de contexto mais rápidas',
      detail:
        'Consultas como qual pane ou página estamos entram no fast-path local, sem esperar LLM para responder o estado atual do app.',
    },
  ],
  fixes: [
    {
      title: 'Diagnóstico de mic baixo',
      detail:
        'O log persistente registra duração, RMS e pico de capturas fracas sem gravar conteúdo da fala, ajudando a calibrar o Fifine no teste real.',
    },
    {
      title: 'Wake/click continuam protegidos contra eco',
      detail:
        'A recuperação de fala fraca só vale para wake/clique e ainda passa pelos filtros de ACK, lixo de Whisper e eco de TTS.',
    },
    {
      title: 'Sem referência externa no código',
      detail:
        'A implementação mantém nomes e comparações privadas fora dos arquivos rastreados do produto.',
    },
  ],
};
