import { useEffect, useMemo, useState } from 'react';
import type { CatalogEntryInfo } from '../../../shared/types';
import { EmptyState } from '../ActionCard';
import { PixelIcon } from '../PixelIcon';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Marketplace — the catalog surface: the full
 * browsable aitmpl index (davila7/claude-code-templates; 400+ agents, 800+
 * skills) with search, category filter, installed state and 1-click install
 * into ~/.claude (skip-if-exists).
 */

type Kind = 'agent' | 'skill';

const KIND_TABS: ReadonlyArray<{ value: Kind; label: string }> = [
  { value: 'agent', label: 'Agentes' },
  { value: 'skill', label: 'Instruções' },
];

type Notice = { tone: 'ok' | 'danger'; text: string };

export function MarketplaceSection() {
  const [kind, setKind] = useState<Kind>('agent');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [agents, setAgents] = useState<CatalogEntryInfo[]>([]);
  const [skills, setSkills] = useState<CatalogEntryInfo[]>([]);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function loadIndex(refresh = false) {
    setLoading(true);
    setError(null);
    const res = await window.nexus.orch.getCatalogIndex(refresh);
    setLoading(false);
    if (!res.ok || !res.index) {
      setError(res.error ?? 'catálogo indisponível');
      return;
    }
    setAgents(res.index.agents);
    setSkills(res.index.skills);
  }

  async function loadInstalled() {
    const items = await window.nexus.orch.listInstalledCatalog();
    setInstalledNames(new Set(items.map((item) => `${item.kind}:${item.name}`)));
  }

  useEffect(() => {
    void loadIndex();
    void loadInstalled();
  }, []);

  const entries = kind === 'agent' ? agents : skills;

  const categories = useMemo(
    () => [...new Set(entries.map((e) => e.category))].sort(),
    [entries],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => !category || e.category === category)
      .filter(
        (e) =>
          !q ||
          e.name.toLowerCase().includes(q) ||
          e.slug.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q),
      )
      .slice(0, 80);
  }, [entries, query, category]);

  const filtering = Boolean(query.trim() || category);

  function isInstalled(entry: CatalogEntryInfo): boolean {
    return installedNames.has(`${entry.kind}:${entry.name}`);
  }

  function resetFilters() {
    setQuery('');
    setCategory('');
  }

  async function install(entry: CatalogEntryInfo) {
    setBusySlug(entry.slug);
    setNotice(null);
    const res = await window.nexus.orch.installCatalogItem({
      kind: entry.kind,
      slug: entry.slug,
    });
    setBusySlug(null);
    if (!res.ok) {
      setNotice({
        tone: 'danger',
        text: `Não foi possível instalar ${entry.name}: ${res.error ?? 'falhou'}`,
      });
      return;
    }
    setNotice({
      tone: 'ok',
      text: res.skipped
        ? `${entry.name} já estava instalado`
        : `${entry.name} instalado em ${res.installed?.path ?? '~/.claude'}`,
    });
    await loadInstalled();
  }

  return (
    <section className="arsenal-section mkt-section" aria-label="Marketplace">
      <header className="arsenal-section__intro">
        <SettingsSectionTitle>Marketplace</SettingsSectionTitle>
        <p className="settings-detail__hint">
          Encontre agentes e instruções para suas ferramentas de IA no catálogo
          aitmpl. A instalação preserva os arquivos que você já possui.
        </p>
      </header>

      {!error && (
        <div className="arsenal-fleet" role="status">
          <span className="arsenal-fleet__stat">
            <strong>{loading ? '…' : agents.length}</strong> agentes
          </span>
          <span className="arsenal-fleet__sep" aria-hidden="true">
            ·
          </span>
          <span className="arsenal-fleet__stat">
            <strong>{loading ? '…' : skills.length}</strong> instruções
          </span>
          <span className="arsenal-fleet__sep" aria-hidden="true">
            ·
          </span>
          <span className="arsenal-fleet__stat">
            <strong>{installedNames.size}</strong> instalados nesta máquina
          </span>
        </div>
      )}

      <div className="mkt-toolbar">
        <div
          className="mkt__tabs"
          role="group"
          aria-label="Tipo de recurso"
        >
          {KIND_TABS.map((tab) => {
            const count = tab.value === 'agent' ? agents.length : skills.length;
            const active = kind === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                className={`mkt__tab${active ? ' mkt__tab--active' : ''}`}
                aria-pressed={active}
                onClick={() => {
                  setKind(tab.value);
                  setCategory('');
                }}
              >
                {tab.label}
                <span className="mkt__tab-count">{count}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="settings-btn mkt-toolbar__refresh"
          onClick={() => void loadIndex(true)}
          disabled={loading}
          title="Atualizar o cache do catálogo"
        >
          <PixelIcon name="refresh" size={11} /> Atualizar
        </button>
      </div>

      <div className="settings-row mkt-filters">
        <input
          className="settings-input"
          type="search"
          aria-label={`Buscar ${kind === 'agent' ? 'agentes' : 'instruções'}`}
          value={query}
          placeholder={`Buscar ${kind === 'agent' ? 'agentes' : 'instruções'}…`}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="settings-input settings-input--narrow"
          aria-label="Categoria"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Todas as categorias</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <p className="settings-detail__hint" role="status">
          Carregando catálogo…
        </p>
      )}
      {error && (
        <div className="mkt-notice mkt-notice--danger" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="settings-btn"
            onClick={() => void loadIndex(true)}
          >
            Tentar novamente
          </button>
        </div>
      )}
      {notice && (
        <p
          className={`mkt-notice mkt-notice--${notice.tone}`}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      {!error && (
        <ul className="settings-list mkt-list">
          {filtered.map((entry) => {
            const installed = isInstalled(entry);
            return (
              <li key={entry.slug} className="settings-list__item mkt-item">
                <div className="mkt-item__main">
                  <div className="mkt-item__id">
                    <span className="settings-list__title settings-list__title--mono">
                      {entry.name}
                    </span>
                    <span className="mkt-item__slug">{entry.slug}</span>
                  </div>
                  <div className="mkt-item__meta">
                    <span className="settings-chip">{entry.category}</span>
                    {installed ? (
                      <span className="settings-chip settings-chip--ok mkt-item__state">
                        <PixelIcon name="check" size={10} /> Instalado
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="settings-btn mkt-item__cta"
                        onClick={() => void install(entry)}
                        disabled={busySlug !== null}
                        aria-busy={busySlug === entry.slug}
                      >
                        {busySlug === entry.slug ? 'Instalando…' : 'Instalar'}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title="Nada encontrado"
          body={
            <p>
              {filtering
                ? 'Nenhum recurso corresponde à busca ou à categoria atual.'
                : 'O catálogo respondeu vazio.'}
            </p>
          }
          action={
            filtering ? (
              <button
                type="button"
                className="settings-btn"
                onClick={resetFilters}
              >
                Limpar filtros
              </button>
            ) : (
              <button
                type="button"
                className="settings-btn"
                onClick={() => void loadIndex(true)}
              >
                Atualizar catálogo
              </button>
            )
          }
        />
      )}
      {!loading && !error && filtered.length > 0 && (
        <p className="catalog-settings__count">
          {filtered.length} de {entries.length}{' '}
          {kind === 'agent' ? 'agentes' : 'instruções'}
        </p>
      )}
    </section>
  );
}
