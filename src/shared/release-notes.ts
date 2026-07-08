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
  version: '0.10.27',
  date: '2026-07-08',
  codename: 'Jarvis Voice Lock',
  summary:
    'A Jarvis ficou mais estável em voz e wake/click, com retry automático da voz principal e menos desistência prematura no realtime.',
  highlights: [
    {
      title: 'Voz principal volta sozinha',
      detail:
        'Quando o TTS cai para fallback por quota/rede, a Jarvis mantém a fala viva por alguns turnos, mas volta a tentar a voz OpenAI configurada automaticamente.',
    },
    {
      title: 'Wake por clique mais paciente',
      detail:
        'Turnos iniciados por Hey Jarvis ou clique ganham uma janela maior para receber transcript final realtime antes de desistir ou cair para o Classic.',
    },
    {
      title: 'Menu de configurações alinhado',
      detail:
        'O botão Fechar do painel de configurações virou rodapé próprio, sem raspar por cima dos itens do catálogo.',
    },
  ],
  fixes: [
    {
      title: 'Fallback TTS rastreável',
      detail:
        'O log agora deixa claro quando a voz está em fallback temporário e quando a voz principal foi recuperada.',
    },
    {
      title: 'Realtime com diagnóstico melhor',
      detail:
        'Mensagens de timeout do transcript realtime mostram a janela usada, separando wake/click de PTT/manual.',
    },
    {
      title: 'Manual e PTT continuam rápidos',
      detail:
        'A janela maior foi limitada aos turnos hands-free; captura manual e push-to-talk seguem no caminho curto.',
    },
  ],
};
