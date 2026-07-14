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
  version: '0.15.14',
  date: '2026-07-14',
  codename: 'Missão Enxuta',
  summary:
    'Missão curta paga prompt curto: kickoff sem duplicação, cartas de worker proporcionais ao papel/tarefa e início em um clique para risco normal — PREVC, budgets e aprovações sensíveis intactos.',
  highlights: [
    {
      title: 'Kickoff sem duplicação',
      detail:
        'A memória compacta só entra quando há progresso real e o critério auto-derivado deixa de reencenar o objetivo — o goal aparece uma vez, não três.',
    },
    {
      title: 'Cartas proporcionais ao papel',
      detail:
        'Scout/architect não pagam cartas de build, reviewer dispensa a escada de diff e a carta de design só acompanha tarefas com sinal de UI.',
    },
    {
      title: 'Começar em um clique',
      detail:
        'Risco normal compila e despacha direto do composer; "Revisar plano" mantém as duas etapas e superfícies sensíveis seguem exigindo aprovação.',
    },
    {
      title: 'Wizard fala humano',
      detail:
        'O estado da fila vira "Processando o objetivo…" em vez de jargão interno, e some quando não há nada em andamento.',
    },
  ],
  fixes: [
    {
      title: 'Kickoff legado sem trava de mapa frio',
      detail:
        'O warm de orientação tem teto de 4 s antes do paste; o fallback "mapa aquecendo" e o doctor sob demanda cobrem o resto.',
    },
    {
      title: 'Proporcionalidade explícita no playbook',
      detail:
        'Missão pequena é UMA tarefa e UM especialista — o orquestrador não cria cerimônia além do necessário.',
    },
  ],
};
