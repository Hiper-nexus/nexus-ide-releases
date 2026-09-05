import type { PixelIconName } from '../PixelIcon';
import type { SettingsSection } from './settings-nav';

export interface SettingsCategory {
  id: string;
  title: string;
  description: string;
  icon: PixelIconName;
  sections: readonly SettingsSection[];
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: 'account', title: 'Minha conta', description: 'Plano e assinatura', icon: 'id-badge', sections: ['account'] },
  { id: 'personalization', title: 'Aparência e pets', description: 'Cores e seus mascotes', icon: 'grid', sections: ['appearance', 'pets'] },
  { id: 'voice', title: 'Voz e captura', description: 'Microfone e assistente', icon: 'mic', sections: ['voice', 'vision'] },
  { id: 'ai', title: 'Agentes e modelos', description: 'Conexões, equipes e uso', icon: 'users', sections: ['providers', 'squads', 'llms', 'ranking', 'usage-quota'] },
  { id: 'media', title: 'Mídia', description: 'Conectar serviços e ver modelos', icon: 'vision', sections: ['media', 'media-catalog'] },
  { id: 'resources', title: 'Recursos', description: 'Catálogos e referências', icon: 'sparkle', sections: ['harness', 'agents', 'skills', 'marketplace', 'design-systems'] },
  { id: 'automation', title: 'Automações', description: 'Fluxos, extensões e regras', icon: 'board', sections: ['recipes', 'tools', 'plugins', 'hooks', 'rules'] },
  { id: 'connections', title: 'Conexões externas', description: 'Ferramentas, servidores e celular', icon: 'split-right', sections: ['mcps', 'agent-connection', 'remote', 'companion-relay', 'connectors'] },
  { id: 'system', title: 'Sistema', description: 'Terminal, atalhos e manutenção', icon: 'config', sections: ['system', 'terminal', 'shortcuts', 'diagnostics', 'audit', 'labs'] },
];

export function settingsCategoryFor(section: SettingsSection): SettingsCategory | undefined {
  return SETTINGS_CATEGORIES.find(category => category.sections.includes(section));
}

export const SETTINGS_SECTION_SHORT_LABELS: Partial<Record<SettingsSection, string>> = {
  media: 'Conexões', 'media-catalog': 'Modelos', providers: 'Contas de IA',
  llms: 'Ferramentas', ranking: 'Comparar modelos', 'usage-quota': 'Uso e cotas',
  'agent-connection': 'Agentes', mcps: 'Ferramentas', remote: 'Servidores', 'companion-relay': 'Celular',
  harness: 'Visão geral', recipes: 'Fluxos', plugins: 'Extensões', rules: 'Permissões',
};
