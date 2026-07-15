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
  version: '0.16.5',
  date: '2026-07-15',
  codename: 'Atualização Direta',
  summary:
    'Instalações antigas saltam direto para a maior release compatível, enquanto janelas lentas, terminais e formulários permanecem estáveis durante o uso.',
  highlights: [
    {
      title: 'Uma única atualização até a versão mais nova',
      detail:
        'O Nexus consulta os releases estáveis, escolhe a maior versão semântica com ZIP da arquitetura atual e atualiza a oferta antes de baixar, mesmo quando uma versão intermediária ficou aberta na tela.',
    },
    {
      title: 'Ícone do Dock estável com o pet ativo',
      detail:
        'O companion usa skipTransformProcessType e nunca chama dock.show() no hot path. O app fixa o ícone do bundle no tile e só pede show quando o Dock está realmente oculto.',
    },
    {
      title: 'Rascunhos resistem a fechamento acidental',
      detail:
        'Objetivos e anexos de missão, chaves de voz, anotações de diff, seleção de agente e navegação de Settings voltam intactos após Escape, overlay ou uma ação da Jarvis; Cancelar e concluir continuam descartando de forma explícita.',
    },
    {
      title: 'Gate de evidências antes do handoff',
      detail:
        'Objetivos que prometem prints, capturas ou áudios em uma etapa futura ficam em awaiting_goal; a Jarvis, o wizard e o preflight final mantêm a missão sem panes e sem especialistas até os anexos chegarem.',
    },
    {
      title: 'Anexos de prints e áudio no objetivo',
      detail:
        'O wizard aceita imagens e áudios com limite por arquivo e total, salva os arquivos no workspace e injeta os caminhos no kickoff para a investigação reproduzir o problema.',
    },
    {
      title: 'Modelos fortes como padrão dos squads',
      detail:
        'Agentes Grok passam a usar grok-4.5 e agentes AGY/Gemini usam gemini-3.5-flash-high ao criar, carregar ou trocar o provider de um squad; uma escolha manual continua preservada.',
    },
    {
      title: 'Scheduler paralelo operacional',
      detail:
        'Missões aprovadas com plano selado agora distribuem tasks prontas e disjuntas em panes isolados, respeitando dependências, orçamento e o gate de ownership antes do merge.',
    },
    {
      title: 'Merge serial validado',
      detail:
        'Cada task concluída passa pela MergeQueue existente com sensores, revisão independente e finalização durável; conflitos, violações e grafos inválidos falham fechados.',
    },
    {
      title: 'MCP Across Tools',
      detail:
        'O Nexus lê configs MCP de Nexus, Cursor, Claude Code, Codex, OpenCode e Cline e mostra uma matriz de presença por server sem inventar dados ou vazar segredos.',
    },
    {
      title: 'Sync fill-gaps com freio de produção',
      detail:
        'A simulação e o sync importam lacunas com backup antes de qualquer write; a escrita continua atrás de feature flag default-off para liberar por override consciente.',
    },
    {
      title: 'Settings por pilares',
      detail:
        'Configurações agora agrupam Você, App, Agentes e Sistema, reduzindo a sensação de gaveta técnica e deixando Providers, MCPs, Tools e Squads mais encontráveis.',
    },
    {
      title: 'Cockpit com presença',
      detail:
        'Home, rail, picker e orquestração usam estados vazios narrativos e feedback de missão sem animação invasiva, respeitando modo sóbrio e reduced motion.',
    },
    {
      title: 'Contratos compartilhados menores',
      detail:
        'ProductApi, project identity e payloads de superfície foram extraídos de types.ts para arquivos focados, deixando o contrato do preload mais legível.',
    },
  ],
  fixes: [
    {
      title: 'Oferta cacheada não instala versão intermediária',
      detail:
        'O clique em baixar reconsulta o GitHub antes de escolher o asset; uma oferta 0.16.1 aberta antes da publicação de 0.16.5 passa a baixar 0.16.5 no mesmo fluxo.',
    },
    {
      title: 'Release metadata alinhada',
      detail:
        'Package, server, lockfile, changelog e release notes ficam na mesma versão 0.16.5, removendo o bloqueio que deixava a árvore de release inconsistente.',
    },
    {
      title: 'Carga lenta não entra em loop de recarregamento',
      detail:
        'O watchdog espera a navegação ativa e só reinicia uma carga realmente travada após 30 segundos, evitando ERR_ABORTED, tela piscando e falha de boot no pacote Intel.',
    },
    {
      title: 'Terminal e toolbar sem piscar',
      detail:
        'Reemissões idênticas são suprimidas e o estado visual mantém busy por uma janela curta entre pausas de output; o estado real continua imediato para guards e orquestração.',
    },
    {
      title: 'Evidência anexada não fica presa no gate',
      detail:
        'A mensagem de espera ganha prioridade quando faltam prints ou áudios, e o mesmo detector libera imediatamente o fluxo quando a interação já trouxe um anexo.',
    },
    {
      title: 'Live mudo entrega a resposta pelo Classic',
      detail:
        'Se uma transcrição de resgate já autorizada não recebe áudio nem tool-call do provider Live, o Nexus transfere o turno para cérebro e TTS Classic em vez de voltar ao usuário em silêncio.',
    },
    {
      title: 'Ownership e DAG endurecidos',
      detail:
        'Claims de diretório agora colidem com arquivos descendentes, e self-dependency, dependências desconhecidas e ciclos não podem prender uma missão indefinidamente.',
    },
    {
      title: 'Feature flag fail-closed restaurada',
      detail:
        'O MCP Hub sync havia ficado default-on durante a leva; a release corrige para default-off, preservando observe read-only sem abrir writes por padrão.',
    },
    {
      title: 'Parser de configs tolerante',
      detail:
        'Leitura de JSON/TOML grande, ausente ou inválido falha fechado e retorna estado missing/error em vez de quebrar o painel.',
    },
    {
      title: 'Writes sempre com backup',
      detail:
        'Export para ferramentas externas nunca apaga servers existentes, não cria configs ambíguas de Claude/Codex/Cline do zero e grava por caminho atômico com .bak.',
    },
    {
      title: 'Release hygiene',
      detail:
        'Versão, changelog, lockfile e release notes permanecem sincronizados, com o gate de feature flags e a suíte completa verdes.',
    },
  ],
};
