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
  version: '0.10.8',
  date: '2026-07-07',
  codename: 'Jarvis mais operacional',
  summary:
    'Hotfix de paridade operacional: a Jarvis ganhou mais controle nativo do app, limpeza de sessão MCP por turno, fala em uma única voz por resposta e seleção explícita do transporte realtime.',
  highlights: [
    {
      title: 'Mais ações nativas sem LLM',
      detail:
        'Comandos como abrir configurações, configurações de voz, modo canvas e grade agora usam fast-path e executor direto.',
    },
    {
      title: 'Sessões de ação mais limpas',
      detail:
        'Cada turno limpa o cache de permissões MCP depois de executar, evitando estado reaproveitado entre comandos por voz.',
    },
    {
      title: 'Realtime configurável',
      detail:
        'O painel de voz permite escolher OpenAI Realtime ou Gemini Live, persiste a escolha na hora e mostra o diagnóstico da chave correta.',
    },
  ],
  fixes: [
    {
      title: 'Voz sem troca no meio da resposta',
      detail:
        'Respostas da Jarvis voltam a ser sintetizadas em uma chamada TTS, impedindo que primeira frase e restante caiam em vozes diferentes.',
    },
    {
      title: 'UI operável pela Jarvis',
      detail:
        'O parser do cérebro e o transcript live reconhecem as novas ações de settings/canvas/grade em vez de tratá-las como conversa.',
    },
    {
      title: 'Fast-paths com persona',
      detail:
        'As ações novas mantêm o tratamento configurado do usuário e respostas curtas, sem round-trip para o modelo.',
    },
  ],
};
