import { useEffect, useMemo, useState } from 'react';

type Kit = {
  slug: string;
  name: string;
  description: string;
  author: string;
  url: string;
  tags: string[];
  license: string;
  downloadCount: number;
  likeCount: number;
};

export function DesignSystemsSection() {
  const [query, setQuery] = useState('');
  const [kits, setKits] = useState<Kit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(search = '') {
    setLoading(true);
    setError(null);
    const res = await window.nexus.orch.searchDesignSystems({
      query: search,
      limit: 50,
      sort: 'popular',
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error ?? 'designmd.ai unavailable');
      return;
    }
    setKits(res.kits);
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return kits;
    return kits.filter(
      (k) =>
        k.name.toLowerCase().includes(q) ||
        k.slug.toLowerCase().includes(q) ||
        k.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [kits, query]);

  return (
    <section>
      <h3 className="settings-detail__title">Design Systems</h3>
      <p className="settings-detail__hint">
        Catálogo público de DESIGN.md no designmd.ai. Kits importados viram
        ContextDrafts propostos para revisão independente.
      </p>

      <div className="settings-row">
        <input
          className="settings-input"
          value={query}
          placeholder="buscar kits…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(query);
          }}
        />
        <button
          className="settings-btn"
          onClick={() => void load(query)}
          disabled={loading}
        >
          {loading ? 'Buscando…' : 'Buscar'}
        </button>
      </div>

      {error && (
        <p className="settings-detail__hint">
          {error}{' '}
          <button className="settings-btn" onClick={() => void load(query)}>
            tentar de novo
          </button>
        </p>
      )}

      <ul className="settings-list">
        {filtered.map((kit) => (
          <li key={kit.slug} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title settings-list__title--mono">
                {kit.name}
              </span>
              <span className="settings-chip">{kit.license}</span>
              <span className="settings-chip settings-chip--ok">
                {kit.likeCount} likes
              </span>
            </div>
            <p className="settings-list__detail">{kit.description}</p>
            <p className="settings-list__detail">
              {kit.slug} · {kit.tags.join(' · ') || 'sem tags'}
            </p>
          </li>
        ))}
      </ul>
      {!loading && filtered.length === 0 && !error && (
        <p className="settings-detail__hint">Nenhum kit encontrado.</p>
      )}
    </section>
  );
}
