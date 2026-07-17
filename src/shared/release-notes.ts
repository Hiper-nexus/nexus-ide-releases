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
  version: '0.19.14',
  date: '2026-07-17',
  codename: 'Sem Freio de Mão',
  summary:
    'Missões não travam mais por "orçamento de tokens esgotado": aquele teto era um contador sintético (estimativas fictícias por tool, não a conta real do provider) e derrubava missões ainda no bootstrap. Agora o ledger só registra — quem protege contra desgoverno são os limites reais: driver da missão, PREVC e workers vivos.',
  highlights: [
    {
      title: 'Fim do bloqueio por tokens fictícios',
      detail:
        'O contrato de intenção continua auditando passos e gasto estimado, mas nenhuma tool é negada por isso. Missões já travadas por orçamento destravam sozinhas no próximo passo.',
    },
  ],
  fixes: [],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.13',
  date: '2026-07-17',
  codename: 'Missão com Nome Próprio',
  summary:
    'Missão agêntica com squad reusado deixa de vestir a identidade da missão antiga: o título vem do SEU objetivo, o modelo escolhido na revisão do roster persiste até o spawn (adeus Fable virando opus sozinho) e as instruções do squad são reapontadas para o objetivo vigente antes do kickoff.',
  highlights: [
    {
      title: 'Título da missão é o seu objetivo',
      detail:
        'Reusar o roster salvo não renomeia mais a missão com o nome do squad antigo — a missão de dashboards chama-se dashboards, não "Clone Overclock".',
    },
    {
      title: 'Roster revisado é o roster que sobe',
      detail:
        'Eventos de quota/instalação não resetam mais suas edições na tela de revisão; o modelo do orquestrador que você escolheu é o que o pane usa.',
    },
  ],
  fixes: [],
};

