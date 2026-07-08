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
  version: '0.10.26',
  date: '2026-07-08',
  codename: 'Jarvis Live Control',
  summary:
    'A Jarvis Live ganhou mais consciência de tela em tempo real, HUD mais estável no wake por clique e controle de panes mais direto.',
  highlights: [
    {
      title: 'Contexto live mais rico',
      detail:
        'A sessão realtime recebe mais panes, foco, página atual, missões e horário local para responder “onde estamos?” sem cair no fluxo batch.',
    },
    {
      title: 'Panes no caminho visual',
      detail:
        'Fechar e focar panes ficam no executor UI do renderer, evitando confirmação MCP desnecessária para ações visuais simples.',
    },
    {
      title: 'Wake por clique firme',
      detail:
        'Estados dormant do realtime não fecham mais visualmente o HUD enquanto o renderer ainda está ouvindo o comando.',
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
      title: 'Comandos de workspace mais tolerantes',
      detail:
        'Variações como “novo espaço de trabalho” e transcrições imperfeitas de workspace agora disparam o assistente sem depender do LLM.',
    },
  ],
};
