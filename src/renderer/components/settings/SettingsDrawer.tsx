import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../../shared/types';
import { useOrchStore } from '../../state/orch-store';
import { useSettingsStore } from '../../state/settings-store';
import {
  SETTINGS_GROUPS,
  SETTINGS_PRIMARY_GROUPS,
  SETTINGS_ADVANCED_GROUPS,
  filterSettingsGroups,
  isAdvancedSettingsSection,
  type NavItem,
  type SettingsSection,
} from './settings-nav';
import {
  VoiceSection,
  MarketplaceSection,
  SquadsSection,
  SystemSection,
  TerminalSection,
} from './ModuleSections';
import { ProvidersPanel } from './ProvidersPanel';
import { PixelIcon } from '../PixelIcon';
import { AccountSection } from './AccountSection';
import { AppearanceSection } from './AppearanceSection';
import { MediaSection } from './MediaSection';
import {
  AuditSection,
  DiagnosticsSection,
  VisionSection,
} from './ObservabilitySections';
import {
  AgentsSection,
  HooksSection,
  LlmsSection,
  McpsSection,
  MediaCatalogSection,
  PluginsSection,
  RecipesSection,
  RemoteSection,
  RulesSection,
  ShortcutsSection,
  SkillsSection,
  ToolsSection,
} from './CatalogSections';

/**
 * Settings drawer — nav agrupada por intenção (CONTA · OPERAÇÃO · ARSENAL ·
 * CATÁLOGO) com busca no topo. Grupos e filtro em settings-nav.ts (testados).
 */

export type { SettingsSection };

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
      type="button"
      className={`settings-nav__item ${active ? 'settings-nav__item--active' : ''}`}
      onClick={() => onSelect(item.id)}
      aria-current={active ? 'page' : undefined}
    >
      <span className="settings-nav__icon" aria-hidden>
        {item.pixelIcon ? <PixelIcon name={item.pixelIcon} size={14} /> : item.icon}
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
  const [section, setSection] = useState<SettingsSection>('account');
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [query, setQuery] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const searching = query.trim().length > 0;
  const groups = useMemo(
    () => filterSettingsGroups(SETTINGS_GROUPS, query),
    [query],
  );
  const primaryGroups = useMemo(
    () => filterSettingsGroups(SETTINGS_PRIMARY_GROUPS, query),
    [query],
  );
  const advancedGroups = useMemo(
    () => filterSettingsGroups(SETTINGS_ADVANCED_GROUPS, query),
    [query],
  );

  useEffect(() => {
    if (isAdvancedSettingsSection(section)) setAdvancedOpen(true);
  }, [section]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

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
          <div className="settings-nav__brand" aria-label="Nexus Config">
            <span className="settings-nav__brand-mark" aria-hidden>
              NX
            </span>
            <span className="settings-nav__brand-copy">
              <span className="settings-nav__brand-title">Nexus config</span>
              <span className="settings-nav__brand-subtitle">mission control</span>
            </span>
            <span className="settings-nav__brand-signal" aria-hidden />
          </div>
          <div className="settings-nav__search">
            <span className="settings-nav__search-icon" aria-hidden>
              ⌕
            </span>
            <input
              className="settings-nav__search-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar configurações…"
              aria-label="Buscar nas configurações"
            />
          </div>
          {searching ? (
            groups.length === 0 ? (
              <p className="settings-nav__no-match">Nada encontrado para “{query}”.</p>
            ) : (
              groups.map((group) => (
                <div key={group.label}>
                  <p className="settings-nav__section">{group.label}</p>
                  {group.items.map((item) => (
                    <NavRow
                      key={item.id}
                      item={item}
                      active={section === item.id}
                      badge={badges[item.id]}
                      onSelect={setSection}
                    />
                  ))}
                </div>
              ))
            )
          ) : (
            <>
              {primaryGroups.map((group) => (
                <div key={group.label}>
                  <p className="settings-nav__section">{group.label}</p>
                  {group.items.map((item) => (
                    <NavRow
                      key={item.id}
                      item={item}
                      active={section === item.id}
                      badge={badges[item.id]}
                      onSelect={setSection}
                    />
                  ))}
                </div>
              ))}
              <button
                type="button"
                className={`settings-nav__advanced ${advancedOpen ? 'settings-nav__advanced--open' : ''}`}
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-expanded={advancedOpen}
              >
                <span className="settings-nav__advanced-label">Avançado</span>
                <span className="settings-nav__advanced-hint">catálogo · sistema</span>
                <PixelIcon name="chevron-down" size={12} />
              </button>
              {advancedOpen &&
                advancedGroups.map((group) => (
                  <div key={group.label} className="settings-nav__advanced-block">
                    <p className="settings-nav__section">{group.label}</p>
                    {group.items.map((item) => (
                      <NavRow
                        key={item.id}
                        item={item}
                        active={section === item.id}
                        badge={badges[item.id]}
                        onSelect={setSection}
                      />
                    ))}
                  </div>
                ))}
            </>
          )}
          <button type="button" className="settings-nav__close" onClick={close}>
            Fechar
          </button>
        </nav>

        <div className="settings-detail">
          {section === 'account' && <AccountSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'system' && <SystemSection />}
          {section === 'terminal' && <TerminalSection />}
          {section === 'voice' && <VoiceSection onNavigate={close} />}
          {section === 'vision' && <VisionSection />}
          {section === 'diagnostics' && <DiagnosticsSection />}
          {section === 'audit' && <AuditSection />}
          {section === 'media' && <MediaSection />}
          {section === 'providers' && <ProvidersPanel />}
          {section === 'squads' && <SquadsSection onNavigate={close} />}
          {section === 'marketplace' && <MarketplaceSection />}
          {section === 'remote' && <RemoteSection />}
          {section === 'agents' && <AgentsSection />}
          {section === 'skills' && <SkillsSection />}
          {section === 'media-catalog' && <MediaCatalogSection />}
          {section === 'llms' && <LlmsSection adapters={adapters} />}
          {section === 'mcps' && <McpsSection />}
          {section === 'tools' && <ToolsSection />}
          {section === 'recipes' && <RecipesSection />}
          {section === 'plugins' && <PluginsSection adapters={adapters} />}
          {section === 'hooks' && <HooksSection />}
          {section === 'rules' && <RulesSection />}
          {section === 'shortcuts' && <ShortcutsSection />}
        </div>
      </div>
    </div>
  );
}
