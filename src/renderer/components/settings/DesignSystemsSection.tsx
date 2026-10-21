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
  const [designmdKey, setDesignmdKey] = useState('');
  const [keyState, setKeyState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  /**
   * designmd.ai answers 401 on its body endpoint without a key, and until now
   * nothing in the app could store one — the vault was read for
   * `external:designmd-api-key` and never written, so that source was
   * unreachable in any shipped build. The keyless sources still answer without
   * it, which is why this is an optional unlock and not a gate.
   */
  async function saveDesignmdKey(value: string) {
    setKeyState('saving');
    try {
      const result = await window.nexus.uiKit.setExternalKey({
        id: 'designmd',
        value,
      });
      setKeyState(result.error ? 'error' : 'saved');
      if (!result.error) setDesignmdKey('');
      // `value: ''` is how the contract clears the credential; without a
      // control that sends it, a stored key could never be revoked from here.
    } catch {
      setKeyState('error');
    }
  }

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
    <section className="arsenal-section dsn-section" aria-label="Referências de design">
      <header className="arsenal-section__intro">
        <SettingsSectionTitle>Referências de design</SettingsSectionTitle>
        <p className="settings-detail__hint">
          Encontre estilos para orientar cores, fontes e componentes das suas interfaces.
          A importação cria uma proposta para revisão antes de aplicar ao projeto.
        </p>
      </header>

      <div className="settings-row">
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          value={designmdKey}
          placeholder="Chave da designmd.ai (opcional)"
          aria-label="Chave da API da designmd.ai"
          onChange={(e) => {
            setDesignmdKey(e.target.value);
            setKeyState('idle');
          }}
        />
        <button
          type="button"
          className="settings-btn"
          disabled={keyState === 'saving' || designmdKey.trim().length === 0}
          onClick={() => void saveDesignmdKey(designmdKey.trim())}
        >
          {keyState === 'saving' ? 'Salvando…' : 'Salvar chave'}
        </button>
        <button
          type="button"
          className="settings-btn"
          disabled={keyState === 'saving'}
          onClick={() => void saveDesignmdKey('')}
        >
          Remover
        </button>
        {keyState === 'saved' && (
          <span className="settings-chip settings-chip--ok">
            {designmdKey.trim() ? 'chave guardada' : 'chave removida'}
          </span>
        )}
        {keyState === 'error' && (
          <span className="settings-chip">não foi possível guardar</span>
        )}
      </div>
      <p className="settings-help">
        Os catálogos sem chave (local e getdesign) respondem sem isso. A chave
        só libera o corpo do DESIGN.md da designmd.ai, que responde 401 sem ela.
      </p>

      <div className="settings-row dsn-search" role="search">
        <input
          className="settings-input"
          type="search"
          value={query}
          placeholder="Buscar referências…"
          aria-label="Buscar referências de design"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(query);
          }}
        />
        <button
          type="button"
          className="settings-btn"
          onClick={() => void load(query)}
          disabled={loading}
        >
          {loading ? 'Buscando…' : 'Buscar'}
        </button>
      </div>

      {error && (
        <div className="mkt-notice mkt-notice--danger" role="alert">
          <p>{error}</p>
          <button type="button" className="settings-btn" onClick={() => void load(query)}>
            Tentar novamente
          </button>
        </div>
      )}

      {loading && (
        <div
          className="settings-skeleton"
          role="status"
          aria-label="Buscando referências…"
        >
          <span /><span /><span />
        </div>
      )}
      <ul className="settings-list dsn-list">
        {filtered.map((kit) => {
          const state = importStatus(kit.slug);
          return (
            <li key={kit.slug} className="settings-list__item dsn-item">
              <div className="settings-list__head">
                <span className="settings-list__title">
                  {kit.name}
                </span>
                <span className="settings-chip">{kit.license}</span>
                {state.status === 'loading' && (
                  <span className="settings-chip">Importando…</span>
                )}
                {state.status === 'success' && (
                  <span className="settings-chip settings-chip--ok">
                    Proposta criada · aguardando revisão
                  </span>
                )}
              </div>
              <p className="settings-list__detail">{kit.description}</p>
              <p className="dsn-item__meta">
                {kit.author ? `${kit.author} · ` : ''}
                {kit.downloadCount}{' '}
                {kit.downloadCount === 1 ? 'download' : 'downloads'} ·{' '}
                {kit.likeCount}{' '}
                {kit.likeCount === 1 ? 'curtida' : 'curtidas'}
              </p>
              <details className="settings-advanced-field dsn-item__details">
                <summary>Sobre a referência</summary>
                <p className="settings-list__detail">{kit.slug} · {kit.tags.join(' · ') || 'Sem categorias'}</p>
                {kit.url && (
                  <p className="settings-list__detail">
                    Fonte: <code>{kit.url}</code>
                  </p>
                )}
              </details>
              <div className="settings-row dsn-item__actions">
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void importKit(kit.slug)}
                  disabled={state.status === 'loading'}
                  aria-busy={state.status === 'loading'}
                >
                  {state.status === 'loading'
                    ? 'Importando…'
                    : state.status === 'success'
                      ? 'Importar novamente'
                      : 'Importar referência'}
                </button>
                {state.status === 'error' && (
                  <p className="settings-error dsn-item__error" role="alert">
                    {state.message}
                  </p>
                )}
              </div>
              {state.status === 'success' && (
                <div className="dsn-proposal" role="status">
                  <p className="dsn-proposal__note">
                    Estado: proposta — ainda não é o contrato do projeto.
                  </p>
                  <details className="settings-advanced-field dsn-item__details">
                    <summary>Detalhes da importação</summary>
                    <p className="settings-list__detail">Fonte: {SOURCE_LABELS[state.servedBy]}</p>
                    <p className="settings-list__detail">Arquivo proposto: {state.targetPath}</p>
                    <p className="settings-list__detail">Proposta: {state.draftId}</p>
                  </details>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!loading && kits.length > 0 && (
        <p className="catalog-settings__count">
          {filtered.length} de {kits.length} referências
        </p>
      )}
      {!loading && filtered.length === 0 && !error && (
        <EmptyState
          icon="grid"
          title="Nenhuma referência encontrada"
          body={
            <p>
              {query.trim()
                ? 'Nenhuma referência corresponde à busca atual.'
                : 'O catálogo de referências respondeu vazio.'}
            </p>
          }
          action={
            query.trim() ? (
              <button
                type="button"
                className="settings-btn"
                onClick={() => {
                  setQuery('');
                  void load('');
                }}
              >
                Limpar busca
              </button>
            ) : (
              <button
                type="button"
                className="settings-btn"
                onClick={() => void load('')}
              >
                Buscar novamente
              </button>
            )
          }
        />
      )}
    </section>
  );
}
