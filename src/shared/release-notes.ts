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
  version: '0.19.7',
  date: '2026-07-16',
  codename: 'Chaves Herdadas',
  summary:
    'O oh-my-pi nasce funcionando: as API keys que você já guardou no Nexus (GLM, Kimi/Moonshot, DeepSeek, OpenRouter…) são herdadas automaticamente pela sessão do omp — zero login extra para esses providers. Assinaturas (Claude Max, plano Codex) seguem pelo /login do próprio omp: um clique de autorização, por design dos providers.',
  highlights: [
    {
      title: 'omp com suas chaves, sem login',
      detail:
        'Salvou a key do GLM ou do Kimi no Nexus? A sessão do omp já abre com esses providers ativos — as chaves viajam do vault direto para o processo, com os nomes de env que o omp reconhece.',
    },
  ],
  fixes: [],
};

export const PREVIOUS_RELEASE: AppRelease = {
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
