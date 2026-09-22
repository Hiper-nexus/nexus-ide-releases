import { ProviderLogo, hasProviderLogo } from '../ProviderLogo';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AdapterInfo,
  EnrichedCatalogInfo,
  InstalledItemInfo,
  NativeToolInfo,
} from '../../../shared/types';
import { isMissionRuntimeSquadId } from '../../../shared/orch-types';
import { useOrchStore } from '../../state/orch-store';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { ActionCard, EmptyState } from '../ActionCard';
import {
  catalogEmptyCta,
  catalogEmptyKindFromMessage,
} from '../empty-cta-policy';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { waitForSession, writeToPane } from '../../terminal/terminal-host';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { useCatalogResource } from './use-catalog-resource';
import { buildHarnessInventory, filterHarnessInventory, harnessOrigin, type HarnessTierFilter } from './harness-view-model';

/**
 * CATALOG sections: locally installed components (agents/skills), the
 * embedded MCP server, native tools, plugin files, generated lifecycle hooks,
 * permission rules (skill-gate allowlists) and keyboard shortcuts.
 */

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleString();
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kB`;
}

/** Identidade do item quando não há logo de provider: o kind vira glifo do set. */
function catalogItemIcon(kind: string | undefined): PixelIconName {
  switch (kind) {
    case 'agent':
      return 'agent';
    case 'skill':
      return 'file';
    case 'adapter':
      return 'bolt';
    case 'hook-home':
      return 'bell';
    default:
      return 'file';
  }
}

/** Identidade da pasta de origem — logo oficial quando a marca existe no set. */
function originIdent(origin: string): ReactNode {
  const id = origin.toLowerCase();
  if (hasProviderLogo(id)) return <ProviderLogo adapterId={id} label={origin} size="xs" />;
  return (
    <PixelIcon
      name={origin === 'Agents' ? 'agent' : origin === 'Nexus' ? 'config' : 'file'}
      size={12}
    />
  );
}

const readInstalled = () => window.nexus.orch.listInstalledCatalog();
const readDescriptions = () => window.nexus.orch.harnessEnriched();
const readTools = () => window.nexus.orch.listNativeTools();
const readPlugins = () => window.nexus.orch.listPluginFiles();
const readHooks = () => window.nexus.orch.listHookHomes();
const readMediaProviders = () => window.nexus.media.listProviders();

const FUNCTIONS: ReadonlyArray<{ value: HarnessTierFilter; label: string }> = [
  { value: 'todos', label: 'Todas as funções' },
  { value: 'scout', label: 'Investigar' },
  { value: 'builder', label: 'Implementar' },
  { value: 'reviewer', label: 'Revisar' },
  { value: 'pendente', label: 'Sem classificação' },
];

function CatalogStatus({ loading, error, reload, label }: {
  loading: boolean; error: string | null; reload(): void; label: string;
}) {
  if (loading) {
    return (
      <div className="catalog-skeleton" role="status">
        <span className="settings-visually-hidden">{label}</span>
        {(['a', 'b', 'c'] as const).map((row) => (
          <div key={row} className="catalog-skeleton__row" aria-hidden="true">
            <span className="catalog-skeleton__ident" />
            <span className={`catalog-skeleton__line catalog-skeleton__line--${row}`} />
          </div>
        ))}
      </div>
    );
  }
  if (!error) return null;
  return <div className="catalog-settings__error" role="alert"><PixelIcon name="warn" className="catalog-status__icon" /><p>{error}</p><button type="button" className="settings-btn" onClick={reload}>Tentar novamente</button></div>;
}

function useEnrichedCatalog() {
  const resource = useCatalogResource(readDescriptions, 'Não foi possível carregar as descrições dos recursos.');
  const [enriching, setEnriching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function runEnrich() {
    if (busy.current) return;
    busy.current = true;
    setEnriching(true);
    setActionError(null);
    try {
      const result = await window.nexus.orch.harnessEnrich();
      if (!mounted.current) return;
      if (!result.ok || !result.catalog) throw new Error('classification unavailable');
      resource.accept(result.catalog);
    } catch {
      if (mounted.current) setActionError('Não foi possível gerar as descrições. Confira a conexão de IA e tente novamente.');
    } finally {
      busy.current = false;
      if (mounted.current) setEnriching(false);
    }
  }
  return { ...resource, enriched: resource.data, enriching, actionError, runEnrich };
}

function EnrichBar({ enrich, disabled }: {
  enrich: ReturnType<typeof useEnrichedCatalog>; disabled: boolean;
}) {
  return <details className="settings-enrich catalog-settings__advanced">
    <summary>Descrições e classificação com IA</summary>
    <p>Gerar descrições organiza o catálogo. Essa ação não executa os recursos nem altera permissões.</p>
    <button type="button" className="settings-btn" onClick={() => void enrich.runEnrich()} disabled={disabled || enrich.loading || enrich.enriching}>
      <PixelIcon name="sparkle" />{enrich.enriching ? 'Gerando descrições…' : 'Gerar descrições com IA'}
    </button>
    {enrich.enriched && <p className="catalog-settings__metadata">Última classificação: {timeLabel(enrich.enriched.updatedAt)}</p>}
    <CatalogStatus loading={false} error={enrich.actionError} reload={() => void enrich.runEnrich()} label="" />
  </details>;
}

function enrichmentOf(enriched: EnrichedCatalogInfo | null, kind: 'agent' | 'skill', name: string) {
  return enriched?.items.find(item => item.kind === kind && item.name === name);
}

function InstalledList({ items, empty, enriched, kind, resetFilters, emptyIcon }: {
  items: InstalledItemInfo[]; empty: string; enriched?: EnrichedCatalogInfo | null;
  kind?: 'agent' | 'skill'; resetFilters?: () => void; emptyIcon?: PixelIconName;
}) {
  if (items.length === 0) {
    const cta = catalogEmptyCta(catalogEmptyKindFromMessage(empty));
    return <EmptyState icon={resetFilters ? 'search' : emptyIcon ?? 'sparkle'} title={resetFilters ? 'Nenhum resultado para estes filtros' : 'Nenhum recurso nesta lista'} body={<p>{empty}</p>}
      action={resetFilters ? <button type="button" className="settings-btn" onClick={resetFilters}>Limpar filtros</button>
        : cta === 'marketplace' ? <ActionCard icon="star" title="Abrir Marketplace" subtitle="Instalar agentes e skills" variant="primary" size="sm" onClick={() => useProductNavigationStore.getState().openSettings('marketplace')} /> : undefined}
    />;
  }
  const renderItem = (item: InstalledItemInfo) => {
    const note = kind ? enrichmentOf(enriched ?? null, kind, item.name) : undefined;
    const tierLabel = note
      ? FUNCTIONS.find(option => option.value === note.tier)?.label ?? note.tier
      : undefined;
    return <li key={item.file} className="settings-list__item catalog-item">
      <div className="catalog-item__head">
        <span className="catalog-item__ident" aria-hidden="true">
          {hasProviderLogo(item.name)
            ? <ProviderLogo adapterId={item.name} label={item.name} size="xs" />
            : <PixelIcon name={catalogItemIcon(kind ?? item.kind)} size={12} />}
        </span>
        <div className="catalog-item__titles">
          <strong className="catalog-item__name">{item.name}</strong>
          <span className="catalog-item__meta">{harnessOrigin(item.file)}</span>
        </div>
        {tierLabel ? (
          <div className="catalog-item__actions">
            <span className="settings-chip">{tierLabel}</span>
          </div>
        ) : null}
      </div>
      {note?.blurb ? <p className="catalog-item__blurb">{note.blurb}</p> : null}
      <details className="catalog-item__details">
        <summary>Detalhes do recurso</summary>
        {note?.whenToUse ? <p><strong>Quando usar:</strong> {note.whenToUse}</p> : null}
        <p className="catalog-settings__file">{item.file}</p>
        <p className="catalog-settings__metadata">
          Modificado em {timeLabel(item.modifiedAt)} · {sizeLabel(item.size)}
        </p>
      </details>
    </li>;
  };
  const byOrigin = new Map<string, InstalledItemInfo[]>();
  for (const item of items) {
    const origin = harnessOrigin(item.file);
    const list = byOrigin.get(origin);
    if (list) list.push(item); else byOrigin.set(origin, [item]);
  }
  const origins = [...byOrigin.keys()].sort((a, b) => a.localeCompare(b, 'pt'));
  if (origins.length <= 1) {
    return <ul className="settings-list catalog-settings__resources">{items.map(renderItem)}</ul>;
  }
  return <>{origins.map(origin => {
    const list = byOrigin.get(origin)!;
    return <div key={origin} className="arsenal-band">
      <h4 className="arsenal-band__label">
        <span className="catalog-band__icon">{originIdent(origin)}</span>
        {origin}
        <span className="arsenal-band__count">{list.length}</span>
      </h4>
      <ul className="settings-list catalog-settings__resources">{list.map(renderItem)}</ul>
    </div>;
  })}</>;
}

function ResourceCatalogSection({ kind, title, description, children }: {
  kind: 'agent' | 'skill'; title: string; description: string; children?: ReactNode;
}) {
  const catalog = useCatalogResource(readInstalled, 'Não foi possível carregar os recursos instalados.');
  const enrich = useEnrichedCatalog();
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState<HarnessTierFilter>('todos');
  const items = (catalog.data ?? []).filter(item => item.kind === kind);
  const visible = filterHarnessInventory(buildHarnessInventory(items, enrich.enriched), { query, kind, tier, origin: 'todas' }).map(row => row.item);
  const filtered = Boolean(query.trim() || tier !== 'todos');
  const resetFilters = () => { setQuery(''); setTier('todos'); };
  return <section className="catalog-settings">
    <header className="catalog-settings__header"><div><SettingsSectionTitle>{title}</SettingsSectionTitle><p className="settings-detail__hint">{description}</p></div>
      <button type="button" className="settings-btn" disabled={catalog.loading} onClick={() => void catalog.reload()}>Atualizar lista</button>
    </header>
    <div className="catalog-settings__filters" role="search">
      <label>Buscar recursos<input className="settings-input" type="search" aria-label="Buscar recursos" placeholder="Nome, origem ou descrição" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>Função<select className="settings-input" aria-label="Função do recurso" value={tier} disabled={enrich.loading} onChange={event => setTier(event.target.value as HarnessTierFilter)}>{FUNCTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {catalog.data !== null && !catalog.loading && !(catalog.error && items.length === 0) && (
        <p className="catalog-settings__count" role="status">{visible.length} de {items.length} recursos</p>
      )}
    </div>
    <CatalogStatus {...catalog} reload={() => void catalog.reload()} label="Carregando recursos instalados…" />
    <CatalogStatus loading={false} error={enrich.error} reload={() => void enrich.reload()} label="" />
    {catalog.data !== null && !catalog.loading && !(catalog.error && items.length === 0) && (
      <InstalledList items={visible} enriched={enrich.enriched} kind={kind} resetFilters={filtered ? resetFilters : undefined} emptyIcon={kind === 'agent' ? 'agent' : 'file'}
        empty={filtered ? 'Limpe os filtros para voltar à lista completa.' : `${kind === 'agent' ? 'Nenhum agente instalado.' : 'Nenhuma skill instalada.'} Use o Marketplace para adicionar recursos.`} />
    )}
    <EnrichBar enrich={enrich} disabled={catalog.loading || items.length === 0} />
    {children}
  </section>;
}

export function AgentsSection() {
  const squadAgents = useOrchStore(state => state.squads.filter(squad => !isMissionRuntimeSquadId(squad.id)).reduce((count, squad) => count + squad.agents.length, 0));
  return <ResourceCatalogSection kind="agent" title="Agentes" description="Arquivos de agentes instalados para orientar as ferramentas de IA.">
    <p className="catalog-settings__note">As equipes salvas têm {squadAgents} integrantes configurados. Consulte Equipes para usar esses integrantes em uma missão.</p>
  </ResourceCatalogSection>;
}

export function SkillsSection() {
  return <ResourceCatalogSection kind="skill" title="Instruções (skills)" description="Instruções reutilizáveis instaladas nesta máquina. Seu uso durante uma missão respeita as regras de execução do Nexus." />;
}

const MEDIA_KIND_ORDER = ['image', 'video', 'audio'] as const;
const MEDIA_KIND_LABELS: Record<(typeof MEDIA_KIND_ORDER)[number], string> = {
  image: 'Imagem',
  video: 'Vídeo',
  audio: 'Voz',
};
const MEDIA_KIND_ICONS: Record<(typeof MEDIA_KIND_ORDER)[number], PixelIconName> = {
  image: 'vision',
  video: 'vision',
  audio: 'volume',
};

/** Faixa MÍDIA do arsenal: modelos de geração habilitados (key presente). */
export function MediaCatalogSection() {
  const catalog = useCatalogResource(readMediaProviders, 'Não foi possível carregar os modelos de mídia.');
  const providers = catalog.data ?? [];
  const enabled = providers.filter((p) => p.hasKey);
  const groups = MEDIA_KIND_ORDER
    .map((kind) => ({
      kind,
      label: MEDIA_KIND_LABELS[kind],
      items: providers.filter((p) => p.kind === kind),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <section className="catalog-settings">
      <header className="catalog-settings__header">
        <div>
          <SettingsSectionTitle>Modelos de mídia</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Consulte modelos de imagem, vídeo e voz. {enabled.length} de {providers.length} serviços conectados.
          </p>
        </div>
        <div className="settings-action-row">
          <button type="button" className="settings-btn" disabled={catalog.loading} onClick={() => void catalog.reload()}>Atualizar lista</button>
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => useProductNavigationStore.getState().openSettings('media')}>Configurar conexões de mídia</button>
        </div>
      </header>
      <CatalogStatus {...catalog} reload={() => void catalog.reload()} label="Carregando modelos de mídia…" />
      {catalog.loading || catalog.error ? null : providers.length === 0 ? (
        <EmptyState
          icon="vision"
          title="Nenhum serviço de mídia"
          body={
            <p>
              Conecte um serviço em Mídia para criar imagens, vídeos ou voz.
            </p>
          }
          action={
            <ActionCard
              icon="key"
              title="Abrir Mídia"
              subtitle="Conectar serviços"
              variant="primary"
              size="sm"
              onClick={() =>
                useProductNavigationStore.getState().openSettings('media')
              }
            />
          }
        />
      ) : (
        groups.map((group) => (
          <div key={group.kind} className="arsenal-band">
            <h4 className="arsenal-band__label">
              <PixelIcon name={MEDIA_KIND_ICONS[group.kind]} size={12} />
              {group.label}
              <span className="arsenal-band__count">{group.items.length}</span>
            </h4>
            <ul className="settings-list">
              {group.items.map((p) => (
                <li key={p.id} className="settings-list__item catalog-item">
                  <div className="catalog-item__head">
                    <ProviderLogo adapterId={p.id.split('-')[0]} label={p.label} size="sm" />
                    <div className="catalog-item__titles">
                      <span className="catalog-item__name">{p.label}</span>
                      <span className="catalog-item__meta">
                        Padrão: <code>{p.defaultModel}</code>
                      </span>
                    </div>
                    <div className="catalog-item__actions">
                      <span
                        className={`settings-chip ${p.hasKey ? 'settings-chip--ok' : 'settings-chip--warn'}`}
                      >
                        {p.hasKey ? 'conectado' : 'sem chave'}
                      </span>
                    </div>
                  </div>
                  <details className="catalog-item__details">
                    <summary>Ver {p.models.length} modelos disponíveis</summary>
                    <p className="settings-list__detail">{p.models.join(' · ')}</p>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/** Faixa LLMS · CLIS do arsenal: adapters instalados e seus modelos. */
export function LlmsSection({ adapters }: { adapters: AdapterInfo[] }) {
  const installed = adapters.filter((a) => a.installed && a.id !== 'shell');
  const absent = adapters.filter((a) => !a.installed && a.id !== 'shell');
  const [pendingInstallId, setPendingInstallId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  async function openInstallTerminal(adapter: AdapterInfo): Promise<void> {
    if (!adapter.installCommand || pendingInstallId !== null) return;
    setInstallError(null);
    setPendingInstallId(adapter.id);

    const layout = useLayoutStore.getState();
    const paneId = layout.addShellPane({ focus: false });
    let sessionId: string | null = null;
    try {
      sessionId = await waitForSession(paneId);
    } catch {
      // The failure copy below is the one announced to the operator.
    }

    if (!sessionId) {
      layout.close(paneId, 'settings-install-terminal-unavailable');
      setPendingInstallId(null);
      setInstallError(
        'O terminal não ficou disponível. A instalação não foi iniciada.',
      );
      return;
    }

    writeToPane(paneId, `${adapter.installCommand}\n`);
    setPendingInstallId(null);
    layout.focus(paneId);
    useProductNavigationStore.getState().openTerminal();
  }
  return (
    <section className="catalog-settings">
      <SettingsSectionTitle>Ferramentas e modelos</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Ferramentas de IA detectadas nesta máquina ({installed.length}) e modelos informados por cada integração.
      </p>
      {installError ? (
        <p className="settings-error" role="alert">
          {installError}
        </p>
      ) : null}
      {installed.length === 0 ? (
        <EmptyState
          icon="terminal"
          title="Nenhuma ferramenta de IA instalada"
          body={
            <p>
              Instale uma ferramenta de IA e configure sua conexão em Providers.
            </p>
          }
          action={
            <ActionCard
              icon="key"
              title="Abrir Providers"
              subtitle="chaves · CLIs"
              variant="primary"
              size="sm"
              onClick={() =>
                useProductNavigationStore.getState().openSettings('providers')
              }
            />
          }
        />
      ) : (
        <ul className="settings-list">
          {installed.map((a) => (
            <li key={a.id} className="settings-list__item catalog-item">
              <div className="catalog-item__head">
                <ProviderLogo adapterId={a.id} label={a.label} size="sm" />
                <div className="catalog-item__titles">
                  <span className="catalog-item__name">{a.label}</span>
                  <span className="catalog-item__meta">
                    {a.models.list.length > 0
                      ? <>Padrão: <code>{a.models.default || a.models.list[0]}</code> · {a.models.list.length} {a.models.list.length === 1 ? 'modelo' : 'modelos'}</>
                      : 'Modelos padrão da ferramenta'}
                  </span>
                  {a.authReady === false && a.authReason ? (
                    <span className="catalog-item__meta">Autorização: {a.authReason}</span>
                  ) : null}
                </div>
                <div className="catalog-item__actions">
                  {a.authReady === true ? (
                    <span className="settings-chip settings-chip--ok">autorizada</span>
                  ) : null}
                  {a.authReady === false ? (
                    <span className="settings-chip settings-chip--warn">autorização pendente</span>
                  ) : null}
                  <span className="settings-chip settings-chip--ok">instalada</span>
                </div>
              </div>
              {a.models.list.length > 0 && (
                <details className="catalog-item__details">
                  <summary>Ver {a.models.list.length} {a.models.list.length === 1 ? 'modelo' : 'modelos'}</summary>
                  <p className="settings-list__detail">{a.models.list.join(' · ')}</p>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {absent.length > 0 && (
        <div className="settings-installable">
          <h4 className="settings-detail__title settings-installable__title">
            Disponíveis para instalação
          </h4>
          <ul className="settings-list">
            {absent.map((a) => (
              <li key={a.id} className="settings-list__item catalog-item settings-installable__item">
                <div className="catalog-item__head">
                  <ProviderLogo adapterId={a.id} label={a.label} size="sm" />
                  <div className="catalog-item__titles">
                    <span className="catalog-item__name">{a.label}</span>
                    {a.installCommand ? (
                      <span className="catalog-item__meta">
                        Comando: <code>{a.installCommand}</code>
                      </span>
                    ) : (
                      <span className="catalog-item__meta">Instalação manual</span>
                    )}
                  </div>
                  <div className="catalog-item__actions">
                    {a.installCommand ? (
                      <button
                        type="button"
                        className="settings-btn settings-btn--sm"
                        onClick={() => void openInstallTerminal(a)}
                        disabled={pendingInstallId !== null}
                        aria-busy={pendingInstallId === a.id}
                        aria-label={`Instalar ${a.label} em um terminal`}
                        title={`Executar comando: ${a.installCommand}`}
                      >
                        <PixelIcon name="terminal" size={10} />{' '}
                        {pendingInstallId === a.id ? 'Abrindo…' : 'Instalar'}
                      </button>
                    ) : (
                      <span className="settings-chip">manual</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export { McpsSection } from './McpsSection';

function toolFamily(name: string): string {
  const bare = name.replace(/^nexus_/, '');
  const head = bare.split('_')[0] ?? bare;
  if (head === 'terminal' || head === 'shell') return 'terminal';
  if (head === 'file' || head === 'files' || head === 'fs') return 'arquivos';
  if (head === 'browser' || head === 'web') return 'navegador';
  if (head === 'image' || head === 'video' || head === 'audio' || head === 'media') {
    return 'mídia';
  }
  if (head === 'git' || head === 'github') return 'git';
  if (head === 'mission' || head === 'squad' || head === 'orch') return 'orquestração';
  return 'outras';
}

const TOOL_FAMILY_LABELS: Record<string, string> = {
  terminal: 'Terminal',
  arquivos: 'Arquivos',
  navegador: 'Navegador',
  mídia: 'Mídia',
  git: 'Git',
  orquestração: 'Orquestração',
  outras: 'Outras',
};

const TOOL_FAMILY_ICONS: Record<string, PixelIconName> = {
  terminal: 'terminal',
  arquivos: 'files',
  navegador: 'browser',
  mídia: 'vision',
  git: 'link',
  orquestração: 'orch',
  outras: 'config',
};

export function ToolsSection() {
  const catalog = useCatalogResource(readTools, 'Não foi possível carregar as ferramentas MCP.');
  const tools = catalog.data ?? [];
  const { loading, error } = catalog;
  const [query, setQuery] = useState('');

  const filtered = tools.filter((tool) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      tool.name.toLowerCase().includes(q) ||
      tool.description.toLowerCase().includes(q)
    );
  });

  const grouped = filtered.reduce<Record<string, NativeToolInfo[]>>((acc, tool) => {
    const family = toolFamily(tool.name);
    (acc[family] ??= []).push(tool);
    return acc;
  }, {});

  const families = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'pt'));

  return (
    <section className="arsenal-section catalog-settings" aria-label="Ferramentas MCP">
      <header className="catalog-settings__header">
        <div>
        <SettingsSectionTitle>Ferramentas MCP</SettingsSectionTitle>
        <p className="settings-detail__hint">
          Recursos disponíveis para os agentes. Cada execução respeita as permissões e os limites definidos pelo Nexus.
        </p>
        </div>
        <button type="button" className="settings-btn" disabled={loading} onClick={() => void catalog.reload()}>Atualizar lista</button>
      </header>

      <div className="arsenal-toolbar">
        <div className="arsenal-fleet" role="status">
          <span className="arsenal-fleet__stat">
            {catalog.data === null && error ? 'Contagem indisponível' : <><strong>{loading ? '…' : tools.length}</strong> ferramentas</>}
          </span>
          {query.trim() && (
            <>
              <span className="arsenal-fleet__sep" aria-hidden="true">
                ·
              </span>
              <span className="arsenal-fleet__stat">
                {filtered.length} na busca
              </span>
            </>
          )}
        </div>

        <label className="arsenal-search">
          <span className="settings-visually-hidden">Buscar ferramentas</span>
          <input
            className="settings-input arsenal-search__input"
            type="search"
            value={query}
            placeholder="Nome ou descrição"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      <CatalogStatus {...catalog} reload={() => void catalog.reload()} label="Carregando ferramentas MCP…" />

      {!loading && !error && tools.length === 0 && (
        <EmptyState
          icon="config"
          title="Nenhuma ferramenta registrada"
          body={
            <p>Confira a conexão MCP do Nexus para carregar as ferramentas.</p>
          }
          action={
            <ActionCard
              icon="bolt"
              title="Abrir MCPs"
              subtitle="servidor · status"
              variant="primary"
              size="sm"
              onClick={() =>
                useProductNavigationStore.getState().openSettings('mcps')
              }
            />
          }
        />
      )}

      {!loading && !error && tools.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title={`Nada para “${query}”`}
          body={<p>Ajuste o filtro ou limpe a busca.</p>}
          action={<button type="button" className="settings-btn" onClick={() => setQuery('')}>Limpar busca</button>}
        />
      )}

      {families.map((family) => (
        <div key={family} className="arsenal-band">
          <h4 className="arsenal-band__label">
            <PixelIcon name={TOOL_FAMILY_ICONS[family] ?? 'config'} size={12} />
            {TOOL_FAMILY_LABELS[family] ?? family}{' '}
            <span className="arsenal-band__count">{grouped[family].length}</span>
          </h4>
          <ul className="settings-list">
            {grouped[family].map((tool) => (
              <li key={tool.name} className="settings-list__item arsenal-tool">
                <div className="settings-list__head">
                  <span className="settings-list__title settings-list__title--mono">
                    {tool.name}
                  </span>
                </div>
                {/* A descrição real em uma linha (completa no tooltip): o
                    disclosure "O que esta ferramenta faz" se repetia 173
                    vezes e escondia justamente a informação útil. */}
                {tool.description ? (
                  <p className="settings-list__detail arsenal-tool__summary" title={tool.description}>
                    {tool.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function FileCatalogSection({ title, description, read, empty, emptyIcon }: {
  title: string; description: string; read(): Promise<InstalledItemInfo[]>; empty: string;
  emptyIcon?: PixelIconName;
}) {
  const catalog = useCatalogResource(read, `Não foi possível carregar o catálogo de ${title.toLocaleLowerCase()}.`);
  return <section className="catalog-settings">
    <header className="catalog-settings__header"><div><SettingsSectionTitle>{title}</SettingsSectionTitle><p className="settings-detail__hint">{description}</p></div>
      <button type="button" className="settings-btn" disabled={catalog.loading} onClick={() => void catalog.reload()}>Atualizar lista</button>
    </header>
    <CatalogStatus {...catalog} reload={() => void catalog.reload()} label={`Carregando ${title.toLocaleLowerCase()}…`} />
    {catalog.data !== null && !catalog.loading && !(catalog.error && catalog.data.length === 0) && <>
      <InstalledList items={catalog.data} empty={empty} emptyIcon={emptyIcon} />
      <p className="catalog-settings__count" role="status">{catalog.data.length} registros nesta lista</p>
    </>}
  </section>;
}

export function PluginsSection({ adapters }: { adapters: AdapterInfo[] }) {
  return <FileCatalogSection title="Plugins" read={readPlugins} emptyIcon="bolt"
    description={`${adapters.length} integrações reconhecidas. Esta lista mostra os arquivos locais de extensão do usuário.`}
    empty="Nenhum plugin de usuário encontrado. Os arquivos de integração ficam em ~/.nexus/plugins/adapters." />;
}

export function HooksSection() {
  return <FileCatalogSection title="Eventos dos agentes" read={readHooks} emptyIcon="bell"
    description="Diretórios gerados para acompanhar eventos dos agentes. A presença de uma pasta não indica que uma sessão esteja ativa."
    empty="Nenhum diretório de hooks encontrado. Eles são gerados conforme os agentes precisam de eventos de execução." />;
}

export function RulesSection() {
  const [query, setQuery] = useState('');
  const [team, setTeam] = useState('');
  // Cada missão deixa uma configuração própria; listadas todas, a página
  // passava de 20 mil px com "Execução + QA" repetido e prompts de teste.
  // O padrão mostra as equipes salvas; missões ficam a um clique.
  const [includeMissions, setIncludeMissions] = useState(false);
  const squads = useOrchStore((s) => s.squads);
  const allRows = squads.flatMap((squad) =>
    squad.agents.map((agent) => ({
      squad: squad.name,
      squadId: squad.id,
      source: isMissionRuntimeSquadId(squad.id) ? 'Configuração de missão' : 'Equipe salva',
      agentId: agent.id,
      cli: agent.cli,
      category: agent.category,
      model: agent.model,
      agent: agent.agentName,
      tools:
        agent.allowedTools == null
          ? 'Sem lista específica'
          : agent.allowedTools.join(', ') || 'Nenhuma declarada',
      skills:
        agent.allowedSkills == null
          ? 'Sem lista específica'
          : agent.allowedSkills.join(', ') || 'Nenhuma declarada',
    })),
  );
  const missionRowCount = allRows.filter(row => isMissionRuntimeSquadId(row.squadId)).length;
  const rows = includeMissions || team
    ? allRows
    : allRows.filter(row => !isMissionRuntimeSquadId(row.squadId));
  const filteredRows = rows.filter(row =>
    (!team || row.squadId === team) &&
    `${row.agent} ${row.squad} ${row.tools} ${row.skills}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const filteredGroups = [...filteredRows
    .reduce((map, row) => {
      const list = map.get(row.squadId);
      if (list) list.push(row); else map.set(row.squadId, [row]);
      return map;
    }, new Map<string, typeof filteredRows>())
    .entries()];
  const resetFilters = () => { setQuery(''); setTeam(''); };
  return (
    <section className="catalog-settings">
      <SettingsSectionTitle>Permissões</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Configurações declaradas por agente em equipes e missões. A execução também aplica as políticas e os limites do Nexus.
      </p>
      <div className="catalog-settings__filters" role="search">
        <label className="settings-field">Buscar regras<input type="search" className="settings-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Agente, equipe ou recurso" /></label>
        <label className="settings-field">Equipe<select className="settings-input" value={team} onChange={event => setTeam(event.target.value)}><option value="">Todas as equipes e missões</option>{squads.map(squad => <option key={squad.id} value={squad.id}>{squad.name}</option>)}</select></label>
      </div>
      {missionRowCount > 0 ? (
        <label className="settings-check catalog-settings__include-missions">
          <input type="checkbox" checked={includeMissions} onChange={event => setIncludeMissions(event.target.checked)} />
          Incluir configurações de missões ({missionRowCount} agentes)
        </label>
      ) : null}
      <p className="catalog-settings__count" role="status">{filteredRows.length} de {rows.length} agentes</p>
      {allRows.length === 0 ? (
        <EmptyState
          icon="key"
          title="Nenhuma declaração carregada"
          body={
            <p>
              Consulte as equipes salvas para configurar os integrantes e suas instruções.
            </p>
          }
          action={
            <ActionCard
              icon="users"
              title="Abrir Squads"
              subtitle="Ver equipes configuradas"
              variant="primary"
              size="sm"
              onClick={() =>
                useProductNavigationStore.getState().openSettings('squads')
              }
            />
          }
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          icon="search"
          title="Nenhum agente corresponde aos filtros"
          body={<p>Ajuste a busca ou a equipe selecionada.</p>}
          action={<button type="button" className="settings-btn" onClick={resetFilters}>Limpar filtros</button>}
        />
      ) : (
        filteredGroups.map(([squadId, squadRows]) => (
          <div key={squadId} className="arsenal-band">
            <h4 className="arsenal-band__label">
              {squadRows[0].squad}
              <span className="catalog-band__source">{squadRows[0].source}</span>
              <span className="arsenal-band__count">{squadRows.length}</span>
            </h4>
            <ul className="settings-list">
              {squadRows.map((row) => (
                <li key={row.agentId} className="settings-list__item catalog-item">
                  <div className="catalog-item__head">
                    <span className="catalog-item__ident" aria-hidden="true">
                      {hasProviderLogo(row.cli)
                        ? <ProviderLogo adapterId={row.cli} label={row.cli} size="xs" />
                        : <PixelIcon name="agent" size={12} />}
                    </span>
                    <div className="catalog-item__titles">
                      <span className="catalog-item__name">{row.agent}</span>
                      <span className="catalog-item__meta">
                        {row.category}{row.model ? ` · ${row.model}` : ''}
                      </span>
                    </div>
                  </div>
                  <dl className="catalog-settings__permissions"><dt>Ferramentas</dt><dd>{row.tools}</dd><dt>Instruções</dt><dd>{row.skills}</dd></dl>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/* Recipes, Atalhos e Remote moraram aqui; foram extraídos para
   CatalogSectionsOps.tsx (teto de 800 linhas por módulo). Re-export mantém
   os consumidores de Settings independentes dessa divisão interna. */
export { RecipesSection, RemoteSection, ShortcutsSection } from './CatalogSectionsOps';
