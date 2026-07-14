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
  version: '0.15.15',
  date: '2026-07-14',
  codename: 'Autonomia Travada, Revisão Humana',
  summary:
    'Defaults de autonomia pinados por teste, orçamento de workers sem corrida, rail que mostra quando a missão espera VOCÊ, missão auditável desde a issue e revisão humana de diff entregue ao orquestrador.',
  highlights: [
    {
      title: 'Revisão humana chega ao orquestrador',
      detail:
        'As anotações de diff são submetidas como um prompt único ao orquestrador da missão ativa, que delega o retrabalho — revisar deixa de depender de qual pane está focado.',
    },
    {
      title: 'Rail mostra quando a missão espera você',
      detail:
        'Pills "Aguarda você", "Sem objetivo" e "Pronta" substituem o genérico "Na fila"; a meta fala de agentes e de há quanto tempo a missão roda.',
    },
    {
      title: 'Missão auditável desde a issue',
      detail:
        'Issues do GitHub/Linear viram missões com source imported-issue no contrato; objetivos por voz registram source voice.',
    },
    {
      title: 'Missão enxuta (0.15.14)',
      detail:
        'Kickoff sem duplicação, cartas de worker por papel/tarefa, começo em um clique para risco normal e wizard sem jargão.',
    },
  ],
  fixes: [
    {
      title: 'Autonomia pinada por teste',
      detail:
        'defaultDriveConfig nasce em shadow, congelado e com budgets finitos; trocar isso agora quebra um teste em vez de re-armar autonomia em silêncio.',
    },
    {
      title: 'Orçamento de workers sem corrida',
      detail:
        'A reserva de slot só cai depois que o worker está durável em missionPanes; sem a linha, a reserva fica retida (fail-safe) com aviso.',
    },
    {
      title: 'Soak antes de default-on',
      detail:
        'Política operacional codificada: capability autônoma nasce fail-safe, default pinado por teste, um ciclo de shadow antes do flip e inventário de todas as portas de efeito.',
    },
  ],
};
