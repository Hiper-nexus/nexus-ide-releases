import { useEffect, useState } from 'react';
import type { AdapterInfo } from '../../../shared/types';
import { useOrchStore } from '../../state/orch-store';
import { useSettingsStore } from '../../state/settings-store';
import {
  VoiceSection,
  MarketplaceSection,
  SquadsSection,
  TerminalSection,
} from './ModuleSections';
import { ProvidersPanel } from './ProvidersPanel';
import { AccountSection } from './AccountSection';
import {
  AgentsSection,
  HooksSection,
  McpsSection,
  PluginsSection,
  RulesSection,
  ShortcutsSection,
  SkillsSection,
  ToolsSection,
} from './CatalogSections';

/**
 * Settings drawer — modules sidebar: MÓDULOS
 * (Terminal, Voice, Providers, Squads, Marketplace) and CATALOG
 * (Agents, Skills, MCPs, Tools, Plugins, Hooks, Rules, Atalhos).
 */

export type SettingsSection =
  | 'account'
  | 'terminal'
  | 'voice'
  | 'providers'
  | 'squads'
  | 'marketplace'
  | 'agents'
  | 'skills'
  | 'mcps'
  | 'tools'
  | 'plugins'
  | 'hooks'
  | 'rules'
  | 'shortcuts';

interface NavItem {
  id: SettingsSection;
  icon: string;
  title: string;
  subtitle: string;
}

const ACCOUNT_ITEMS: NavItem[] = [
  { id: 'account', icon: '👤', title: 'MINHA CONTA', subtitle: 'plano · assinatura' },
];

const MODULE_ITEMS: NavItem[] = [
  { id: 'terminal', icon: '>_', title: 'TERMINAL', subtitle: 'tema · fonte · shell' },
  { id: 'voice', icon: '🎙', title: 'VOICE', subtitle: 'voz · captura' },
  { id: 'providers', icon: '🔑', title: 'PROVIDERS', subtitle: 'tokens · modelos' },
  { id: 'squads', icon: '👥', title: 'SQUADS', subtitle: 'orquestração' },
  { id: 'marketplace', icon: '✦', title: 'MARKETPLACE', subtitle: 'Catálogo · 1 clique' },
];

const CATALOG_ITEMS: NavItem[] = [
  { id: 'agents', icon: '👥', title: 'AGENTS', subtitle: 'AI subagents' },
  { id: 'skills', icon: '✦', title: 'SKILLS', subtitle: 'skills cache' },
  { id: 'mcps', icon: '☁', title: 'MCPS', subtitle: 'servers cache' },
  { id: 'tools', icon: '🔧', title: 'TOOLS', subtitle: 'native tools' },
  { id: 'plugins', icon: '⬡', title: 'PLUGINS', subtitle: 'plugin bundles' },
  { id: 'hooks', icon: '⚡', title: 'HOOKS', subtitle: 'lifecycle scripts' },
  { id: 'rules', icon: '🛡', title: 'RULES', subtitle: 'permissions' },
  { id: 'shortcuts', icon: '⌘', title: 'ATALHOS', subtitle: 'teclado' },
];

function NavRow({
  item,
  active,
  badge,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  onSelect: (id: SettingsSection) => void;
}) {
  return (
    <button
      className={`settings-nav__item ${active ? 'settings-nav__item--active' : ''}`}
      onClick={() => onSelect(item.id)}
    >
      <span className="settings-nav__icon" aria-hidden>
        {item.icon}
      </span>
      <span className="settings-nav__text">
        <span className="settings-nav__title">{item.title}</span>
        <span className="settings-nav__subtitle">{item.subtitle}</span>
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="settings-nav__badge">{badge}</span>
      )}
    </button>
  );
}

export function SettingsDrawer() {
  const open = useSettingsStore((s) => s.drawerOpen);
  const close = useSettingsStore((s) => s.closeDrawer);
  const squadsCount = useOrchStore((s) => s.squads.length);
  const [section, setSection] = useState<SettingsSection>('terminal');
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.nexus.adapters.list().then((list) => {
      if (!cancelled) setAdapters(list);
    });
    const unsub = window.nexus.adapters.onChanged(setAdapters);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [open]);

  if (!open) return null;

  const badges: Partial<Record<SettingsSection, number>> = {
    providers: adapters.length,
    squads: squadsCount,
  };

  return (
    <div className="settings" role="dialog" aria-label="Configurações">
      <div className="settings__overlay" onClick={close} />
      <div className="settings__drawer">
        <nav className="settings-nav" aria-label="Módulos">
          <p className="settings-nav__section">CONTA</p>
          {ACCOUNT_ITEMS.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={section === item.id}
              onSelect={setSection}
            />
          ))}
          <p className="settings-nav__section">MÓDULOS</p>
          {MODULE_ITEMS.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={section === item.id}
              badge={badges[item.id]}
              onSelect={setSection}
            />
          ))}
          <p className="settings-nav__section">CATALOG</p>
          {CATALOG_ITEMS.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={section === item.id}
              badge={badges[item.id]}
              onSelect={setSection}
            />
          ))}
          <button className="settings-nav__close" onClick={close}>
            ✕ FECHAR
          </button>
        </nav>

        <div className="settings-detail">
          {section === 'account' && <AccountSection />}
          {section === 'terminal' && <TerminalSection />}
          {section === 'voice' && <VoiceSection onNavigate={close} />}
          {section === 'providers' && <ProvidersPanel />}
          {section === 'squads' && <SquadsSection onNavigate={close} />}
          {section === 'marketplace' && <MarketplaceSection />}
          {section === 'agents' && <AgentsSection />}
          {section === 'skills' && <SkillsSection />}
          {section === 'mcps' && <McpsSection />}
          {section === 'tools' && <ToolsSection />}
          {section === 'plugins' && <PluginsSection adapters={adapters} />}
          {section === 'hooks' && <HooksSection />}
          {section === 'rules' && <RulesSection />}
          {section === 'shortcuts' && <ShortcutsSection />}
        </div>
      </div>
    </div>
  );
}
