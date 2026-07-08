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
  version: '0.10.25',
  date: '2026-07-08',
  codename: 'Jarvis Live Context',
  summary:
    'A Jarvis Live ganhou mais consciência de tela em tempo real, com perguntas de contexto respondidas direto pelo áudio realtime e comandos ainda passando pelo executor auditado.',
  highlights: [
    {
      title: 'Contexto live mais rico',
      detail:
        'A sessão realtime recebe mais panes, foco, página atual, missões e horário local para responder “onde estamos?” sem cair no fluxo batch.',
    },
    {
      title: 'Operação continua auditada',
      detail:
        'Ações como abrir terminal, rodar comando, focar pane e delegar trabalho seguem pelo mesmo executor Jarvis/MCP com confirmação de risco.',
    },
    {
      title: 'Prompts live em inglês',
      detail:
        'O prompt realtime orienta leitura de tela, pane, página, workspace e horário direto do contexto do Nexus.',
    },
  ],
  fixes: [
    {
      title: 'Menos latência em perguntas de tela',
      detail:
        'Perguntas de leitura do estado atual não são mais forçadas para o caminho Classic quando o realtime está pronto.',
    },
    {
      title: 'Contexto sem corte prematuro',
      detail:
        'O limite de contexto realtime foi ampliado para preservar mais informação útil antes do envio ao provedor live.',
    },
    {
      title: 'Fechar das configurações',
      detail:
        'O botão Fechar do menu de configurações ganhou área própria e não fica visualmente sobre os itens do catálogo.',
    },
  ],
};
