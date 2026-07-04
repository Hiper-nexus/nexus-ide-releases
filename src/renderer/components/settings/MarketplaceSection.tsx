import { useEffect, useMemo, useState } from 'react';
import type { CatalogEntryInfo } from '../../../shared/types';

/**
 * Marketplace — the catalog surface: the full
 * browsable aitmpl index (davila7/claude-code-templates; 400+ agents, 800+
 * skills) with search, category filter, installed state and 1-click install
 * into ~/.claude (skip-if-exists).
 */

type Kind = 'agent' | 'skill';

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
  const [notice, setNotice] = useState<string | null>(null);

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

  function isInstalled(entry: CatalogEntryInfo): boolean {
    return installedNames.has(`${entry.kind}:${entry.name}`);
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
      setNotice(`✗ ${entry.name}: ${res.error ?? 'falhou'}`);
      return;
    }
    setNotice(
      res.skipped
        ? `✓ ${entry.name} já estava instalado`
        : `✓ ${entry.name} instalado em ${res.installed?.path ?? '~/.claude'}`,
    );
    await loadInstalled();
  }

  return (
    <section>
      <h3 className="settings-detail__title">Marketplace</h3>
      <p className="settings-detail__hint">
        Catálogo aitmpl (davila7/claude-code-templates): {agents.length} agents
        · {skills.length} skills. Instalação em 1 clique para ~/.claude
        (agents/.md, skills/pasta), pulando o que já
        existe.
      </p>

      <div className="settings-row">
        <div className="mkt__tabs">
          {(['agent', 'skill'] as Kind[]).map((k) => (
            <button
              key={k}
              className={`settings-btn ${kind === k ? 'settings-btn--primary' : ''}`}
              onClick={() => {
                setKind(k);
                setCategory('');
              }}
            >
              {k === 'agent' ? `Agents (${agents.length})` : `Skills (${skills.length})`}
            </button>
          ))}
        </div>
        <button
          className="settings-btn"
          onClick={() => void loadIndex(true)}
          disabled={loading}
          title="Atualizar o cache do catálogo"
        >
          ⟳
        </button>
      </div>

      <div className="settings-row">
        <input
          className="settings-input"
          value={query}
          placeholder={`buscar ${kind === 'agent' ? 'agents' : 'skills'}…`}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="settings-input settings-input--narrow"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">todas categorias</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="settings-detail__hint">Carregando catálogo…</p>}
      {error && (
        <p className="settings-detail__hint">
          {error}{' '}
          <button className="settings-btn" onClick={() => void loadIndex(true)}>
            tentar de novo
          </button>
        </p>
      )}
      {notice && <p className="settings-detail__hint">{notice}</p>}

      <ul className="settings-list">
        {filtered.map((entry) => (
          <li key={entry.slug} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title settings-list__title--mono">
                {entry.name}
              </span>
              <span className="settings-chip">{entry.category}</span>
              {isInstalled(entry) ? (
                <span className="settings-chip settings-chip--ok">instalado</span>
              ) : (
                <button
                  className="settings-btn"
                  onClick={() => void install(entry)}
                  disabled={busySlug !== null}
                >
                  {busySlug === entry.slug ? 'Instalando…' : 'Instalar'}
                </button>
              )}
            </div>
            <p className="settings-list__detail">{entry.slug}</p>
          </li>
        ))}
      </ul>
      {!loading && filtered.length === 0 && !error && (
        <p className="settings-detail__hint">Nada encontrado para o filtro.</p>
      )}
    </section>
  );
}
