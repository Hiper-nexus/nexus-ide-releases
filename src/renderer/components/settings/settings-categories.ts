import type { PixelIconName } from '../PixelIcon';
import type { SettingsNavPillarId } from '../../../shared/endorphin';
import type { SettingsSection } from './settings-nav';

export interface SettingsCategory {
  id: string;
  title: string;
  description: string;
  icon: PixelIconName;
  pillar: SettingsNavPillarId;
  sections: readonly SettingsSection[];
  /**
   * Abas técnicas, recolhidas atrás do rótulo "Avançado" no fim da categoria.
   * Continuam alcançáveis (e pela busca); só saem do caminho de quem não opera
   * agentes no detalhe. Sempre um subconjunto de `sections`, sempre no fim.
   */
  advanced?: readonly SettingsSection[];
}

/**
 * Organização por TAREFA, não por módulo do código (crítica de 22/09: nove
 * categorias sob quatro pilares, "Ferramentas" em três lugares, chaves em
 * quatro). Cada categoria responde "o que vim fazer aqui?"; cada aba tem um
 * nome único, igual na aba, no caminho e no título da página.
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: 'account', title: 'Conta e acesso a IAs', description: 'Plano, contas de IA, chaves e gastos', icon: 'key', pillar: 'you', sections: ['account', 'providers', 'api-keys', 'usage-quota'] },
  { id: 'voice', title: 'Jarvis e voz', description: 'Assistente, microfone e captura de tela', icon: 'mic', pillar: 'you', sections: ['voice', 'vision'] },
  { id: 'personalization', title: 'Aparência e teclado', description: 'Tema, mascotes, terminal e atalhos', icon: 'grid', pillar: 'app', sections: ['appearance', 'pets', 'terminal', 'shortcuts'] },
  { id: 'ai', title: 'Equipes e modelos', description: 'Quem trabalha e com qual modelo', icon: 'users', pillar: 'agents', sections: ['squads', 'llms', 'ranking', 'media', 'media-catalog', 'agent-connection'], advanced: ['agent-connection'] },
  { id: 'library', title: 'Biblioteca', description: 'Capacidades prontas para instalar', icon: 'sparkle', pillar: 'agents', sections: ['harness', 'agents', 'skills', 'marketplace', 'recipes', 'design-systems'], advanced: ['design-systems'] },
  { id: 'connections', title: 'Integrações', description: 'Outros apps, máquinas e celular', icon: 'split-right', pillar: 'system', sections: ['mcps', 'connectors', 'plugins', 'remote', 'companion-relay', 'tools'], advanced: ['tools'] },
  { id: 'system', title: 'Segurança e manutenção', description: 'Atualizações, diagnóstico e permissões', icon: 'config', pillar: 'system', sections: ['system', 'diagnostics', 'rules', 'audit', 'jev-decisions', 'hooks', 'labs'], advanced: ['jev-decisions', 'hooks', 'labs'] },
];

export function settingsCategoryFor(section: SettingsSection): SettingsCategory | undefined {
  return SETTINGS_CATEGORIES.find(category => category.sections.includes(section));
}
