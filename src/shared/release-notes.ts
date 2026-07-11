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
  version: '0.13.7',
  date: '2026-07-11',
  codename: 'Realtime Operator',
  summary:
    'Jarvis mais operacional: Gemini Live pré-aquecido, wake e follow-up resilientes, ações reais no workspace, autenticação preservada e CLIs sempre atualizadas.',
  highlights: [
    {
      title: 'Realtime pré-aquecido',
      detail:
        'Gemini Live permanece conectado antes do wake; barge-in, continuidade e rescue local reduzem turnos perdidos e repetição de comandos.',
    },
    {
      title: 'Ações operacionais',
      detail:
        'Jarvis abre workspaces, envia comandos ao pane correto e confirma operações sensíveis sem duplicar voz ou perder o transcript explícito.',
    },
    {
      title: 'CLIs dinâmicas e automáticas',
      detail:
        'Modelos e efforts são descobertos dos caches das CLIs, incluindo Codex ultra; providers iniciam no bypass total nativo salvo escolha manual.',
    },
  ],
  fixes: [
    {
      title: 'Login Claude em squads',
      detail: 'OAuth ativo acompanha workers com HOME isolado sem pedir login novamente.',
    },
    {
      title: 'Efforts sem lista fixa',
      detail: 'Squads aceitam capacidades futuras anunciadas por qualquer CLI.',
    },
    {
      title: 'Wake e áudio',
      detail: 'AEC3, pre-roll maior, cooldown curto, watchdog e captura durante fala reduzem silêncio e travamentos.',
    },
  ],
};
