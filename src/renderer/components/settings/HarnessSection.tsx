import { useEffect, useMemo, useState } from 'react';
import type {
  EnrichedCatalogInfo,
  InstalledItemInfo,
} from '../../../shared/types';
import { useOrchStore } from '../../state/orch-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { PixelIcon } from '../PixelIcon';
import { EmptyState } from '../ActionCard';
import { RecipesSection } from './CatalogSectionsOps';
import {
  buildHarnessInventory,
  filterHarnessInventory,
  type HarnessKindFilter,
  type HarnessTierFilter,
} from './harness-view-model';

type HarnessView = 'arsenal' | 'recipes';

const TIER_FILTERS: HarnessTierFilter[] = [
  'todos',
  'scout',
  'builder',
  'reviewer',
  'pendente',
];

export function HarnessSection() {
  const workspace = useWorkspaceStore((state) => state.current);
  const mcpToolCount = useOrchStore((state) => state.mcpInfo?.toolCount ?? 0);
  const [view, setView] = useState<HarnessView>('arsenal');
  const [items, setItems] = useState<InstalledItemInfo[]>([]);
  const [enriched, setEnriched] = useState<EnrichedCatalogInfo | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<HarnessKindFilter>('todos');
  const [tier, setTier] = useState<HarnessTierFilter>('todos');
  const [origin, setOrigin] = useState('todas');
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.nexus.orch.listInstalledCatalog(),
      window.nexus.orch.harnessEnriched(),
    ])
      .then(([installed, catalog]) => {
        if (cancelled) return;
        setItems(installed);
        setEnriched(catalog);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(
    () => buildHarnessInventory(items, enriched),
    [items, enriched],
  );
  const origins = useMemo(
    () => [...new Set(rows.map((row) => row.origin))].sort(),
    [rows],
  );
  const visible = useMemo(
    () => filterHarnessInventory(rows, { query, kind, tier, origin }),
    [rows, query, kind, tier, origin],
  );
  const agentCount = rows.filter((row) => row.item.kind === 'agent').length;
  const skillCount = rows.filter((row) => row.item.kind === 'skill').length;
  const annotatedCount = rows.filter((row) => row.tier).length;
  const coverage = rows.length ? Math.round((annotatedCount / rows.length) * 100) : 0;

  async function runEnrich() {
    if (enriching) return;
    setEnriching(true);
    setError(null);
    try {
      const result = await window.nexus.orch.harnessEnrich();
      if (!result.ok || !result.catalog) {
        setError(result.error ?? 'enriquecimento falhou');
        return;
      }
      setEnriched(result.catalog);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEnriching(false);
    }
  }

  return (
    <section className="harness-hub">
      <header className="harness-hub__intro">
        <div>
          <p className="settings-detail__hint">CAPABILITY HARNESS</p>
          <h3 className="settings-detail__title">Tarefa certa, capacidade real</h3>
          <p className="settings-detail__hint">
            Inventário unificado do Nexus. O enriquecimento organiza o que está
            instalado; recipes e squads continuam sendo contratos executáveis.
          </p>
        </div>
        <button
          className="settings-btn"
          onClick={() => void runEnrich()}
          disabled={enriching || rows.length === 0}
        >
          <PixelIcon name="sparkle" />
          {enriching ? 'Enriquecendo…' : 'Enriquecer arsenal'}
        </button>
      </header>

      <div className="harness-hub__metrics" aria-label="Resumo do harness">
        {[
          ['Agents', agentCount],
          ['Skills', skillCount],
          ['Tools MCP', mcpToolCount],
          ['Cobertura', `${coverage}%`],
        ].map(([label, value]) => (
          <div className="harness-hub__metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="harness-hub__tabs" role="tablist" aria-label="Harness">
        <button
          className={view === 'arsenal' ? 'is-active' : ''}
          onClick={() => setView('arsenal')}
          role="tab"
          aria-selected={view === 'arsenal'}
        >
          Arsenal
        </button>
        <button
          className={view === 'recipes' ? 'is-active' : ''}
          onClick={() => setView('recipes')}
          role="tab"
          aria-selected={view === 'recipes'}
        >
          Recipes
        </button>
      </div>

      {view === 'recipes' ? (
        <RecipesSection />
      ) : (
        <>
          <div className="harness-hub__filters">
            <label className="harness-hub__search">
              <PixelIcon name="search" size={11} />
              <input
                className="settings-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="buscar por nome, papel ou quando usar…"
              />
            </label>
            <div className="settings-pill-row" aria-label="Tipo">
              {(['todos', 'agent', 'skill'] as HarnessKindFilter[]).map((value) => (
                <button
                  key={value}
                  className={`settings-chip ${kind === value ? 'settings-chip--ok' : ''}`}
                  onClick={() => setKind(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="settings-pill-row" aria-label="Tier">
              {TIER_FILTERS.map((value) => (
                <button
                  key={value}
                  className={`settings-chip ${tier === value ? 'settings-chip--ok' : ''}`}
                  onClick={() => setTier(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            {origins.length > 1 && (
              <label className="harness-hub__origin">
                origem
                <select
                  className="agent-picker__select"
                  value={origin}
                  onChange={(event) => setOrigin(event.target.value)}
                >
                  <option value="todas">todas</option>
                  {origins.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {error && <p className="settings-detail__hint">✗ {error}</p>}
          {visible.length === 0 ? (
            <EmptyState
              icon="sparkle"
              title="Nenhuma capacidade encontrada"
              body={<p>Ajuste os filtros ou instale agents e skills no Marketplace.</p>}
            />
          ) : (
            <ul className="settings-list harness-hub__inventory">
              {visible.map((row) => (
                <li className="settings-list__item" key={`${row.item.kind}:${row.item.file}`}>
                  <div className="settings-list__head">
                    <span className="settings-list__title">{row.item.name}</span>
                    {row.tier ? (
                      <span className="settings-chip settings-chip--ok">{row.tier}</span>
                    ) : (
                      <span className="settings-chip settings-chip--warn">pendente</span>
                    )}
                    <span className="settings-chip">{row.item.kind}</span>
                    <span className="settings-chip">{row.origin}</span>
                  </div>
                  {row.blurb && <p className="settings-list__detail">{row.blurb}</p>}
                  {row.whenToUse && (
                    <p className="settings-list__detail">
                      <strong>Quando usar:</strong> {row.whenToUse}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="settings-detail__hint harness-hub__foot">
            {visible.length} de {rows.length} capacidades · workspace{' '}
            {workspace?.name ?? 'global'}
          </p>
        </>
      )}
    </section>
  );
}
