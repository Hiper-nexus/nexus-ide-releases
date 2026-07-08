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
  version: '0.10.33',
  date: '2026-07-08',
  codename: 'Jarvis Realtime Observability',
  summary:
    'A Jarvis ganhou telemetria realtime mais fiel e logs de teste isolados, para medir latência de ação sem contaminar o diagnóstico do microfone real.',
  highlights: [
    {
      title: 'Latência live mensurável',
      detail:
        'O transporte realtime agora marca a ação no instante em que o provider chama a ferramenta, antes do resultado voltar do executor.',
    },
    {
      title: 'Logs reais limpos',
      detail:
        'A suíte Vitest grava voice.log e métricas realtime em diretório temporário, sem poluir ~/.nexus/logs/voice.log durante validações.',
    },
    {
      title: 'Métricas configuráveis',
      detail:
        'As métricas da Jarvis aceitam override por NEXUS_JARVIS_METRICS_FILE, mantendo produção e testes separados.',
    },
  ],
  fixes: [
    {
      title: 'Diagnóstico de wake preservado',
      detail:
        'Testes de TTS e fallback de voz não aparecem mais no log operacional usado para depurar o microfone físico.',
    },
    {
      title: 'Regressão travada por teste',
      detail:
        'Novos testes cobrem o override de métricas e a marcação imediata de action latency no caminho realtime.',
    },
    {
      title: 'Release auditável',
      detail:
        'Typecheck e suíte completa passam com a ponte realtime/MCP preservada e sem nomes de concorrentes em código rastreado.',
    },
  ],
};
