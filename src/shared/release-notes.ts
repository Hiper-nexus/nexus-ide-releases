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
    'Hotfix operacional de voz: o Nexus usa live transcript sem deixar o provedor falar por fora, preserva comandos colados ao wake word e mantém uma voz única no executor da Jarvis.',
  highlights: [
    {
      title: 'Live passa pelo executor da Jarvis',
      detail:
        'O realtime agora acelera o transcript e encerra a captura ao receber fala final, mas respostas e ações voltam pelo cérebro/action executor auditável.',
    },
    {
      title: 'Clique e wake seguram a escuta',
      detail:
        'A saudação não entra mais no pre-roll do comando, o clique acorda sem herdar áudio antigo e a janela de escuta não fecha no eco de "Pois não, patrão?".',
    },
  ],
  fixes: [
    {
      title: 'Comando colado ao wake não se perde',
      detail:
        'O wake mic mantém pre-roll curto e marca fala real nos frames semeados, evitando cortar pedidos como "Hey Jarvis, abrir terminal".',
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
    {
      title: 'Voz consistente no modo live',
      detail:
        'Áudio do provedor realtime fica mudo enquanto o executor clássico responde com o TTS configurado, evitando alternância silenciosa de timbre no mesmo turno.',
    },
    {
      title: 'Configurações sem sobreposição',
      detail:
        'O botão Fechar do drawer agora fica fora da lista rolável e não cobre Agents/Skills quando o catálogo está expandido.',
    },
  ],
};
