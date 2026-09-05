import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { EnrichedCatalogInfo, InstalledItemInfo } from '../../../shared/types';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { RecipesSection } from './CatalogSectionsOps';
import { buildHarnessInventory, filterHarnessInventory, type HarnessInventoryRow, type HarnessKindFilter, type HarnessTierFilter } from './harness-view-model';
import { AcpHarnessPanel } from './AcpHarnessPanel';
import { SettingsSectionTitle, SettingsSectionTitleProvider } from './SettingsSectionTitle';

type HarnessView = 'arsenal' | 'recipes' | 'acp';
const VIEWS: readonly { id: HarnessView; label: string }[] = [
  { id: 'arsenal', label: 'Recursos instalados' },
  { id: 'recipes', label: 'Fluxos prontos' },
  { id: 'acp', label: 'Conexão de agentes' },
];
const PURPOSES = [
  { id: 'scout', label: 'Investigar' },
  { id: 'builder', label: 'Implementar' },
  { id: 'reviewer', label: 'Revisar' },
  { id: 'pendente', label: 'Sem classificação' },
] as const;

function InventoryGroups({ rows }: { rows: readonly HarnessInventoryRow[] }) {
  return <div className="harness-settings__groups">
    {PURPOSES.map(purpose => {
      const group = rows.filter(row => (row.tier ?? 'pendente') === purpose.id);
      if (!group.length) return null;
      return <section key={purpose.id} aria-labelledby={`harness-purpose-${purpose.id}`}>
        <header className="harness-settings__group-heading">
          <h3 id={`harness-purpose-${purpose.id}`}>{purpose.label}</h3><span>{group.length}</span>
        </header>
        <ul className="harness-settings__inventory">
          {group.map(row => <li key={`${row.item.kind}:${row.item.file}`}>
            <div className="harness-settings__resource-name">
              <strong>{row.item.name}</strong>
              <span>{row.item.kind === 'agent' ? 'Agente' : 'Instruções (skill)'} · {row.origin}</span>
            </div>
            <div className="harness-settings__resource-description">
              <p>{row.blurb || 'Descrição ainda não adicionada.'}</p>
              <details>
                <summary>Detalhes do recurso</summary>
                {row.whenToUse && <p><strong>Quando usar:</strong> {row.whenToUse}</p>}
                <p className="harness-settings__file">{row.item.file}</p>
              </details>
            </div>
          </li>)}
        </ul>
      </section>;
    })}
  </div>;
}

export function HarnessSection() {
  const workspace = useWorkspaceStore(state => state.current);
  const mcpToolCount = useOrchStore(state => state.mcpInfo?.toolCount);
  const [view, setView] = useState<HarnessView>('arsenal');
  const [items, setItems] = useState<InstalledItemInfo[]>([]);
  const [enriched, setEnriched] = useState<EnrichedCatalogInfo | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<HarnessKindFilter>('todos');
  const [tier, setTier] = useState<HarnessTierFilter>('todos');
  const [origin, setOrigin] = useState('todas');
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<'load' | 'enrich'>('load');
  const loadSequence = useRef(0);

  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError(null); setFailedAction('load');
    const [installed, descriptions] = await Promise.allSettled([
      window.nexus.orch.listInstalledCatalog(), window.nexus.orch.harnessEnriched(),
    ]);
    if (sequence !== loadSequence.current) return;
    if (installed.status === 'fulfilled') setItems(installed.value);
    else setError('Não foi possível carregar os recursos instalados. Tente novamente.');
    if (descriptions.status === 'fulfilled') setEnriched(descriptions.value);
    else {
      setEnriched(null);
      if (installed.status === 'fulfilled') setError('Os recursos foram carregados, mas suas descrições não ficaram disponíveis.');
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    return () => { loadSequence.current += 1; };
  }, [reload]);

  const rows = useMemo(() => buildHarnessInventory(items, enriched), [items, enriched]);
  const origins = useMemo(() => [...new Set(rows.map(row => row.origin))].sort(), [rows]);
  const visible = useMemo(() => filterHarnessInventory(rows, { query, kind, tier, origin }), [rows, query, kind, tier, origin]);
  const annotatedCount = rows.filter(row => row.tier).length;
  const hasFilters = Boolean(query.trim() || kind !== 'todos' || tier !== 'todos' || origin !== 'todas');

  async function runEnrich() {
    if (enriching) return;
    setEnriching(true); setError(null); setFailedAction('enrich');
    try {
      const result = await window.nexus.orch.harnessEnrich();
      if (result.ok && result.catalog) setEnriched(result.catalog);
      else setError(result.error ?? 'Não foi possível gerar as descrições. Tente novamente.');
    } catch {
      setError('Não foi possível gerar as descrições. Tente novamente.');
    } finally { setEnriching(false); }
  }
  function clearFilters() { setQuery(''); setKind('todos'); setTier('todos'); setOrigin('todas'); }
  function navigateTab(event: KeyboardEvent<HTMLDivElement>) {
    const index = VIEWS.findIndex(item => item.id === view);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % VIEWS.length
        : event.key === 'ArrowLeft' ? (index + VIEWS.length - 1) % VIEWS.length : null;
    if (next === null) return;
    event.preventDefault(); setView(VIEWS[next].id);
    event.currentTarget.querySelector<HTMLButtonElement>(`#harness-tab-${VIEWS[next].id}`)?.focus();
  }

  return <section className="harness-settings">
    <header className="harness-settings__header">
      <SettingsSectionTitle>Recursos e conexão dos agentes</SettingsSectionTitle>
      <p>Confira as instruções instaladas, encontre fluxos de trabalho e escolha como conectar agentes ao Nexus.</p>
    </header>
    <div className="harness-settings__tabs" role="tablist" aria-label="Seções de Harness" onKeyDown={navigateTab}>
      {VIEWS.map(item => <button key={item.id} id={`harness-tab-${item.id}`} type="button" role="tab"
        aria-selected={view === item.id} aria-controls="harness-panel" tabIndex={view === item.id ? 0 : -1}
        onClick={() => setView(item.id)}>{item.label}</button>)}
    </div>
    <div id="harness-panel" role="tabpanel" aria-labelledby={`harness-tab-${view}`}>
      {view === 'acp' ? <AcpHarnessPanel /> : view === 'recipes' ? <SettingsSectionTitleProvider level={3}><RecipesSection /></SettingsSectionTitleProvider> : <>
        <div className="harness-settings__inventory-heading">
          <div><h3>Seu catálogo local</h3><p>Agentes e skills são instruções disponíveis para as ferramentas de IA. A classificação abaixo descreve sua finalidade.</p></div>
          <button type="button" className="settings-btn" disabled={loading || enriching} onClick={() => void reload()}>{loading ? 'Carregando…' : 'Atualizar lista'}</button>
        </div>
        <div className="harness-settings__filters">
          <label className="harness-settings__search">Buscar recursos<input className="settings-input" aria-label="Buscar recursos" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nome ou descrição" /></label>
          <label>Tipo<select className="settings-input" aria-label="Tipo de recurso" value={kind} onChange={event => setKind(event.target.value as HarnessKindFilter)}><option value="todos">Todos os tipos</option><option value="agent">Agentes</option><option value="skill">Instruções (skills)</option></select></label>
          <label>Função<select className="settings-input" aria-label="Função do recurso" value={tier} onChange={event => setTier(event.target.value as HarnessTierFilter)}><option value="todos">Todas as funções</option>{PURPOSES.map(purpose => <option key={purpose.id} value={purpose.id}>{purpose.label}</option>)}</select></label>
          {origins.length > 1 && <label>Origem<select className="settings-input" aria-label="Origem do recurso" value={origin} onChange={event => setOrigin(event.target.value)}><option value="todas">Todas as origens</option>{origins.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        </div>
        {error && <div className="harness-settings__error" role="alert"><p>{error}</p><button type="button" className="settings-btn" disabled={loading || enriching} onClick={() => failedAction === 'enrich' ? void runEnrich() : void reload()}>Tentar novamente</button></div>}
        {loading ? <div className="harness-settings__loading" role="status">Carregando recursos instalados…</div> : visible.length > 0 ? <InventoryGroups rows={visible} /> : !error && <div className="harness-settings__empty" role="status">
          <h3>{hasFilters ? 'Nenhum recurso corresponde aos filtros' : 'Nenhum recurso instalado'}</h3>
          <p>{hasFilters ? 'Tente outro nome ou remova os filtros para ver o catálogo completo.' : 'Adicione agentes ou skills pelo Marketplace para usá-los nas suas ferramentas de IA.'}</p>
          <button type="button" className="settings-btn" onClick={() => hasFilters ? clearFilters() : useProductNavigationStore.getState().openSettings('marketplace')}>{hasFilters ? 'Limpar filtros' : 'Abrir Marketplace'}</button>
        </div>}
        {!loading && <p className="harness-settings__count">{visible.length} de {rows.length} recursos · {workspace?.name ?? 'Catálogo desta máquina'}</p>}
        <details className="harness-settings__advanced">
          <summary>Descrições e classificação com IA</summary>
          <p>{annotatedCount} de {rows.length} recursos têm classificação. Gerar descrições organiza o catálogo; não executa os recursos nem altera permissões.</p>
          <button type="button" className="settings-btn" disabled={enriching || loading || rows.length === 0} onClick={() => void runEnrich()}>{enriching ? 'Gerando descrições…' : 'Gerar descrições com IA'}</button>
        </details>
        <div className="harness-settings__mcp"><p>{mcpToolCount === undefined ? 'O catálogo de ferramentas MCP ainda não foi carregado.' : `${mcpToolCount} ferramentas MCP no catálogo do Nexus.`} Configure as integrações e suas permissões na página de conexões.</p><button type="button" className="settings-btn" onClick={() => useProductNavigationStore.getState().openSettings('mcps')}>Configurar conexões MCP</button></div>
      </>}
    </div>
  </section>;
}
