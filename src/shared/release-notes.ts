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

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.4',
  date: '2026-07-16',
  codename: 'Paridade Viva',
  summary:
    'O modo Design ganha emulação mobile de verdade (o site serve o layout de celular, não só a largura), a camada forge liga GitLab MR e o "PR desta branch" no painel, e o instalador 1-clique passa a cobrir agy, kimi e grok com canais oficiais verificados — 8 das 9 CLIs instalam pelo app.',
  highlights: [
    {
      title: 'Modo mobile de verdade',
      detail:
        'O breakpoint 📱 emula um iPhone (user agent + métricas) com reload — menu hambúrguer e media queries reais. ⛶ restaura o navegador normal.',
    },
    {
      title: 'Forge multi-provider',
      detail:
        'GitHub e GitLab criam PR/MR pelo mesmo caminho autorizado e auditado; o painel mostra o PR aberto da branch atual, clicável. Token GitLab via glab CLI ou NEXUS_GITLAB_TOKEN.',
    },
    {
      title: 'Instalador cobre quase tudo',
      detail:
        'agy (instalador oficial do Google, baixado por HTTPS sem pipe), kimi (brew/npm oficiais) e grok (npm oficial xAI) entram no 1-clique com confirmação nativa.',
    },
  ],
  fixes: [
    {
      title: 'Painéis não abrem mais atrás das Configurações',
      detail:
        'Ativar OMP RPC/Memória/Configs com o drawer aberto fecha o drawer primeiro — o clique deixa de parecer morto.',
    },
    {
      title: 'OMP RPC explica a morte',
      detail:
        'Saída com código ≠0 mostra o motivo real (ex.: sem /login) e oferece abrir o omp no terminal para autenticar.',
    },
  ],
};
