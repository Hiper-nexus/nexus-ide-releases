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
  version: '0.19.17',
  date: '2026-07-17',
  codename: 'Missão Destravada',
  summary:
    'Dois bloqueios que emperravam missões reais foram removidos: o wedge de draft de contexto órfão (que trancava o pipeline de forma invisível) agora tem escape — o erro traz o ID do bloqueador e a nova tool de supersede libera o alvo; e o teto de workers, calibrado na era do teto de token que já não existe, subiu para não sufocar missões que precisam de 3-4 braços.',
  highlights: [
    {
      title: 'Draft-fantasma se autodestrava',
      detail:
        'O propose agora revela o draft órfão que bloqueia o alvo e a tool nexus_context_draft_supersede o libera — sem o pipeline travar sem saída.',
    },
    {
      title: 'Mais workers por missão',
      detail:
        'Sensível 3 / normal 4 workers (era 2 / 3). O teto de tokens já era só telemetria; o de workers deixou de sufocar.',
    },
  ],
  fixes: [],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.16',
  date: '2026-07-17',
  codename: 'Modelo que Você Escolhe',
  summary:
    'O modelo que você seleciona no squad é o modelo que roda. A seleção podia oferecer um id que o CLI não executa (ex.: gpt-5.6 depois de a OpenAI renomear para gpt-5.6-sol/-luna/-terra) e o CLI caía silenciosamente no default. Agora o roteador e o spawn resolvem o modelo contra a lista real do CLI e nunca emitem um fantasma. Também: colar print (⌘V) nas evidências e o Operador vivo (gamificação).',
  highlights: [
    {
      title: 'Modelo fantasma nunca mais',
      detail:
        'Roteador e spawn resolvem o id escolhido para a variante real da família (gpt-5.6 → gpt-5.6-sol); vale para roster do squad, route_task e squads salvos.',
    },
    {
      title: 'Colar print nas evidências (⌘V)',
      detail:
        'Cole um screenshot direto no compositor de objetivo e ele vira anexo — sem passar pelo Finder.',
    },
    {
      title: 'Operador vivo',
      detail:
        'XP por turnos de agente e feedback visual do progresso do operador.',
    },
  ],
  fixes: [],
};

