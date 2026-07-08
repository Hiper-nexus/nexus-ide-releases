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
  version: '0.10.29',
  date: '2026-07-08',
  codename: 'Jarvis Live Parity',
  summary:
    'A Jarvis ficou mais live de verdade: prompt realtime em inglês, clique que já começa ouvindo, comandos com voz realtime e menos queda para TTS Classic.',
  highlights: [
    {
      title: 'Prompt realtime em inglês',
      detail:
        'A sessão live agora recebe instruções em inglês para melhorar aderência a ferramentas, mantendo a fala final em português brasileiro.',
    },
    {
      title: 'Clique acorda e já escuta',
      detail:
        'O clique na Jarvis inicia a captura antes do ACK terminar, reduzindo perda do comando quando o usuário fala junto da saudação.',
    },
    {
      title: 'Resposta de comandos pela voz live',
      detail:
        'Quando a sessão realtime está pronta, respostas curtas de ações usam a própria voz live antes de cair no TTS Classic.',
    },
  ],
  fixes: [
    {
      title: 'Wake/click esperam melhor o transcript',
      detail:
        'As janelas de finalização do transcript foram ampliadas para wake e clique sem piorar o tempo de PTT/manual.',
    },
    {
      title: 'Tool-calling live mais assertivo',
      detail:
        'O contrato live agora manda executar ações de app por ferramenta imediatamente, sem apenas prometer que abriu ou fez algo.',
    },
    {
      title: 'Sem referência externa no código',
      detail:
        'A implementação mantém nomes e comparações privadas fora dos arquivos rastreados do produto.',
    },
  ],
};
