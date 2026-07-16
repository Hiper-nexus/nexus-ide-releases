import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdapterInfo } from '../../../shared/types';
import { useOrchStore } from '../../state/orch-store';
import { useSettingsStore } from '../../state/settings-store';
import {
  peekEphemeralDraft,
  saveEphemeralDraft,
} from '../../state/ephemeral-draft-store';
import { createDraftHydrationBarrier } from '../../lib/ui-overlay-policy';
import {
  SETTINGS_GROUPS,
  SETTINGS_PRIMARY_GROUPS,
  SETTINGS_ADVANCED_GROUPS,
  filterSettingsGroups,
  isAdvancedSettingsSection,
  isSettingsGroupExpanded,
  toggleSettingsGroup,
  settingsSectionPillar,
  type NavItem,
  type NavGroup,
  type SettingsSection,
} from './settings-nav';
import {
  resolveOpenDrawerSection,
  SETTINGS_DRAWER_DEFAULT_SECTION,
} from './settings-drawer-section';
import {
  VoiceSection,
  MarketplaceSection,
  SquadsSection,
  SystemSection,
  TerminalSection,
} from './ModuleSections';
import { ProvidersPanel } from './ProvidersPanel';
import { UsageQuotaSection } from './UsageQuotaSection';
import { ModelRankingSection } from './ModelRankingSection';
import { PixelIcon } from '../PixelIcon';
import { OperatorHud } from '../OperatorHud';
import { AccountSection } from './AccountSection';
import { trapDialogTabKey } from './settings-dialog-focus';
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
import { DesignSystemsSection } from './DesignSystemsSection';
import { HarnessSection } from './HarnessSection';
import { CrossoverFlagsSection } from './CrossoverFlagsSection';
import { CompanionRelaySection } from './CompanionRelaySection';

/**
 * Settings drawer — nav emocional Você · App · Agentes · Sistema (pilares
 * endorphin) com busca no topo. Grupos e filtro em settings-nav.ts (testados).
 */

function NavGroupHeading({ group }: { group: NavGroup }) {
  return (
    <div className="settings-nav__section-head">
      <p className="settings-nav__section">{group.label}</p>
      {group.story ? (
        <p className="settings-nav__section-story">{group.story}</p>
      ) : null}
    </div>
  );
}

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

function AdvancedGroupNav({
  group,
  activeSection,
  expanded,
  badges,
  onToggle,
  onSelect,
}: {
  group: NavGroup;
  activeSection: SettingsSection;
  expanded: boolean;
  badges: Partial<Record<SettingsSection, number>>;
  onToggle: (label: string) => void;
  onSelect: (id: SettingsSection) => void;
}) {
  const groupId = `settings-group-${group.label
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\W+/g, '-')
    .toLowerCase()}`;
  return (
    <div className="settings-nav__advanced-block">
      <button
        type="button"
        className="settings-nav__group-toggle"
        onClick={() => onToggle(group.label)}
        aria-expanded={expanded}
        aria-controls={groupId}
      >
        <span className="settings-nav__group-toggle-copy">
          <span>{group.label}</span>
          {group.story ? (
            <span className="settings-nav__section-story">{group.story}</span>
          ) : null}
        </span>
        <span className="settings-nav__group-count">{group.items.length}</span>
        <PixelIcon name="chevron-down" size={11} />
      </button>
      {expanded && (
        <div id={groupId} className="settings-nav__group-items">
          {group.items.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={activeSection === item.id}
              badge={badges[item.id]}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsDrawer() {
  const draftHydrationBarrier = useRef(createDraftHydrationBarrier()).current;
  const open = useSettingsStore((s) => s.drawerOpen);
  const requestedSection = useSettingsStore((s) => s.drawerSection);
  const close = useSettingsStore((s) => s.closeDrawer);
  const squadsCount = useOrchStore((s) => s.squads.length);
  const mcpToolCount = useOrchStore((s) => s.mcpInfo?.toolCount ?? 0);
  const [section, setSection] = useState<SettingsSection>(
    SETTINGS_DRAWER_DEFAULT_SECTION,
  );
  /** Manual nav keeps store target in sync so openDrawer/close stay coherent. */
  const selectSection = (id: SettingsSection) => {
    setSection(id);
    useSettingsStore.setState({ drawerSection: id });
  };
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [query, setQuery] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expandedAdvancedGroups, setExpandedAdvancedGroups] = useState<
    Set<string>
  >(() => new Set());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
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

  // Section target can change while open (openDrawer('providers') / nav).
  useEffect(() => {
    if (!open) return;
    setSection(resolveOpenDrawerSection(requestedSection));
  }, [open, requestedSection]);

  // Restore search only on open edge — not on every section change (that
  // wiped in-progress query when the user navigated mid-type).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    draftHydrationBarrier.markHydrating();
    const nav = peekEphemeralDraft<{ query: string; advancedOpen: boolean }>(
      'settings-nav',
    );
    if (nav) {
      setQuery(nav.query);
      setAdvancedOpen(nav.advancedOpen);
    }
  }, [open, draftHydrationBarrier]);

  useEffect(() => {
    if (!open) return;
    if (draftHydrationBarrier.shouldSkipPersist()) return;
    saveEphemeralDraft('settings-nav', { query, advancedOpen });
  }, [open, query, advancedOpen, draftHydrationBarrier]);

  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      (searchRef.current ?? dialogRef.current)?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (
        event.key === 'Tab' &&
        dialogRef.current &&
        trapDialogTabKey(dialogRef.current, event.shiftKey)
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKey);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
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
    tools: mcpToolCount > 0 ? mcpToolCount : undefined,
    mcps: mcpToolCount > 0 ? 1 : undefined,
  };
  const toggleAdvancedGroup = (label: string) => {
    setExpandedAdvancedGroups((expanded) =>
      toggleSettingsGroup(expanded, label),
    );
  };
  const currentSectionTitle = SETTINGS_GROUPS
    .flatMap((group) => group.items)
    .find((item) => item.id === section)?.title;
  const activePillar = settingsSectionPillar(section);

  return (
    <div
      ref={dialogRef}
      className="settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      tabIndex={-1}
    >
      <div className="settings__overlay" onClick={close} aria-hidden="true" />
      <div className="settings__drawer">
        <h2 id="settings-dialog-title" className="settings-visually-hidden">
          Configurações do Nexus
        </h2>
        <nav className="settings-nav" aria-label="Configurações">
          <div className="settings-nav__body">
            <div className="settings-nav__brand" aria-label="Nexus Config">
              <span className="settings-nav__brand-mark" aria-hidden>
                NX
              </span>
              <span className="settings-nav__brand-copy">
                <span className="settings-nav__brand-kicker">{activePillar.label}</span>
                <span className="settings-nav__brand-title">Nexus config</span>
                <span className="settings-nav__brand-subtitle">
                  {activePillar.story}
                </span>
              </span>
              <span className="settings-nav__brand-signal" aria-hidden />
            </div>
            <div className="settings-nav__search">
              <span className="settings-nav__search-icon" aria-hidden>
                <PixelIcon name="search" size={12} />
              </span>
              <input
                ref={searchRef}
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
                    <NavGroupHeading group={group} />
                    {group.items.map((item) => (
                      <NavRow
                        key={item.id}
                        item={item}
                        active={section === item.id}
                        badge={badges[item.id]}
                        onSelect={selectSection}
                      />
                    ))}
                  </div>
                ))
              )
            ) : (
              <>
                {primaryGroups.map((group) => (
                  <div key={group.label}>
                    <NavGroupHeading group={group} />
                    {group.items.map((item) => (
                      <NavRow
                        key={item.id}
                        item={item}
                        active={section === item.id}
                        badge={badges[item.id]}
                        onSelect={selectSection}
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
                  <span className="settings-nav__advanced-label">
                    Mais configurações
                  </span>
                  <span className="settings-nav__advanced-hint">
                    sistema · catálogo · automação
                  </span>
                  <PixelIcon name="chevron-down" size={12} />
                </button>
                {advancedOpen && (
                  <div className="settings-nav__advanced-groups">
                    {advancedGroups.map((group) => (
                      <AdvancedGroupNav
                        key={group.label}
                        group={group}
                        activeSection={section}
                        expanded={isSettingsGroupExpanded(
                          group,
                          section,
                          expandedAdvancedGroups,
                        )}
                        badges={badges}
                        onToggle={toggleAdvancedGroup}
                        onSelect={selectSection}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="settings-nav__footer">
            {/* Pet + gamificação sempre visíveis em Config — mesmo padrão do
                rodapé da rail de missões; o overlay não pode esconder o companion. */}
            <div className="settings-nav__operator">
              <OperatorHud compact />
            </div>
            <button type="button" className="settings-nav__close" onClick={close}>
              Fechar configurações
            </button>
          </div>
        </nav>

        <div className="settings-detail">
          <header className="settings-detail__nav">
            <div className="settings-detail__location" aria-live="polite">
              <span>Configurações</span>
              <PixelIcon name="chevron" size={9} />
              <strong>{currentSectionTitle ?? 'Nexus'}</strong>
            </div>
            <button
              type="button"
              className="settings-detail__return"
              onClick={close}
              aria-label="Fechar configurações e voltar às missões"
            >
              <PixelIcon name="close" size={10} />
              <span>Voltar às missões</span>
              <kbd>Esc</kbd>
            </button>
          </header>
          <div className="settings-detail__content">
          {section === 'account' && <AccountSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'system' && <SystemSection />}
          {section === 'terminal' && <TerminalSection />}
          {section === 'voice' && <VoiceSection onNavigate={close} />}
          {section === 'vision' && <VisionSection />}
          {section === 'diagnostics' && (
            <>
              <DiagnosticsSection />
              <CrossoverFlagsSection />
            </>
          )}
          {section === 'audit' && <AuditSection />}
          {section === 'media' && <MediaSection />}
          {section === 'providers' && <ProvidersPanel />}
          {section === 'usage-quota' && <UsageQuotaSection />}
          {section === 'ranking' && <ModelRankingSection />}
          {section === 'squads' && <SquadsSection onNavigate={close} />}
          {section === 'harness' && <HarnessSection />}
          {section === 'marketplace' && <MarketplaceSection />}
          {section === 'design-systems' && <DesignSystemsSection />}
          {section === 'remote' && <RemoteSection />}
          {section === 'companion-relay' && <CompanionRelaySection />}
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
    </div>
  );
}
