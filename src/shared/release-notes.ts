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
  version: '0.13.2',
  date: '2026-07-11',
  codename: 'Design Systems',
  summary:
    'Importação de design systems (DESIGN.md / designmd.ai) no pipeline de contexto, copiar contexto no Design Mode, e gate de CI estável em runners Linux sem userns.',
  highlights: [
    {
      title: 'Design systems no contexto verificável',
      detail:
        'Lê DESIGN.md do projeto, tools MCP search/get/import via designmd.ai e grava só drafts com review — sem escrever autoridade sem aprovação.',
    },
    {
      title: 'Design Mode: copiar sem injectar',
      detail:
        'Dry-run devolve o prompt formatado para a clipboard; o DESIGN.md do workspace entra no contexto enviado ao agent quando existe.',
    },
    {
      title: 'Mission Rail e multi-missão (0.13.1)',
      detail:
        'Activity Rail, merge sem kill quando seguro, forge/Linear/SSH e mute Jarvis permanecem nesta linha de release.',
    },
  ],
  fixes: [
    {
      title: 'CI Linux com bwrap sem userns',
      detail:
        'Probe de sandbox real; testes de exec sandboxed saltam no GHA; evidence sintético válido no workflow de contexto.',
    },
  ],
};
