import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../ActionCard';

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

type ImportState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; draftId: string; targetPath: string }
  | { status: 'error'; message: string };

export function DesignSystemsSection() {
  const [query, setQuery] = useState('');
  const [kits, setKits] = useState<Kit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imports, setImports] = useState<Record<string, ImportState>>({});

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

  async function importKit(slug: string, targetPath?: string) {
    setImports((prev) => ({ ...prev, [slug]: { status: 'loading' } }));
    const res = await window.nexus.orch.importDesignSystem({
      identifier: slug,
      ...(targetPath ? { targetPath } : {}),
    });
    setImports((prev) => ({
      ...prev,
      [slug]: res.ok
        ? {
            status: 'success',
            draftId: res.draftId,
            targetPath: res.targetPath,
          }
        : { status: 'error', message: res.error },
    }));
  }

  function importStatus(slug: string): ImportState {
    return imports[slug] ?? { status: 'idle' };
  }

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
        {filtered.map((kit) => {
          const state = importStatus(kit.slug);
          return (
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
              <div className="settings-row">
                <button
                  className="settings-btn"
                  onClick={() => void importKit(kit.slug)}
                  disabled={state.status === 'loading'}
                >
                  {state.status === 'loading' ? 'Importando…' : 'Importar'}
                </button>
                {state.status === 'success' && (
                  <span className="settings-chip settings-chip--ok">
                    Draft {state.draftId.slice(0, 8)} em {state.targetPath}
                  </span>
                )}
                {state.status === 'error' && (
                  <span className="settings-chip settings-chip--danger">
                    {state.message}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!loading && filtered.length === 0 && !error && (
        <EmptyState
          icon="grid"
          title="Nenhum kit encontrado"
          body={
            <p>
              Ajuste o filtro ou adicione um DESIGN.md / kit designmd no
              projeto.
            </p>
          }
        />
      )}
    </section>
  );
}
