import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { AdapterInfo } from '../../../shared/types';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import {
  peekEphemeralDraft,
  saveEphemeralDraft,
} from '../../state/ephemeral-draft-store';
import {
  SETTINGS_GROUPS,
  filterSettingsGroups,
  settingsSectionPillar,
  type NavGroup,
  type NavItem,
  type SettingsSection,
} from './settings-nav';
import { resolveOpenDrawerSection } from './settings-drawer-section';
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
import { CompanionRelaySection } from './CompanionRelaySection';
import { LabsSection } from './LabsSection';
import {
  SettingsSectionTitleProvider,
  type SettingsSectionTitleLevel,
} from './SettingsSectionTitle';

const SETTINGS_ITEMS = SETTINGS_GROUPS.flatMap((group) => group.items);

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
      {badge !== undefined && badge > 0 ? (
        <span className="settings-nav__badge">{badge}</span>
      ) : null}
    </button>
  );
}

function SettingsSectionContent({
  section,
  adapters,
  onNavigateAway,
}: {
  section: SettingsSection;
  adapters: AdapterInfo[];
  onNavigateAway: () => void;
}) {
  switch (section) {
    case 'account':
      return <AccountSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'system':
      return <SystemSection />;
    case 'terminal':
      return <TerminalSection />;
    case 'voice':
      return <VoiceSection onNavigate={onNavigateAway} />;
    case 'vision':
      return <VisionSection />;
    case 'diagnostics':
      return <DiagnosticsSection />;
    case 'audit':
      return <AuditSection />;
    case 'media':
      return <MediaSection />;
    case 'providers':
      return <ProvidersPanel />;
    case 'usage-quota':
      return <UsageQuotaSection />;
    case 'ranking':
      return <ModelRankingSection />;
    case 'squads':
      return <SquadsSection onNavigate={onNavigateAway} />;
    case 'harness':
      return <HarnessSection />;
    case 'marketplace':
      return <MarketplaceSection />;
    case 'design-systems':
      return <DesignSystemsSection />;
    case 'remote':
      return <RemoteSection />;
    case 'companion-relay':
      return <CompanionRelaySection />;
    case 'labs':
      return <LabsSection />;
    case 'agents':
      return <AgentsSection />;
    case 'skills':
      return <SkillsSection />;
    case 'media-catalog':
      return <MediaCatalogSection />;
    case 'llms':
      return <LlmsSection adapters={adapters} />;
    case 'mcps':
      return <McpsSection />;
    case 'tools':
      return <ToolsSection />;
    case 'recipes':
      return <RecipesSection />;
    case 'plugins':
      return <PluginsSection adapters={adapters} />;
    case 'hooks':
      return <HooksSection />;
    case 'rules':
      return <RulesSection />;
    case 'shortcuts':
      return <ShortcutsSection />;
    default: {
      const unreachable: never = section;
      return unreachable;
    }
  }
}

export interface SettingsSurfaceProps {
  section: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  onBack: () => void;
  returnLabel: string;
  returnAriaLabel: string;
  returnKeyboardHint?: string;
  footerActionLabel?: string;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  detailRef?: RefObject<HTMLDivElement | null>;
  sectionTitleLevel: SettingsSectionTitleLevel;
}

/** Shared in-flow settings surface used by the page and the transitional drawer. */
export function SettingsSurface({
  section,
  onSelectSection,
  onBack,
  returnLabel,
  returnAriaLabel,
  returnKeyboardHint,
  footerActionLabel,
  searchInputRef,
  detailRef,
  sectionTitleLevel,
}: SettingsSurfaceProps) {
  const squadsCount = useOrchStore((state) => state.squads.length);
  const mcpToolCount = useOrchStore((state) => state.mcpInfo?.toolCount ?? 0);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [query, setQuery] = useState(
    () => peekEphemeralDraft<{ query: string }>('settings-nav')?.query ?? '',
  );
  const queryRef = useRef(query);
  queryRef.current = query;
  const searching = query.trim().length > 0;
  const groups = useMemo(
    () => filterSettingsGroups(SETTINGS_GROUPS, query),
    [query],
  );

  useEffect(() => {
    const activeSectionIsVisible = filterSettingsGroups(
      SETTINGS_GROUPS,
      queryRef.current,
    ).some((group) => group.items.some((item) => item.id === section));
    if (!activeSectionIsVisible) setQuery('');
  }, [section]);

  useEffect(() => {
    saveEphemeralDraft('settings-nav', { query });
  }, [query]);

  useEffect(() => {
    const api = window.nexus?.adapters;
    if (!api) return undefined;

    let cancelled = false;
    void api
      .list()
      .then((list) => {
        if (!cancelled) setAdapters(list);
      })
      .catch(() => {
        if (!cancelled) setAdapters([]);
      });
    const unsubscribe = api.onChanged(setAdapters);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const badges: Partial<Record<SettingsSection, number>> = {
    providers: adapters.length,
    squads: squadsCount,
    ...(mcpToolCount > 0 ? { tools: mcpToolCount, mcps: 1 } : {}),
  };
  const currentSectionTitle = SETTINGS_ITEMS.find(
    (item) => item.id === section,
  )?.title;
  const activePillar = settingsSectionPillar(section);

  return (
    <>
      <nav className="settings-nav" aria-label="Configurações">
        <div className="settings-nav__body">
          <div className="settings-nav__brand" aria-label="Nexus Config">
            <span className="settings-nav__brand-mark" aria-hidden>
              NX
            </span>
            <span className="settings-nav__brand-copy">
              <span className="settings-nav__brand-kicker">
                {activePillar.label}
              </span>
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
              ref={searchInputRef}
              className="settings-nav__search-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar configurações…"
              aria-label="Buscar nas configurações"
            />
          </div>
          <div className="settings-nav__groups">
          {searching && groups.length === 0 ? (
            <p className="settings-nav__no-match">
              Nada encontrado para “{query}”.
            </p>
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
                    onSelect={onSelectSection}
                  />
                ))}
              </div>
            ))
          )}
          </div>
        </div>
        <div className="settings-nav__footer">
          <div className="settings-nav__operator">
            <OperatorHud compact />
          </div>
          {footerActionLabel ? (
            <button
              type="button"
              className="settings-nav__close"
              onClick={onBack}
            >
              {footerActionLabel}
            </button>
          ) : null}
        </div>
      </nav>

      <div ref={detailRef} className="settings-detail">
        <header className="settings-detail__nav">
          <div className="settings-detail__location" aria-live="polite">
            <span>Configurações</span>
            <PixelIcon name="chevron" size={9} />
            <strong>{currentSectionTitle ?? 'Nexus'}</strong>
          </div>
          <button
            type="button"
            className="settings-detail__return"
            onClick={onBack}
            aria-label={returnAriaLabel}
          >
            <PixelIcon name="arrow-left" size={11} />
            <span>{returnLabel}</span>
            {returnKeyboardHint ? <kbd>{returnKeyboardHint}</kbd> : null}
          </button>
        </header>
        <div className="settings-detail__content">
          <SettingsSectionTitleProvider level={sectionTitleLevel}>
            <SettingsSectionContent
              section={section}
              adapters={adapters}
              onNavigateAway={onBack}
            />
          </SettingsSectionTitleProvider>
        </div>
      </div>
    </>
  );
}

export interface SettingsWorkspaceProps {
  section?: SettingsSection | null;
  onSectionChange?: (section: SettingsSection) => void;
  onBack?: () => void;
  className?: string;
}

export function SettingsWorkspace({
  section: controlledSection,
  onSectionChange,
  onBack,
  className = '',
}: SettingsWorkspaceProps = {}) {
  const destination = useProductNavigationStore((state) => state.destination);
  const openSettings = useProductNavigationStore((state) => state.openSettings);
  const backFromSettings = useProductNavigationStore(
    (state) => state.backFromSettings,
  );
  const detailRef = useRef<HTMLDivElement | null>(null);
  const hasControlledSection = controlledSection !== undefined;
  const shouldRender =
    hasControlledSection || destination.kind === 'settings';
  const destinationSection =
    destination.kind === 'settings' ? destination.section : undefined;
  const section = resolveOpenDrawerSection(
    controlledSection === undefined
      ? destinationSection
      : controlledSection,
  );

  useLayoutEffect(() => {
    if (!shouldRender || !detailRef.current) return;
    detailRef.current.scrollTop = 0;
    const heading =
      detailRef.current.querySelector<HTMLHeadingElement>(
        '.settings-detail__route-title',
      );
    if (!heading) return;
    heading.focus();
  }, [section, shouldRender]);

  if (!shouldRender) return null;

  return (
    <section
      className={`settings-workspace ${className}`.trim()}
      aria-label="Configurações do Nexus"
    >
      <h1 className="settings-visually-hidden">Configurações do Nexus</h1>
      <SettingsSurface
        section={section}
        onSelectSection={onSectionChange ?? openSettings}
        onBack={onBack ?? backFromSettings}
        returnLabel="Voltar"
        returnAriaLabel="Voltar ao destino anterior"
        detailRef={detailRef}
        sectionTitleLevel={2}
      />
    </section>
  );
}

export type { SettingsSection };
