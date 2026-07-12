export type SettingsSection =
  | 'account'
  | 'appearance'
  | 'system'
  | 'terminal'
  | 'voice'
  | 'vision'
  | 'diagnostics'
  | 'audit'
  | 'media'
  | 'providers'
  | 'ranking'
  | 'squads'
  | 'marketplace'
  | 'design-systems'
  | 'remote'
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
  items: NavItem[];
}

/** Oito entradas do dia a dia — visíveis sem abrir Avançado. */
export const SETTINGS_PRIMARY_GROUPS: NavGroup[] = [
  {
    label: 'Conta',
    items: [
      {
        id: 'account',
        icon: 'ID',
        pixelIcon: 'id-badge',
        title: 'Minha conta',
        subtitle: 'plano · assinatura',
        aliases: ['account', 'billing', 'subscription'],
      },
    ],
  },
  {
    label: 'Interface',
    items: [
      {
        id: 'appearance',
        icon: 'PX',
        pixelIcon: 'grid',
        title: 'Aparência',
        subtitle: 'pixel · tema · paleta',
        aliases: ['appearance', 'theme', 'visual', 'ui'],
      },
      {
        id: 'terminal',
        icon: '>_',
        pixelIcon: 'terminal',
        title: 'Terminal',
        subtitle: 'fonte · shell',
        aliases: ['console', 'xterm'],
      },
      {
        id: 'shortcuts',
        icon: 'CMD',
        title: 'Atalhos',
        subtitle: 'teclado',
        aliases: ['shortcuts', 'hotkeys', 'keyboard'],
      },
    ],
  },
  {
    label: 'Operação',
    items: [
      {
        id: 'voice',
        icon: 'VOX',
        pixelIcon: 'mic',
        title: 'Voz',
        subtitle: 'Jarvis · captura',
        aliases: ['voice', 'realtime', 'wake', 'mic', 'microfone'],
      },
      {
        id: 'providers',
        icon: 'KEY',
        pixelIcon: 'key',
        title: 'Providers',
        subtitle: 'chaves · modelos',
        aliases: ['keys', 'models'],
      },
      {
        id: 'ranking',
        icon: 'RNK',
        title: 'Ranking LLMs',
        subtitle: 'eval · leaderboard',
        aliases: [
          'ranking',
          'leaderboard',
          'benchmark',
          'eval',
          'qualidade',
          'quality',
        ],
      },
      {
        id: 'squads',
        icon: 'SQD',
        pixelIcon: 'users',
        title: 'Squads',
        subtitle: 'orquestração',
        aliases: ['teams', 'agents'],
      },
      {
        id: 'diagnostics',
        icon: 'DIA',
        title: 'Diagnóstico',
        subtitle: 'mic · permissões',
        aliases: ['diagnostics', 'health', 'permissions'],
      },
    ],
  },
];

/** Catálogo e ops raras — progressive disclosure na nav. */
export const SETTINGS_ADVANCED_GROUPS: NavGroup[] = [
  {
    label: 'Sistema e segurança',
    items: [
      { id: 'system', icon: 'i', title: 'Sistema', subtitle: 'versão · changelog' },
      {
        id: 'vision',
        icon: 'VIS',
        pixelIcon: 'vision',
        title: 'Vision',
        subtitle: 'consent · tela',
        aliases: ['screen', 'capture', 'vision'],
      },
      {
        id: 'audit',
        icon: 'AUD',
        title: 'Auditoria',
        subtitle: 'ações · confirmações',
        aliases: ['audit', 'confirmations'],
      },
      {
        id: 'remote',
        icon: 'SSH',
        title: 'Remote',
        subtitle: 'bridge · ssh',
        aliases: ['ssh', 'remote'],
      },
    ],
  },
  {
    label: 'Integrações',
    items: [
      {
        id: 'media',
        icon: 'IMG',
        title: 'Mídia',
        subtitle: 'chaves de geração',
        aliases: ['media', 'image', 'video'],
      },
      {
        id: 'marketplace',
        icon: 'MKT',
        title: 'Marketplace',
        subtitle: 'catálogo · 1 clique',
        aliases: ['marketplace', 'catalog'],
      },
      {
        id: 'design-systems',
        icon: 'DS',
        title: 'Design Systems',
        subtitle: 'designmd.ai · DESIGN.md',
        aliases: ['design systems', 'designmd', 'design'],
      },
    ],
  },
  {
    label: 'Arsenal',
    items: [
      {
        id: 'agents',
        icon: 'AGT',
        title: 'Agents',
        subtitle: 'AI subagents',
        aliases: ['subagents'],
      },
      {
        id: 'skills',
        icon: 'SKL',
        title: 'Skills',
        subtitle: 'skills cache',
        aliases: ['skills'],
      },
      {
        id: 'llms',
        icon: 'LLM',
        title: 'CLIs · modelos',
        subtitle: 'arsenal instalado',
        aliases: ['llms', 'models'],
      },
      {
        id: 'mcps',
        icon: 'MCP',
        title: 'MCPs',
        subtitle: 'servers cache',
        aliases: ['mcp', 'servers'],
      },
      {
        id: 'tools',
        icon: 'TLS',
        title: 'Tools',
        subtitle: 'native tools',
        aliases: ['tools'],
      },
      {
        id: 'media-catalog',
        icon: 'GEN',
        title: 'Modelos',
        subtitle: 'geração · whitelist',
        aliases: ['generation', 'models'],
      },
    ],
  },
  {
    label: 'Automação',
    items: [
      {
        id: 'recipes',
        icon: 'RCP',
        title: 'Recipes',
        subtitle: 'lint · stacks',
        aliases: ['recipes'],
      },
      {
        id: 'plugins',
        icon: 'PLG',
        title: 'Plugins',
        subtitle: 'plugin bundles',
        aliases: ['plugins'],
      },
      {
        id: 'hooks',
        icon: 'HK',
        title: 'Hooks',
        subtitle: 'lifecycle scripts',
        aliases: ['hooks'],
      },
      {
        id: 'rules',
        icon: 'SEC',
        title: 'Rules',
        subtitle: 'permissions',
        aliases: ['rules', 'permissions'],
      },
    ],
  },
];

/** União para busca e testes de cobertura de seções. */
export const SETTINGS_GROUPS: NavGroup[] = [
  ...SETTINGS_PRIMARY_GROUPS,
  ...SETTINGS_ADVANCED_GROUPS,
];

const ADVANCED_SECTION_IDS = new Set(
  SETTINGS_ADVANCED_GROUPS.flatMap((g) => g.items.map((i) => i.id)),
);

export function isAdvancedSettingsSection(id: SettingsSection): boolean {
  return ADVANCED_SECTION_IDS.has(id);
}

export function isSettingsGroupExpanded(
  group: NavGroup,
  activeSection: SettingsSection,
  manuallyExpanded: ReadonlySet<string>,
): boolean {
  return (
    manuallyExpanded.has(group.label) ||
    group.items.some((item) => item.id === activeSection)
  );
}

export function toggleSettingsGroup(
  expanded: ReadonlySet<string>,
  label: string,
): Set<string> {
  const next = new Set(expanded);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  return next;
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
      label: group.label,
      items: group.items.filter(
        (item) =>
          normalize(item.title).includes(q) ||
          normalize(item.subtitle).includes(q) ||
          (item.aliases ?? []).some((alias) => normalize(alias).includes(q)),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
