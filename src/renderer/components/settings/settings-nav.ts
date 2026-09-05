export type SettingsSection =
  | 'account'
  | 'appearance'
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
  | 'harness'
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
 * Nav PLANA — todas as seções sempre visíveis, agrupadas por cabeçalho, sem
 * colapso aninhado. O modelo anterior ("Mais configurações" → grupos
 * colapsáveis → item) enterrava seções críticas em três cliques (achado de
 * operador: "para chegar no acesso remoto do celular tem que garimpar").
 * Uma lista rolável com cabeçalhos de seção + busca é o padrão dos settings
 * que o usuário já conhece (VS Code, BridgeMind).
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
      id: 'voice',
      icon: 'VOX',
      pixelIcon: 'mic',
      title: 'Voz',
      subtitle: 'Microfone, ditado e assistente',
      aliases: ['Jarvis · captura', 'voice', 'realtime', 'wake', 'mic', 'microfone'],
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
      title: 'Ranking LLMs',
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
      title: 'Squads',
      subtitle: 'Integrantes para novas missões',
      aliases: ['orquestração', 'teams', 'agents'],
    },
    {
      id: 'harness',
      icon: 'HRN',
      pixelIcon: 'board',
      title: 'Harness',
      subtitle: 'Recursos, fluxos e agentes',
      aliases: ['arsenal · recipes', 'capabilities', 'enricher', 'enriquecedor', 'receitas'],
    },
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
      title: 'Tools',
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
    story: 'Subagents, skills, modelos e marketplace',
    pillarId: 'agents',
    items: [
      {
        id: 'agents',
        icon: 'AGT',
        pixelIcon: 'agent',
        title: 'Agents',
        subtitle: 'Agentes disponíveis no catálogo',
        aliases: ['AI subagents', 'subagents'],
      },
      {
        id: 'skills',
        icon: 'SKL',
        pixelIcon: 'sparkle',
        title: 'Skills',
        subtitle: 'Instruções especializadas dos agentes',
        aliases: ['skills cache', 'skills'],
      },
      {
        id: 'llms',
        icon: 'LLM',
        pixelIcon: 'terminal',
        title: 'CLIs · modelos',
        subtitle: 'Ferramentas e modelos disponíveis',
        aliases: ['arsenal instalado', 'llms', 'models'],
      },
      {
        id: 'media-catalog',
        icon: 'GEN',
        pixelIcon: 'vision',
        title: 'Modelos',
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
        id: 'design-systems',
        icon: 'DS',
        pixelIcon: 'grid',
        title: 'Design Systems',
        subtitle: 'Referências visuais dos projetos',
        aliases: ['designmd.ai · DESIGN.md', 'design systems', 'designmd', 'design'],
      },
    ],
  },
  {
    label: 'Agentes · automação',
    story: 'Recipes, hooks e permissões',
    pillarId: 'agents',
    items: [
      {
        id: 'recipes',
        icon: 'RCP',
        pixelIcon: 'board',
        title: 'Recipes',
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
        title: 'Hooks',
        subtitle: 'Automações por evento',
        aliases: ['lifecycle scripts', 'hooks'],
      },
      {
        id: 'rules',
        icon: 'SEC',
        pixelIcon: 'key',
        title: 'Rules',
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
      title: 'Vision',
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
      title: 'Labs',
      subtitle: 'feature flags',
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
        title: 'Companion mobile',
        subtitle: 'relay E2E · QR',
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
  voice: 'you',
  appearance: 'app',
  terminal: 'app',
  shortcuts: 'app',
  providers: 'agents',
  'usage-quota': 'agents',
  ranking: 'agents',
  squads: 'agents',
  harness: 'agents',
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
