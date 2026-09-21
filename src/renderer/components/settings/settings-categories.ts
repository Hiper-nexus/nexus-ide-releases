import type { PixelIconName } from '../PixelIcon';
import type { SettingsNavPillarId } from '../../../shared/endorphin';
import type { SettingsSection } from './settings-nav';

export interface SettingsCategory {
  id: string;
  title: string;
  description: string;
  icon: PixelIconName;
  /** Pilar da rail (Você/App/Agentes/Sistema) sob o qual a área se agrupa. */
  pillar: SettingsNavPillarId;
  sections: readonly SettingsSection[];
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: 'account', title: 'Chaves de API e Conta', description: 'Chaves (Gemini, Grok, Groq) e plano', icon: 'key', pillar: 'you', sections: ['api-keys', 'account'] },
  { id: 'personalization', title: 'Aparência e pets', description: 'Cores e seus mascotes', icon: 'grid', pillar: 'app', sections: ['appearance', 'pets'] },
  { id: 'voice', title: 'Jarvis & Voz', description: 'Assistente Jarvis, ativação e voz', icon: 'mic', pillar: 'you', sections: ['voice', 'vision'] },
  { id: 'ai', title: 'Agentes e modelos', description: 'Conexões, equipes e uso', icon: 'users', pillar: 'agents', sections: ['providers', 'squads', 'llms', 'ranking', 'usage-quota', 'jev-decisions'] },
  { id: 'media', title: 'Mídia', description: 'Conectar serviços e ver modelos', icon: 'vision', pillar: 'agents', sections: ['media', 'media-catalog'] },
  { id: 'resources', title: 'Recursos', description: 'Catálogos e referências', icon: 'sparkle', pillar: 'agents', sections: ['harness', 'agents', 'skills', 'marketplace', 'design-systems'] },
  { id: 'automation', title: 'Automações', description: 'Fluxos, extensões e regras', icon: 'board', pillar: 'agents', sections: ['recipes', 'tools', 'plugins', 'hooks', 'rules'] },
  { id: 'connections', title: 'Conexões externas', description: 'Ferramentas, servidores e celular', icon: 'split-right', pillar: 'system', sections: ['mcps', 'agent-connection', 'remote', 'companion-relay', 'connectors'] },
  { id: 'system', title: 'Sistema', description: 'Terminal, atalhos e manutenção', icon: 'config', pillar: 'system', sections: ['system', 'terminal', 'shortcuts', 'diagnostics', 'audit', 'labs'] },
];

export function settingsCategoryFor(section: SettingsSection): SettingsCategory | undefined {
  return SETTINGS_CATEGORIES.find(category => category.sections.includes(section));
}

export const SETTINGS_SECTION_SHORT_LABELS: Partial<Record<SettingsSection, string>> = {
  'api-keys': 'Chaves de API', account: 'Minha conta', voice: 'Jarvis & Voz', vision: 'Visão',
  media: 'Conexões', 'media-catalog': 'Modelos', providers: 'Contas de IA',
  llms: 'Ferramentas', ranking: 'Comparar modelos', 'usage-quota': 'Uso e cotas',
  'jev-decisions': 'Decisões Jev',
  'agent-connection': 'Agentes', mcps: 'Ferramentas', remote: 'Servidores', 'companion-relay': 'Celular',
  harness: 'Visão geral', recipes: 'Fluxos', plugins: 'Extensões', rules: 'Permissões',
};
