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
  version: '0.10.7',
  date: '2026-07-07',
  codename: 'Jarvis operacional',
  summary:
    'Hotfix operacional baseado na análise interna de voz: o Nexus preserva a fala colada ao wake word, limpa eco da saudação e mantém o tratamento "patrão" nos comandos rápidos.',
  highlights: [],
  fixes: [
    {
      title: 'Comando colado ao wake não se perde',
      detail:
        'O wake mic agora mantém um pre-roll curto de áudio e semeia a captura do comando quando o "Hey Jarvis" dispara, evitando cortar pedidos como "Hey Jarvis, abrir terminal".',
    },
    {
      title: 'Eco da saudação é filtrado',
      detail:
        'Prefixos de wake e respostas como "Pois não, patrão?" são removidos antes do fast-path/brain; ack puro vazado pelo alto-falante é descartado em silêncio.',
    },
    {
      title: 'Persona nos fast-paths críticos',
      detail:
        'Comandos diretos como abrir terminal e consultas como "que horas são" recebem o nome configurado do usuário no contexto, mantendo respostas breves e cordiais com "patrão".',
    },
  ],
};
