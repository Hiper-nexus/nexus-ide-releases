export type SettingsSection =
  | 'account'
  | 'api-keys'
  | 'appearance'
  | 'pets'
  | 'system'
  | 'terminal'
  | 'voice'
  | 'vision'
  | 'diagnostics'
  | 'audit'
  | 'labs'
  | 'media'
  | 'providers'
  | 'usage-quota'
  | 'ranking'
  | 'squads'
  | 'jev-decisions'
  | 'harness'
  | 'agent-connection'
  | 'marketplace'
  | 'design-systems'
  | 'remote'
  | 'companion-relay'
  | 'connectors'
  | 'agents'
  | 'skills'
  | 'media-catalog'
  | 'llms'
  | 'mcps'
  | 'tools'
  | 'plugins'
  | 'recipes'
  | 'hooks'
  | 'rules'
  | 'shortcuts';

import type { PixelIconName } from '../PixelIcon';
import {
  SETTINGS_NAV_PILLARS,
  settingsNavPillar,
  type SettingsNavPillar,
  type SettingsNavPillarId,
} from '../../../shared/endorphin';

export interface NavItem {
  id: SettingsSection;
  /** Badge mono de fallback (identidade), usado quando não há pixelIcon. */
  icon: string;
  /** Ícone do idioma pixel (11×11) — quando presente, vence o badge de texto. */
  pixelIcon?: PixelIconName;
  title: string;
  subtitle: string;
  aliases?: string[];
}

export interface NavGroup {
  label: string;
  /** História do pilar — kicker emocional sob o rótulo. */
  story?: string;
  pillarId?: SettingsNavPillarId;
  items: NavItem[];
}

function pillarGroup(
  pillarId: SettingsNavPillarId,
  items: NavItem[],
): NavGroup {
  const pillar = settingsNavPillar(pillarId);
  return {
    label: pillar.label,
    story: pillar.story,
    pillarId,
    items,
  };
}

/**
 * Complete destination registry for deep links and global settings search.
 * The sidebar groups these routes through settings-categories; local section
 * links expose each destination in at most two navigation choices.
 */
export const SETTINGS_GROUPS: NavGroup[] = [
  pillarGroup('you', [
    {
      id: 'account',
      icon: 'ID',
      pixelIcon: 'id-badge',
      title: 'Minha conta',
      subtitle: 'Seu plano e sua assinatura',
      aliases: ['plano · assinatura', 'account', 'billing', 'subscription', 'você', 'you'],
    },
    {
      id: 'api-keys',
      icon: 'KEY',
      pixelIcon: 'key',
      title: 'Chaves de API',
      subtitle: 'Gemini, Grok, Groq, OpenAI, Claude e outros',
      aliases: [
        'keys',
        'api key',
        'gemini',
        'grok',
        'groq',
        'openai',
        'claude',
        'elevenlabs',
        'deepseek',
        'chaves',
        'tokens',
        'credenciais',
      ],
    },
    {
      id: 'voice',
      icon: 'VOX',
      pixelIcon: 'mic',
      title: 'Jarvis & Voz',
      subtitle: 'Assistente Jarvis, conversa ao vivo e microfone',
      aliases: [
        'jarvis',
        'assistente',
        'grok voice',
        'gemini live',
        'realtime',
        'captura',
        'voice',
        'wake',
        'mic',
        'microfone',
        'ditado',
      ],
    },
  ]),
  pillarGroup('app', [
    {
      id: 'appearance',
      icon: 'PX',
      pixelIcon: 'grid',
      title: 'Aparência',
      subtitle: 'Temas, cores e aparência',
      aliases: ['pixel · tema · paleta', 'appearance', 'theme', 'visual', 'ui'],
    },
    {
      id: 'pets', icon: 'PET', pixelIcon: 'user', title: 'Meus pets',
      subtitle: 'Sua biblioteca de mascotes', aliases: ['pets', 'mascote', 'galeria', 'biblioteca'],
    },
    {
      id: 'terminal',
      icon: '>_',
      pixelIcon: 'terminal',
      title: 'Terminal',
      subtitle: 'Texto e comportamento dos terminais',
      aliases: ['fonte · shell', 'console', 'xterm'],
    },
    {
      id: 'shortcuts',
      icon: 'CMD',
      pixelIcon: 'config',
      title: 'Atalhos',
      subtitle: 'teclado',
      aliases: ['shortcuts', 'hotkeys', 'keyboard'],
    },
  ]),
  pillarGroup('agents', [
    {
      id: 'providers',
      icon: 'KEY',
      pixelIcon: 'key',
      title: 'Providers',
      subtitle: 'Contas e ferramentas de IA',
      aliases: ['login · chaves', 'keys', 'models', 'cli', 'clis', 'login', 'entrar', 'token'],
    },
    {
      id: 'usage-quota',
      icon: 'QTA',
      pixelIcon: 'bolt',
      title: 'Uso e cotas',
      subtitle: 'Limites informados por cada serviço',
      aliases: ['sessão · 5h · semanal',
        'quota',
        'usage',
        'cotas',
        'rate limit',
        'semanal',
        'analytics',
      ],
    },
    {
      id: 'ranking',
      icon: 'RNK',
      pixelIcon: 'star',
      title: 'Comparar modelos',
      subtitle: 'Comparação dos modelos disponíveis',
      aliases: ['motor · radar · missões',
        'ranking',
        'leaderboard',
        'benchmark',
        'eval',
        'qualidade',
        'quality',
        'radar',
        'roteador',
      ],
    },
    {
      id: 'squads',
      icon: 'SQD',
      pixelIcon: 'users',
      title: 'Equipes',
      subtitle: 'Integrantes para novas missões',
      aliases: ['orquestração', 'teams', 'agents', 'squads'],
    },
    {
      id: 'harness',
      icon: 'HRN',
      pixelIcon: 'board',
      title: 'Harness',
      subtitle: 'Recursos, fluxos e agentes',
      aliases: ['arsenal · recipes', 'capabilities', 'enricher', 'enriquecedor', 'receitas'],
    },
    { id: 'agent-connection', icon: 'ACP', pixelIcon: 'board', title: 'Conexão de agentes', subtitle: 'Terminal ou comunicação direta', aliases: ['acp', 'harness', 'conexão'] },
    {
      id: 'mcps',
      icon: 'MCP',
      pixelIcon: 'bolt',
      title: 'MCPs',
      subtitle: 'Conexões com ferramentas externas',
      aliases: ['servidor · status', 'mcp', 'servers', 'model context protocol'],
    },
    {
      id: 'tools',
      icon: 'TLS',
      pixelIcon: 'sparkle',
      title: 'Ferramentas',
      subtitle: 'Ações disponíveis para os agentes',
      aliases: ['nativas do MCP', 'tools', 'tooling', 'ferramentas', 'nexus_'],
    },
    {
      id: 'media',
      icon: 'IMG',
      pixelIcon: 'vision',
      title: 'Mídia',
      subtitle: 'imagem · vídeo · voz',
      aliases: ['media', 'image', 'video', 'audio', 'seedream', 'seedance'],
    },
  ]),
  {
    label: 'Agentes · catálogo',
    story: 'Agentes, instruções e modelos disponíveis',
    pillarId: 'agents',
    items: [
      {
        id: 'agents',
        icon: 'AGT',
        pixelIcon: 'agent',
        title: 'Agentes',
        subtitle: 'Agentes disponíveis no catálogo',
        aliases: ['AI subagents', 'subagents', 'agents'],
      },
      {
        id: 'skills',
        icon: 'SKL',
        pixelIcon: 'sparkle',
        title: 'Instruções',
        subtitle: 'Instruções especializadas dos agentes',
        aliases: ['skills cache', 'skills'],
      },
      {
        id: 'llms',
        icon: 'LLM',
        pixelIcon: 'terminal',
        title: 'Ferramentas de IA',
        subtitle: 'Ferramentas e modelos disponíveis',
        aliases: ['arsenal instalado', 'llms', 'models', 'cli', 'clis'],
      },
      {
        id: 'media-catalog',
        icon: 'GEN',
        pixelIcon: 'vision',
        title: 'Modelos de mídia',
        subtitle: 'Modelos de imagem, vídeo e áudio',
        aliases: ['geração · whitelist', 'generation', 'models', 'whitelist'],
      },
      {
        id: 'marketplace',
        icon: 'MKT',
        pixelIcon: 'star',
        title: 'Marketplace',
        subtitle: 'Encontrar e instalar recursos',
        aliases: ['catálogo · 1 clique', 'marketplace', 'catalog'],
      },
      {
        id: 'jev-decisions',
        icon: 'JEV',
        pixelIcon: 'star',
        title: 'Decisões do Jev',
        subtitle: 'Julgamentos do piloto automático TypeSafe',
        aliases: ['jev', 'typesafe', 'julgamentos', 'decisions', 'autopilot'],
      },
      {
        id: 'design-systems',
        icon: 'DS',
        pixelIcon: 'grid',
        title: 'Referências de design',
        subtitle: 'Referências visuais dos projetos',
        aliases: ['designmd.ai · DESIGN.md', 'design systems', 'designmd', 'design'],
      },
    ],
  },
  {
    label: 'Agentes · automação',
    story: 'Fluxos, eventos e permissões',
    pillarId: 'agents',
    items: [
      {
        id: 'recipes',
        icon: 'RCP',
        pixelIcon: 'board',
        title: 'Fluxos de trabalho',
        subtitle: 'Fluxos de trabalho reutilizáveis',
        aliases: ['lint · stacks', 'recipes'],
      },
      {
        id: 'plugins',
        icon: 'PLG',
        pixelIcon: 'plus',
        title: 'Plugins',
        subtitle: 'Extensões instaladas',
        aliases: ['plugin bundles', 'plugins'],
      },
      {
        id: 'hooks',
        icon: 'HK',
        pixelIcon: 'restart',
        title: 'Eventos',
        subtitle: 'Automações por evento',
        aliases: ['lifecycle scripts', 'hooks', 'automação'],
      },
      {
        id: 'rules',
        icon: 'SEC',
        pixelIcon: 'key',
        title: 'Regras',
        subtitle: 'Regras e permissões dos agentes',
        aliases: ['permissions', 'rules', 'permissions'],
      },
    ],
  },
  pillarGroup('system', [
    {
      id: 'diagnostics',
      icon: 'DIA',
      pixelIcon: 'warn',
      title: 'Diagnóstico',
      subtitle: 'Verificar o funcionamento do app',
      aliases: ['mic · permissões', 'diagnostics', 'health', 'permissions'],
    },
    {
      id: 'system',
      icon: 'i',
      pixelIcon: 'update',
      title: 'Sistema',
      subtitle: 'Versão e atualizações',
      aliases: ['versão · changelog'],
    },
    {
      id: 'vision',
      icon: 'VIS',
      pixelIcon: 'vision',
      title: 'Captura de tela',
      subtitle: 'Permissões de captura e análise',
      aliases: ['consent · tela', 'screen', 'capture', 'vision'],
    },
    {
      id: 'audit',
      icon: 'AUD',
      pixelIcon: 'files',
      title: 'Auditoria',
      subtitle: 'ações · confirmações',
      aliases: ['audit', 'confirmations'],
    },
    {
      id: 'labs',
      icon: 'LAB',
      pixelIcon: 'sparkle',
      title: 'Experimental',
      subtitle: 'Recursos em desenvolvimento',
      aliases: ['labs', 'flags', 'feature flags', 'experimentos'],
    },
  ]),
  // Acesso remoto ganha seção própria SEMPRE visível — era o item mais
  // enterrado da nav antiga e é porta de entrada do companion no celular.
  {
    label: 'Remoto & mobile',
    story: 'Bridge, SSH e companion no celular',
    pillarId: 'system',
    items: [
      {
        id: 'remote',
        icon: 'SSH',
        pixelIcon: 'split-right',
        title: 'Remoto',
        subtitle: 'servidores · apelido · ssh',
        aliases: ['ssh', 'remote', 'servidor', 'vps', 'apelido'],
      },
      {
        id: 'companion-relay',
        icon: 'REL',
        pixelIcon: 'split-right',
        title: 'Acesso pelo celular',
        subtitle: 'Conexão segura por QR code',
        aliases: ['companion', 'relay', 'mobile', 'celular', 'e2e', 'qr'],
      },
      {
        id: 'connectors',
        icon: 'ARM',
        pixelIcon: 'split-right',
        title: 'Conectores',
        subtitle: 'arms · grok bot · cursor',
        aliases: ['arms', 'connector', 'conector', 'grok bot', 'cursor', 'externo'],
      },
    ],
  },
];

/** YOU · APP · AGENTS · SYSTEM — pilares emocionais da nav (endorphin). */
const SETTINGS_SECTION_PILLAR: Record<SettingsSection, SettingsNavPillarId> = {
  account: 'you',
  'api-keys': 'you',
  voice: 'you',
  appearance: 'app',
  pets: 'app',
  terminal: 'app',
  shortcuts: 'app',
  providers: 'agents',
  'usage-quota': 'agents',
  ranking: 'agents',
  squads: 'agents',
  'jev-decisions': 'agents',
  harness: 'agents',
  'agent-connection': 'agents',
  mcps: 'agents',
  tools: 'agents',
  media: 'agents',
  marketplace: 'agents',
  'design-systems': 'agents',
  agents: 'agents',
  skills: 'agents',
  'media-catalog': 'agents',
  llms: 'agents',
  plugins: 'agents',
  recipes: 'agents',
  hooks: 'agents',
  rules: 'agents',
  diagnostics: 'system',
  system: 'system',
  vision: 'system',
  audit: 'system',
  remote: 'system',
  'companion-relay': 'system',
  connectors: 'system',
  labs: 'system',
};

export function settingsSectionPillar(
  section: SettingsSection,
): SettingsNavPillar {
  return settingsNavPillar(SETTINGS_SECTION_PILLAR[section]);
}

/** Ordem canônica dos pilares na nav (espelha SETTINGS_NAV_PILLARS). */
export function settingsPrimaryPillarOrder(): readonly SettingsNavPillarId[] {
  return SETTINGS_NAV_PILLARS.map((p) => p.id);
}

/** Normaliza para busca: minúsculas e sem diacríticos. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * Filtra os grupos por título/subtítulo (case- e diacritic-insensitive),
 * descartando grupos que ficam sem itens. Query vazia devolve tudo intacto.
 */
export function filterSettingsGroups(groups: NavGroup[], query: string): NavGroup[] {
  const q = normalize(query.trim());
  if (!q) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          normalize(item.title).includes(q) ||
          normalize(item.subtitle).includes(q) ||
          normalize(group.label).includes(q) ||
          (group.story ? normalize(group.story).includes(q) : false) ||
          (item.aliases ?? []).some((alias) => normalize(alias).includes(q)),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
