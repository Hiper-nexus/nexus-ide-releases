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
  version: '0.19.6',
  date: '2026-07-16',
  codename: 'Pet Obediente',
  summary:
    'O pet de desktop deixa de grudar no mouse quando o botão é solto fora da janelinha (fim do arrasto instantâneo via lostpointercapture) e deixa de sumir quando o app entra em fullscreen — o pin de Spaces é re-afirmado e ele volta para a área visível.',
  highlights: [
    {
      title: 'Arrasto do pet confiável',
      detail:
        'Soltar o mouse em qualquer lugar encerra o arrasto na hora; o watchdog de emergência caiu de 30s para 10s.',
    },
    {
      title: 'Pet presente no fullscreen',
      detail:
        'Entrar/sair do fullscreen nativo re-fixa o pet em todos os Spaces e o reclampa para dentro da tela.',
    },
  ],
  fixes: [],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.5',
  date: '2026-07-16',
  codename: 'Frota Completa',
  summary:
    'O oh-my-pi entra em operação de background (roteador + Reviewer D no squad Review P0–P3, o rito que ele mesmo originou) e a parte de orquestração ganha a UX que faltava: editar squad abre um modal centralizado de verdade, e o painel inteiro recebeu hierarquia, hover e respiro.',
  highlights: [
    {
      title: 'omp trabalhando em background',
      detail:
        'O roteador escala o omp como diversidade (medium/hard) e o squad Review P0–P3 ganhou o Reviewer D (omp) — rode uma missão com esse squad para vê-lo revisar ao lado de Claude, Kimi e AGY.',
    },
    {
      title: 'Editar squad no meio da tela',
      detail:
        'O editor virou um dialog centralizado com fundo escurecido, Esc/clique-fora e foco automático — nada de rolar até o fim da lista para achá-lo.',
    },
  ],
  fixes: [
    {
      title: 'Painel de orquestração legível',
      detail:
        'Mais largura e respiro, tab ativa com âncora, toolbar fixa ao rolar, cards com hover e roster do editor em cartões com focus ring.',
    },
  ],
};
