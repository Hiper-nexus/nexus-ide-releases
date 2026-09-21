import { AcpHarnessPanel } from './AcpHarnessPanel';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_SECTION_SHORT_LABELS,
  settingsCategoryFor,
  type SettingsCategory,
} from './settings-categories';
import { PetSection } from './PetSection';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type { AdapterInfo } from '../../../shared/types';
import { isMissionRuntimeSquadId } from '../../../shared/orch-types';
import {
  settingsNavPillar,
  type SettingsNavPillar,
  type SettingsNavPillarId,
} from '../../../shared/endorphin';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import {
  peekEphemeralDraft,
  saveEphemeralDraft,
} from '../../state/ephemeral-draft-store';
import {
  SETTINGS_GROUPS,
  filterSettingsGroups,
  settingsPrimaryPillarOrder,
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
import { useGamificationStore } from '../../state/gamification-store';
import { AccountSection } from './AccountSection';
import { ApiKeysSection } from './ApiKeysSection';
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
import { JevDecisionsSection } from './JevDecisionsSection';
import { HarnessSection } from './HarnessSection';
import { CompanionRelaySection } from './CompanionRelaySection';
import { ArmsSection } from './ArmsSection';
import { LabsSection } from './LabsSection';
import {
  SettingsSectionTitle,
  SettingsSectionTitleProvider,
  type SettingsSectionTitleLevel,
} from './SettingsSectionTitle';

const SETTINGS_ITEMS = SETTINGS_GROUPS.flatMap((group) => group.items);

function navGroupHeadId(label: string): string {
  return `settings-nav-head-${label.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}`;
}

function NavGroupHeading({
  label,
  story,
  headId,
  count,
}: {
  label: string;
  story?: string;
  headId: string;
  count?: number;
}) {
  return (
    <div className="settings-nav__section-head">
      <p className="settings-nav__section" id={headId}>
        <span className="settings-nav__section-label">{label}</span>
        {count !== undefined ? (
          <span className="settings-nav__section-count">{count}</span>
        ) : null}
      </p>
      {story ? <p className="settings-nav__section-story">{story}</p> : null}
    </div>
  );
}

/** Agrupa as nove áreas sob os pilares da rail (Você/App/Agentes/Sistema). */
function categoriesByPillar(): Array<{
  pillar: SettingsNavPillar;
  categories: SettingsCategory[];
}> {
  const byPillar = new Map<SettingsNavPillarId, SettingsCategory[]>();
  for (const category of SETTINGS_CATEGORIES) {
    const bucket = byPillar.get(category.pillar) ?? [];
    bucket.push(category);
    byPillar.set(category.pillar, bucket);
  }
  return settingsPrimaryPillarOrder()
    .map((id) => ({
      pillar: settingsNavPillar(id),
      categories: byPillar.get(id) ?? [],
    }))
    .filter((entry) => entry.categories.length > 0);
}

const CATEGORY_GROUPS = categoriesByPillar();

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
  adapterStatus,
  onRetryAdapters,
}: {
  section: SettingsSection;
  adapters: AdapterInfo[];
  adapterStatus: "loading" | "ready" | "error";
  onRetryAdapters: () => void;
}) {
  if ((section === "llms" || section === "plugins") && adapterStatus !== "ready") {
    const navMeta = SETTINGS_ITEMS.find(item => item.id === section);
    return <section className="settings-section">
      <SettingsSectionTitle subtitle={navMeta?.subtitle}>{navMeta?.title}</SettingsSectionTitle>
      {adapterStatus === "loading"
        ? <div className="settings-route-state" role="status">
            <div className="settings-route-state__copy">
              <p>Carregando ferramentas de IA…</p>
              <div className="settings-skeleton" aria-hidden="true"><span /><span /><span /></div>
            </div>
          </div>
        : <div className="settings-route-state settings-route-state--error" role="alert">
            <span className="settings-route-state__icon" aria-hidden>
              <PixelIcon name="warn" size={14} />
            </span>
            <div className="settings-route-state__copy">
              <p>Não foi possível carregar as ferramentas de IA.</p>
              <button type="button" className="settings-btn" onClick={onRetryAdapters}>Tentar novamente</button>
            </div>
          </div>}
    </section>;
  }
  switch (section) {
    case 'account':
      return <AccountSection />;
    case 'api-keys':
      return <ApiKeysSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'pets':
      return <section><SettingsSectionTitle subtitle={SETTINGS_ITEMS.find(item => item.id === 'pets')?.subtitle}>Meus pets</SettingsSectionTitle><PetSection /></section>;
    case 'system':
      return <SystemSection />;
    case 'terminal':
      return <TerminalSection />;
    case 'voice':
      return <VoiceSection />;
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
      return <SquadsSection />;
    case 'jev-decisions':
      return <JevDecisionsSection />;
    case 'harness':
      return <HarnessSection overviewOnly />;
    case 'agent-connection':
      return <section><SettingsSectionTitle subtitle={SETTINGS_ITEMS.find(item => item.id === 'agent-connection')?.subtitle}>Conexão de agentes</SettingsSectionTitle><AcpHarnessPanel /></section>;
    case 'marketplace':
      return <MarketplaceSection />;
    case 'design-systems':
      return <DesignSystemsSection />;
    case 'remote':
      return <RemoteSection />;
    case 'companion-relay':
      return <CompanionRelaySection />;
    case 'connectors':
      return <ArmsSection />;
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
  const openProfile = useGamificationStore(state => state.openProfile);
  const squadsCount = useOrchStore(
    (state) =>
      state.squads.filter((squad) => !isMissionRuntimeSquadId(squad.id)).length,
  );
  const mcpToolCount = useOrchStore((state) => state.mcpInfo?.toolCount ?? 0);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adapterStatus, setAdapterStatus] = useState<"loading" | "ready" | "error">("loading");
  const [adapterAttempt, setAdapterAttempt] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const replacedFocus = useRef<{ element: HTMLElement; section: string | undefined } | null>(null);
  const [query, setQuery] = useState(
    () => peekEphemeralDraft<{ query: string }>('settings-nav')?.query ?? '',
  );
  const queryRef = useRef(query);
  queryRef.current = query;
  const innerSearchRef = useRef<HTMLInputElement | null>(null);
  const searching = query.trim().length > 0;
  const groups = useMemo(
    () => filterSettingsGroups(SETTINGS_GROUPS, query),
    [query],
  );
  const matchCount = useMemo(
    () => groups.reduce((total, group) => total + group.items.length, 0),
    [groups],
  );
  const clearSearch = () => {
    setQuery('');
    innerSearchRef.current?.focus();
  };

  /* Navegação por setas entre destinos da rail — padrão roving sem tirar
     nenhum item da ordem de Tab. */
  const onGroupsKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const { key } = event;
    if (
      key !== 'ArrowDown' &&
      key !== 'ArrowUp' &&
      key !== 'Home' &&
      key !== 'End'
    ) {
      return;
    }
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        '.settings-nav__item',
      ),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      key === 'Home'
        ? 0
        : key === 'End'
          ? items.length - 1
          : index + (key === 'ArrowDown' ? 1 : -1);
    items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
  };

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
    if (!api) { setAdapterStatus('error'); return; }
    let cancelled = false;
    let changed = false;
    setAdapterStatus('loading');
    const accept = (list: AdapterInfo[]) => {
      if (cancelled) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && contentRef.current?.contains(focused)) {
        replacedFocus.current = { element: focused, section: contentRef.current.dataset.settingsSection };
      }
      setAdapters(list);
      setAdapterStatus('ready');
    };
    void api.list().then(list => {
      if (!changed) accept(list);
    }).catch(() => {
      if (!cancelled && !changed) setAdapterStatus('error');
    });
    const unsubscribe = api.onChanged(list => { changed = true; accept(list); });
    return () => { cancelled = true; unsubscribe(); };
  }, [adapterAttempt]);

  useLayoutEffect(() => {
    const previous = replacedFocus.current;
    replacedFocus.current = null;
    if (!previous || previous.section !== section || previous.element.isConnected) return;
    if (document.activeElement !== document.body) return;
    contentRef.current?.querySelector<HTMLElement>('.settings-detail__route-title')?.focus();
  }, [adapterStatus, section]);

  const badges: Partial<Record<SettingsSection, number>> = {
    ...(adapterStatus === 'ready' ? { providers: adapters.length } : {}),
    squads: squadsCount,
    ...(mcpToolCount > 0 ? { tools: mcpToolCount, mcps: 1 } : {}),
  };
  const category = settingsCategoryFor(section);
  const currentSectionTitle = SETTINGS_ITEMS.find(
    (item) => item.id === section,
  )?.title;


  return (
    <>
      <nav className="settings-nav" aria-label="Configurações">
        <div className="settings-nav__body">
          <label className="settings-nav__compact">
            <span>Área de configurações</span>
            <select className="settings-input" value={category?.id ?? SETTINGS_CATEGORIES[0].id} onChange={(event) => {
              const selected = SETTINGS_CATEGORIES.find(item => item.id === event.currentTarget.value);
              if (selected) onSelectSection(selected.sections[0]);
            }}>
              {SETTINGS_CATEGORIES.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <div className="settings-nav__brand" aria-label="Configurações">
            <span className="settings-nav__brand-mark" aria-hidden>
              <PixelIcon name="config" size={14} />
            </span>
            <span className="settings-nav__brand-copy">
              <span className="settings-nav__brand-title">Configurações</span>
              <span className="settings-nav__brand-subtitle">
                Conta, app e agentes
              </span>
            </span>
          </div>
          <div className="settings-nav__search" role="search">
            <span className="settings-nav__search-icon" aria-hidden>
              <PixelIcon name="search" size={12} />
            </span>
            <input
              ref={(node) => {
                innerSearchRef.current = node;
                if (searchInputRef) searchInputRef.current = node;
              }}
              className="settings-nav__search-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && searching) setQuery('');
              }}
              placeholder="Buscar configurações…"
              aria-label="Buscar nas configurações"
            />
            {searching ? (
              <button
                type="button"
                className="settings-nav__search-clear"
                aria-label="Limpar busca"
                onClick={clearSearch}
              >
                <PixelIcon name="close" size={10} />
              </button>
            ) : null}
          </div>
          <div className="settings-nav__groups" onKeyDown={onGroupsKeyDown}>
          {searching && groups.length === 0 ? (
            <div className="settings-nav__no-match" role="status">
              <span className="settings-nav__no-match-icon" aria-hidden>
                <PixelIcon name="search" size={14} />
              </span>
              <p className="settings-nav__no-match-text">
                Nenhum ajuste encontrado para “{query}”.
              </p>
              <p className="settings-nav__no-match-hint">
                Tente o nome antigo ou em inglês — os aliases continuam valendo.
              </p>
              <button
                type="button"
                className="settings-btn settings-btn--sm"
                onClick={clearSearch}
              >
                Limpar busca
              </button>
            </div>
          ) : (
            searching ? <>
              <p className="settings-nav__match-count" role="status">
                {matchCount === 1
                  ? '1 ajuste encontrado'
                  : `${matchCount} ajustes encontrados`}
              </p>
              {groups.map((group) => {
                const headId = navGroupHeadId(group.label);
                return (
                <div
                  key={group.label}
                  className="settings-nav__group"
                  role="group"
                  aria-labelledby={headId}
                >
                  <NavGroupHeading
                    label={group.label}
                    story={group.story}
                    headId={headId}
                    count={group.items.length}
                  />
                  <ul className="settings-nav__list">
                    {group.items.map((item) => (
                      <li key={item.id}>
                        <NavRow
                          item={item}
                          active={section === item.id}
                          badge={badges[item.id]}
                          onSelect={onSelectSection}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
                );
              })}
            </> : CATEGORY_GROUPS.map(({ pillar, categories }) => {
              const headId = `settings-nav-head-${pillar.id}`;
              return (
                <div
                  key={pillar.id}
                  className="settings-nav__group"
                  role="group"
                  aria-labelledby={headId}
                >
                  <NavGroupHeading
                    label={pillar.label}
                    story={pillar.story}
                    headId={headId}
                  />
                  <ul className="settings-nav__list">
                    {categories.map(item => {
                      const active = item.sections.includes(section);
                      const first = SETTINGS_ITEMS.find(entry => entry.id === (active ? section : item.sections[0]));
                      if (!first) return null;
                      return (
                        <li key={item.id}>
                          <NavRow item={{ ...first, title: item.title, subtitle: item.description, pixelIcon: item.icon }} active={active} onSelect={onSelectSection} />
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}
          </div>
        </div>
        <div className="settings-nav__footer">
          <div className="settings-nav__operator">
            <button type="button" className="settings-nav__profile" onClick={() => onSelectSection('pets')}><PixelIcon name="grid" size={14} /> Meus pets</button>
            <button type="button" className="settings-nav__profile" onClick={openProfile}>
              <PixelIcon name="user" size={14} /> Meu perfil
            </button>
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
          <div className="settings-detail__bar">
            <div className="settings-detail__location" aria-live="polite">
              <span>Configurações</span>
              <PixelIcon name="chevron" size={9} />
              {category ? (
                <>
                  <span>{category.title}</span>
                  <PixelIcon name="chevron" size={9} />
                </>
              ) : null}
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
          </div>
          {category && category.sections.length > 1 && <nav className="settings-category-tabs" aria-label={`Seções de ${category.title}`}>
            {category.sections.map(id => <button key={id} type="button" className={`settings-category-tabs__item ${section === id ? 'settings-category-tabs__item--active' : ''}`} aria-current={section === id ? 'page' : undefined} onClick={() => onSelectSection(id)}>{SETTINGS_SECTION_SHORT_LABELS[id] ?? SETTINGS_ITEMS.find(item => item.id === id)?.title}</button>)}
          </nav>}
        </header>
        <div ref={contentRef} className="settings-detail__content" data-settings-section={section}>
          <SettingsSectionTitleProvider level={sectionTitleLevel}>
            <SettingsSectionContent
              section={section}
              adapters={adapters}
              adapterStatus={adapterStatus}
              onRetryAdapters={() => setAdapterAttempt(attempt => attempt + 1)}
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
      <div className="settings-workspace__layout">
      <SettingsSurface
        section={section}
        onSelectSection={onSectionChange ?? openSettings}
        onBack={onBack ?? backFromSettings}
        returnLabel="Voltar"
        returnAriaLabel="Voltar ao destino anterior"
        detailRef={detailRef}
        sectionTitleLevel={2}
      />
      </div>
    </section>
  );
}

export type { SettingsSection };
