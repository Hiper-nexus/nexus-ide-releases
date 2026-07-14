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
  version: '0.15.17',
  date: '2026-07-14',
  codename: 'Across Tools e Cockpit Vivo',
  summary:
    'MCP Across Tools observa a frota local de CLIs, a sincronização nasce fail-closed, Settings ganha pilares mais claros e o cockpit passa a responder com estados narrativos e feedback visual leve.',
  highlights: [
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
        'Versão, changelog, lockfile e release notes ficam sincronizados em 0.15.17, com o gate de feature flags e a suíte completa verdes.',
    },
  ],
};
