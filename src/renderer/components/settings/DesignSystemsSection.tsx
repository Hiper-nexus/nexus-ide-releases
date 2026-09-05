import { useEffect, useMemo, useState } from 'react';
import type { DesignSystemSourceId } from '../../../shared/surface-payload-types';
import { EmptyState } from '../ActionCard';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * designmd.ai needs `external:designmd-api-key`; without it the import walks
 * down to the keyless sources. The operator is told which one answered, so
 * "imported" is never an anonymous success.
 */
const SOURCE_LABELS: Record<DesignSystemSourceId, string> = {
  'designmd.ai': 'designmd.ai',
  'local-catalog': 'catálogo local (sem chave)',
  getdesign: 'catálogo aberto getdesign (sem chave)',
};

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
  | {
      status: 'success';
      draftId: string;
      targetPath: string;
      servedBy: DesignSystemSourceId;
    }
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
    try {
      const res = await window.nexus.orch.searchDesignSystems({
        query: search, limit: 50, sort: 'popular',
      });
      if (!res.ok) {
        setError('Não foi possível buscar referências. Tente novamente.');
        return;
      }
      setKits(res.kits);
    } catch {
      setError('Não foi possível buscar referências. Tente novamente.');
    } finally {
      setLoading(false);
    }
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
    try {
      const res = await window.nexus.orch.importDesignSystem({
        identifier: slug,
        ...(targetPath ? { targetPath } : {}),
      });
      setImports((prev) => ({
        ...prev,
        [slug]: res.ok
          ? { status: 'success', draftId: res.draftId, targetPath: res.targetPath, servedBy: res.servedBy }
          : { status: 'error', message: 'Não foi possível importar. Tente novamente.' },
      }));
    } catch {
      setImports((prev) => ({ ...prev,
        [slug]: { status: 'error', message: 'Não foi possível importar. Tente novamente.' },
      }));
    }
  }

  function importStatus(slug: string): ImportState {
    return imports[slug] ?? { status: 'idle' };
  }

  return (
    <section>
      <SettingsSectionTitle>Referências de design</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Encontre estilos para orientar cores, fontes e componentes das suas interfaces.
        A importação cria uma proposta para revisão antes de aplicar ao projeto.
      </p>

      <div className="settings-row">
        <input
          className="settings-input"
          value={query}
          placeholder="Buscar referências…"
          aria-label="Buscar referências de design"
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
        <p className="settings-detail__hint" role="alert">
          {error}{' '}
          <button className="settings-btn" onClick={() => void load(query)}>
            Tentar novamente
          </button>
        </p>
      )}

      {loading && <p className="settings-skeleton" role="status">Buscando referências…</p>}
      <ul className="settings-list">
        {filtered.map((kit) => {
          const state = importStatus(kit.slug);
          return (
            <li key={kit.slug} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">
                  {kit.name}
                </span>
                <span className="settings-chip">{kit.license}</span>
                <span className="settings-chip settings-chip--ok">
                  {kit.likeCount} curtidas
                </span>
              </div>
              <p className="settings-list__detail">{kit.description}</p>
              <details className="settings-advanced-field">
                <summary>Sobre a referência</summary>
                <p className="settings-list__detail">{kit.slug} · {kit.tags.join(' · ') || 'Sem categorias'}</p>
              </details>
              <div className="settings-row">
                <button
                  className="settings-btn"
                  onClick={() => void importKit(kit.slug)}
                  disabled={state.status === 'loading'}
                >
                  {state.status === 'loading' ? 'Importando…' : 'Importar referência'}
                </button>
                {state.status === 'success' && (
                  <>
                    <span className="settings-chip settings-chip--ok">
                      Proposta criada · aguardando revisão
                    </span>
                    <details className="settings-advanced-field">
                      <summary>Detalhes da importação</summary>
                      <p className="settings-list__detail">Fonte: {SOURCE_LABELS[state.servedBy]}</p>
                      <p className="settings-list__detail">Arquivo proposto: {state.targetPath}</p>
                      <p className="settings-list__detail">Proposta: {state.draftId}</p>
                    </details>
                  </>
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
          title="Nenhuma referência encontrada"
          body={
            <p>
              Tente outro nome ou estilo e selecione Buscar.
            </p>
          }
        />
      )}
    </section>
  );
}
