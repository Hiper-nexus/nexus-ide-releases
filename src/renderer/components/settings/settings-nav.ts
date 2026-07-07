export type SettingsSection =
  | 'account'
  | 'system'
  | 'terminal'
  | 'voice'
  | 'media'
  | 'providers'
  | 'squads'
  | 'marketplace'
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
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Nav do Settings agrupada por INTENÇÃO — conta / operação diária / arsenal de
 * execução / catálogo instalado — em vez de 20 linhas num nível só. Onde o
 * idioma pixel já tem ícone (ID/>_ /VOX/KEY…) usamos PixelIcon; os demais
 * badges mono (SQD/MKT/LLM…) seguem como texto até ganharem ícone próprio.
 * Duplicata "MÍDIA" e sobreposição PROVIDERS↔CLIS resolvidas por rótulo,
 * sem apagar tela.
 */
export const SETTINGS_GROUPS: NavGroup[] = [
  {
    label: 'CONTA',
    items: [
      { id: 'account', icon: 'ID', pixelIcon: 'id-badge', title: 'MINHA CONTA', subtitle: 'plano · assinatura' },
      { id: 'system', icon: 'i', title: 'SISTEMA', subtitle: 'versão · changelog' },
    ],
  },
  {
    label: 'OPERAÇÃO',
    items: [
      { id: 'terminal', icon: '>_', pixelIcon: 'terminal', title: 'TERMINAL', subtitle: 'tema · fonte · shell' },
      { id: 'voice', icon: 'VOX', pixelIcon: 'mic', title: 'VOICE', subtitle: 'voz · captura · Jarvis' },
      { id: 'media', icon: 'IMG', title: 'MÍDIA', subtitle: 'chaves de geração' },
      { id: 'shortcuts', icon: 'CMD', title: 'ATALHOS', subtitle: 'teclado' },
    ],
  },
  {
    label: 'ARSENAL',
    items: [
      { id: 'providers', icon: 'KEY', pixelIcon: 'key', title: 'PROVIDERS', subtitle: 'chaves · modelos · rota' },
      { id: 'squads', icon: 'SQD', pixelIcon: 'users', title: 'SQUADS', subtitle: 'orquestração' },
      { id: 'remote', icon: 'SSH', title: 'REMOTE', subtitle: 'bridge · ssh' },
      { id: 'marketplace', icon: 'MKT', title: 'MARKETPLACE', subtitle: 'catálogo · 1 clique' },
    ],
  },
  {
    label: 'CATÁLOGO',
    items: [
      { id: 'agents', icon: 'AGT', title: 'AGENTS', subtitle: 'AI subagents' },
      { id: 'skills', icon: 'SKL', title: 'SKILLS', subtitle: 'skills cache' },
      { id: 'llms', icon: 'LLM', title: 'CLIS · MODELOS', subtitle: 'arsenal instalado' },
      { id: 'mcps', icon: 'MCP', title: 'MCPS', subtitle: 'servers cache' },
      { id: 'tools', icon: 'TLS', title: 'TOOLS', subtitle: 'native tools' },
      { id: 'media-catalog', icon: 'GEN', title: 'MODELOS', subtitle: 'geração · whitelist' },
      { id: 'recipes', icon: 'RCP', title: 'RECIPES', subtitle: 'lint · stacks' },
      { id: 'plugins', icon: 'PLG', title: 'PLUGINS', subtitle: 'plugin bundles' },
      { id: 'hooks', icon: 'HK', title: 'HOOKS', subtitle: 'lifecycle scripts' },
      { id: 'rules', icon: 'SEC', title: 'RULES', subtitle: 'permissions' },
    ],
  },
];

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
          normalize(item.title).includes(q) || normalize(item.subtitle).includes(q),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
