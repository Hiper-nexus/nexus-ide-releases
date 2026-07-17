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
  version: '0.19.18',
  date: '2026-07-17',
  codename: 'Deixa de Travar',
  summary:
    'Auditoria completa das causas de freeze. "Toda hora um limite diferente" tinha raiz numa pilha de gates onde quase tudo exigia contrato congelado. Dois desgates seguros: documentar/planejar (todo_manager, clarify) não exigem mais freeze, e sensores typecheck/unit ausentes viram aviso em vez de bloquear. A integridade de mutação de código fica intacta.',
  highlights: [
    {
      title: 'Documentar e planejar sem trava',
      detail:
        'Gerenciar tarefas e perguntar ao usuário vêm antes de congelar contexto — não exigem mais contrato PREVC congelado.',
    },
    {
      title: 'Sensores recomendados, não obrigatórios',
      detail:
        'Faltar typecheck/unit vira aviso; o freeze passa e os sensores existentes seguem rodando no PREVC.',
    },
  ],
  fixes: [],
};

export const PREVIOUS_RELEASE: AppRelease = {
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

