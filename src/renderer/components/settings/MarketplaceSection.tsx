import { useEffect, useMemo, useState } from 'react';
import type {
  CatalogEntryInfo,
  CatalogRecommendationsResult,
} from '../../../shared/types';
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

/** Itens por página: a busca e a categoria sempre varrem o catálogo inteiro. */
export const MARKETPLACE_PAGE_SIZE = 12;

const RECOMMENDATION_UNAVAILABLE: Record<
  NonNullable<CatalogRecommendationsResult['reason']>,
  string
> = {
  disabled:
    'As recomendações estão desligadas em Orquestração, entre as superfícies supervisionadas pelos modelos de decisão.',
  'no-credential':
    'Para recomendar, o Nexus precisa do Jev ou do Clef configurado em Chaves de API.',
  'no-areas':
    'Não reconheci a stack deste projeto pelos arquivos (package.json, go.mod, Dockerfile…).',
  'catalog-unavailable': 'O catálogo não carregou. Use Atualizar e tente de novo.',
  'no-answer': 'O modelo de decisão não respondeu agora. Tente Recalcular.',
};

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
}

function recommendationIntro(
  result: CatalogRecommendationsResult | null,
  loading: boolean,
): string {
  if (loading) return 'Lendo a stack do projeto e consultando o modelo de decisão…';
  if (!result) return '';
  if (!result.ok) return RECOMMENDATION_UNAVAILABLE[result.reason ?? 'no-answer'];
  const stack = joinLabels((result.areas ?? []).map((area) => area.label));
  if ((result.recommendations ?? []).length === 0) {
    return `Nenhum item do catálogo se destacou para ${stack}.`;
  }
  const decider =
    result.provider === 'clef' ? 'Clef' : result.provider === 'jev' ? 'Jev' : 'modelo de decisão';
  return (
    `Escolhidos pelo ${decider} para a stack do projeto (${stack}). ` +
    'Instalar pede a mesma confirmação de sempre.'
  );
}

/**
 * F-757: o que o modelo de decisão escolheu do catálogo para a stack deste
 * workspace, com o motivo. Instalar usa o mesmo fluxo da lista abaixo.
 */
function MarketplaceRecommendations(props: {
  result: CatalogRecommendationsResult | null;
  loading: boolean;
  busySlug: string | null;
  isInstalled: (entry: CatalogEntryInfo) => boolean;
  onInstall: (entry: CatalogEntryInfo) => void;
  onRefresh: () => void;
}) {
  const { result, loading, busySlug, isInstalled, onInstall, onRefresh } = props;
  const recommendations = !loading && result?.ok ? result.recommendations ?? [] : [];
  return (
    <section className="mkt-recs" aria-label="Recomendados para este projeto">
      <div className="mkt-recs__head">
        <div className="mkt-recs__intro">
          <h3 className="mkt-recs__title">Recomendados para este projeto</h3>
          <p className="settings-detail__hint" role="status">
            {recommendationIntro(result, loading)}
          </p>
        </div>
        <button
          type="button"
          className="settings-btn"
          onClick={onRefresh}
          disabled={loading}
          title="Ler a stack de novo e pedir outra recomendação"
        >
          <PixelIcon name="refresh" size={11} /> Recalcular
        </button>
      </div>
      {recommendations.length > 0 && (
        <ul className="settings-list mkt-list">
          {recommendations.map((rec) => {
            const entry: CatalogEntryInfo = {
              kind: rec.kind,
              slug: rec.slug,
              name: rec.name,
              category: rec.category,
            };
            const installed = isInstalled(entry);
            return (
              <li key={`${rec.kind}:${rec.slug}`} className="settings-list__item mkt-rec">
                <div className="mkt-item__main">
                  <div className="mkt-item__id">
                    <span className="settings-list__title settings-list__title--mono mkt-rec__name">
                      {rec.name}
                    </span>
                    <span className="mkt-rec__why">
                      {rec.kind === 'agent' ? 'Agente' : 'Instrução'} para{' '}
                      {joinLabels(rec.areas)} · visto em {rec.evidence[0]}
                    </span>
                  </div>
                  <div className="mkt-item__meta">
                    <span
                      className="settings-chip"
                      title="Confiança do modelo de decisão nesta escolha"
                    >
                      {Math.round(rec.confidence * 100)}%
                    </span>
                    {installed ? (
                      <span className="settings-chip settings-chip--ok mkt-item__state">
                        <PixelIcon name="check" size={10} /> Instalado
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="settings-btn mkt-item__cta"
                        onClick={() => onInstall(entry)}
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
    </section>
  );
}

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
  const [recommendations, setRecommendations] = useState<CatalogRecommendationsResult | null>(null);
  const [recommending, setRecommending] = useState(false);
  const canRecommend = typeof window.nexus.orch.recommendCatalog === 'function';
  // Página ligada ao filtro atual: trocar tipo, busca ou categoria volta à 1ª.
  const filterKey = `${kind}|${query}|${category}`;
  const [page, setPage] = useState({ key: filterKey, count: MARKETPLACE_PAGE_SIZE });
  const visibleCount = page.key === filterKey ? page.count : MARKETPLACE_PAGE_SIZE;

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

  async function loadRecommendations(refresh = false) {
    if (!canRecommend) return;
    setRecommending(true);
    try {
      setRecommendations(await window.nexus.orch.recommendCatalog(refresh));
    } catch {
      setRecommendations({ ok: false, reason: 'no-answer' });
    } finally {
      setRecommending(false);
    }
  }

  useEffect(() => {
    void loadIndex();
    void loadInstalled();
    void loadRecommendations();
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
      );
  }, [entries, query, category]);

  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;
  const noun = kind === 'agent' ? 'agentes' : 'instruções';

  function showMore() {
    setPage({ key: filterKey, count: visibleCount + MARKETPLACE_PAGE_SIZE });
  }

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

      {canRecommend && (
        <MarketplaceRecommendations
          result={recommendations}
          loading={recommending}
          busySlug={busySlug}
          isInstalled={isInstalled}
          onInstall={(entry) => void install(entry)}
          onRefresh={() => void loadRecommendations(true)}
        />
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
          {visible.map((entry) => {
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
        <div className="mkt-more">
          <p className="catalog-settings__count">
            {visible.length} de {filtered.length} {noun}
            {filtering && filtered.length < entries.length
              ? ` (${entries.length} no catálogo)`
              : ''}
          </p>
          {remaining > 0 && (
            <button type="button" className="settings-btn" onClick={showMore}>
              Mostrar mais ({remaining})
            </button>
          )}
        </div>
      )}
    </section>
  );
}
