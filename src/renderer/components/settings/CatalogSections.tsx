import { useEffect, useState } from 'react';
import type {
  AdapterInfo,
  EnrichedCatalogInfo,
  HarnessTier,
  InstalledItemInfo,
  NativeToolInfo,
} from '../../../shared/types';
import type { MediaProviderInfo } from '../../../shared/media-types';
import { useOrchStore } from '../../state/orch-store';
import { PixelIcon } from '../PixelIcon';
import { ActionCard, EmptyState } from '../ActionCard';
import {
  catalogEmptyCta,
  catalogEmptyKindFromMessage,
  catalogInstallableEmptyMessage,
} from '../empty-cta-policy';
import { useSettingsStore } from '../../state/settings-store';

/**
 * CATALOG sections: locally installed components (agents/skills), the
 * embedded MCP server, native tools, plugin files, generated lifecycle hooks,
 * permission rules (skill-gate allowlists) and keyboard shortcuts.
 */

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleString();
}

function useInstalledCatalog(kind: string): InstalledItemInfo[] {
  const [items, setItems] = useState<InstalledItemInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.nexus.orch.listInstalledCatalog().then((all) => {
      if (!cancelled) setItems(all.filter((item) => item.kind === kind));
    });
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return items;
}

const TIER_FILTERS: Array<HarnessTier | 'todos'> = [
  'todos',
  'scout',
  'builder',
  'reviewer',
];

/**
 * Arsenal enriquecido (harness-enrich): anotações tier/blurb por item + a
 * ação "Enriquecer" que roda a passada de LLM sobre o arsenal instalado.
 */
function useEnrichedCatalog(): {
  enriched: EnrichedCatalogInfo | null;
  enriching: boolean;
  error: string | null;
  runEnrich(): void;
} {
  const [enriched, setEnriched] = useState<EnrichedCatalogInfo | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.nexus.orch.harnessEnriched().then((cat) => {
      if (!cancelled) setEnriched(cat);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  function runEnrich() {
    if (enriching) return;
    setEnriching(true);
    setError(null);
    void window.nexus.orch.harnessEnrich().then((res) => {
      setEnriching(false);
      if (res.ok && res.catalog) setEnriched(res.catalog);
      else setError(res.error ?? 'enriquecimento falhou');
    });
  }
  return { enriched, enriching, error, runEnrich };
}

function EnrichBar({
  enriched,
  enriching,
  error,
  runEnrich,
  tier,
  onTier,
}: {
  enriched: EnrichedCatalogInfo | null;
  enriching: boolean;
  error: string | null;
  runEnrich(): void;
  tier: HarnessTier | 'todos';
  onTier(t: HarnessTier | 'todos'): void;
}) {
  return (
    <div className="settings-enrich">
      <div className="settings-enrich__row">
        <button
          className="settings-btn"
          onClick={runEnrich}
          disabled={enriching}
          title="O LLM organiza o arsenal e anota papel + quando/como usar"
        >
          <PixelIcon name="sparkle" />
          {enriching ? 'Enriquecendo…' : 'Enriquecer'}
        </button>
        {enriched && (
          <span className="settings-detail__hint">
            {enriched.items.length} itens anotados ·{' '}
            {timeLabel(enriched.updatedAt)}
          </span>
        )}
      </div>
      {enriched && enriched.items.length > 0 && (
        <div className="settings-enrich__filters">
          <span className="settings-detail__hint">TIER</span>
          {TIER_FILTERS.map((t) => (
            <button
              key={t}
              className={`settings-chip ${tier === t ? 'settings-chip--ok' : ''}`}
              onClick={() => onTier(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {error && <p className="settings-detail__hint">✗ {error}</p>}
    </div>
  );
}

function enrichmentOf(
  enriched: EnrichedCatalogInfo | null,
  kind: 'agent' | 'skill',
  name: string,
) {
  return enriched?.items.find((i) => i.kind === kind && i.name === name);
}

function InstalledList({
  items,
  empty,
  enriched,
  kind,
}: {
  items: InstalledItemInfo[];
  empty: string;
  enriched?: EnrichedCatalogInfo | null;
  kind?: 'agent' | 'skill';
}) {
  if (items.length === 0) {
    const cta = catalogEmptyCta(catalogEmptyKindFromMessage(empty));
    return (
      <EmptyState
        icon="sparkle"
        title="Nada para mostrar"
        body={<p>{empty}</p>}
        action={
          cta === 'marketplace' ? (
            <ActionCard
              icon="star"
              title="Abrir Marketplace"
              subtitle="Instalar agents e skills"
              variant="primary"
              size="sm"
              onClick={() =>
                useSettingsStore.getState().openDrawer('marketplace')
              }
            />
          ) : undefined
        }
      />
    );
  }
  return (
    <ul className="settings-list">
      {items.map((item) => {
        const note = kind ? enrichmentOf(enriched ?? null, kind, item.name) : undefined;
        return (
          <li key={item.file} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title">{item.name}</span>
              {note && <span className="settings-chip settings-chip--ok">{note.tier}</span>}
              <span className="settings-chip">{item.kind}</span>
            </div>
            {note && (
              <p className="settings-list__detail">
                {note.blurb}
                {note.whenToUse ? ` — quando: ${note.whenToUse}` : ''}
              </p>
            )}
            <p className="settings-list__detail">
              {item.file} · {timeLabel(item.modifiedAt)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function tierFiltered(
  items: InstalledItemInfo[],
  enriched: EnrichedCatalogInfo | null,
  kind: 'agent' | 'skill',
  tier: HarnessTier | 'todos',
): InstalledItemInfo[] {
  if (tier === 'todos') return items;
  return items.filter(
    (item) => enrichmentOf(enriched, kind, item.name)?.tier === tier,
  );
}

export function AgentsSection() {
  const items = useInstalledCatalog('agent');
  const squadAgents = useOrchStore((s) =>
    s.squads.reduce((count, squad) => count + squad.agents.length, 0),
  );
  const enrich = useEnrichedCatalog();
  const [tier, setTier] = useState<HarnessTier | 'todos'>('todos');
  const visible = tierFiltered(items, enrich.enriched, 'agent', tier);
  return (
    <section>
      <h3 className="settings-detail__title">Agents</h3>
      <p className="settings-detail__hint">
        AI subagents instalados do catálogo ({items.length}) + {squadAgents}{' '}
        agente(s) definidos em squads.
      </p>
      <EnrichBar {...enrich} tier={tier} onTier={setTier} />
      <InstalledList
        items={visible}
        empty={catalogInstallableEmptyMessage('agent', items.length, tier)}
        enriched={enrich.enriched}
        kind="agent"
      />
    </section>
  );
}

export function SkillsSection() {
  const items = useInstalledCatalog('skill');
  const enrich = useEnrichedCatalog();
  const [tier, setTier] = useState<HarnessTier | 'todos'>('todos');
  const visible = tierFiltered(items, enrich.enriched, 'skill', tier);
  return (
    <section>
      <h3 className="settings-detail__title">Skills</h3>
      <p className="settings-detail__hint">
        Cache local de skills instaladas do catálogo ({items.length}).
      </p>
      <EnrichBar {...enrich} tier={tier} onTier={setTier} />
      <InstalledList
        items={visible}
        empty={catalogInstallableEmptyMessage('skill', items.length, tier)}
        enriched={enrich.enriched}
        kind="skill"
      />
    </section>
  );
}

/** Faixa MÍDIA do arsenal: modelos de geração habilitados (key presente). */
export function MediaCatalogSection() {
  const [providers, setProviders] = useState<MediaProviderInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.nexus.media.listProviders().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const enabled = providers.filter((p) => p.hasKey);
  return (
    <section>
      <h3 className="settings-detail__title">Mídia</h3>
      <p className="settings-detail__hint">
        Modelos de geração que os agentes podem disparar via MCP (
        {enabled.length} habilitado{enabled.length === 1 ? '' : 's'} de{' '}
        {providers.length}). Keys em Settings → MÍDIA.
      </p>
      {providers.length === 0 ? (
        <EmptyState
          icon="vision"
          title="Nenhum provider de mídia"
          body={
            <p>
              Providers de geração (imagem/vídeo/áudio) aparecem aqui. Configure
              as keys em Settings → Mídia.
            </p>
          }
          action={
            <ActionCard
              icon="key"
              title="Abrir Mídia"
              subtitle="keys de geração"
              variant="primary"
              size="sm"
              onClick={() => useSettingsStore.getState().openDrawer('media')}
            />
          }
        />
      ) : (
        <ul className="settings-list">
          {providers.map((p) => (
            <li key={p.id} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{p.label}</span>
                <span
                  className={`settings-chip ${p.hasKey ? 'settings-chip--ok' : 'settings-chip--warn'}`}
                >
                  {p.hasKey ? 'habilitado' : 'sem key'}
                </span>
                <span className="settings-chip">{p.kind}</span>
              </div>
              <p className="settings-list__detail">{p.models.join(' · ')}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Faixa LLMS · CLIS do arsenal: adapters instalados e seus modelos. */
export function LlmsSection({ adapters }: { adapters: AdapterInfo[] }) {
  const installed = adapters.filter((a) => a.installed && a.id !== 'shell');
  const absent = adapters.filter((a) => !a.installed && a.id !== 'shell');
  return (
    <section>
      <h3 className="settings-detail__title">LLMs · CLIs</h3>
      <p className="settings-detail__hint">
        CLIs de IA instaladas nesta máquina ({installed.length}) — o arsenal de
        execução que o roteador de tarefas distribui por custo.
      </p>
      {installed.length === 0 ? (
        <EmptyState
          icon="terminal"
          title="Nenhum LLM/CLI habilitado"
          body={
            <p>
              Instale uma CLI e configure a key em Providers para o roteador
              funcionar.
            </p>
          }
          action={
            <ActionCard
              icon="key"
              title="Abrir Providers"
              subtitle="chaves · CLIs"
              variant="primary"
              size="sm"
              onClick={() => useSettingsStore.getState().openDrawer('providers')}
            />
          }
        />
      ) : (
        <ul className="settings-list">
          {installed.map((a) => (
            <li key={a.id} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{a.label}</span>
                <span className="settings-chip settings-chip--ok">instalado</span>
              </div>
              <p className="settings-list__detail">
                {a.models.list.slice(0, 6).join(' · ') || 'modelos padrão do CLI'}
              </p>
            </li>
          ))}
        </ul>
      )}
      {absent.length > 0 && (
        <p className="settings-detail__hint">
          não instalados: {absent.map((a) => a.label).join(', ')}
        </p>
      )}
    </section>
  );
}

export function McpsSection() {
  const storeInfo = useOrchStore((s) => s.mcpInfo);
  const [mcpInfo, setMcpInfo] = useState(storeInfo);
  const [loading, setLoading] = useState(!storeInfo);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.nexus.orch.getMcpInfo().then((info) => {
      if (cancelled) return;
      setMcpInfo(info);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const running = Boolean(mcpInfo?.running);
  const toolCount = mcpInfo?.toolCount ?? 0;

  return (
    <section className="arsenal-section" aria-label="MCPs">
      <header className="arsenal-section__intro">
        <h3 className="settings-detail__title">MCPs</h3>
        <p className="settings-detail__hint">
          Servidor de contexto para os agentes nos panes. O Nexus embute um MCP
          local; squads e missões usam as tools daqui (terminal, files, browser,
          mídia…).
        </p>
      </header>

      <div className="arsenal-fleet" role="status">
        <span className="arsenal-fleet__stat">
          <span
            className={`arsenal-fleet__led ${
              loading
                ? ''
                : running
                  ? 'arsenal-fleet__led--ok'
                  : 'arsenal-fleet__led--warn'
            }`}
            aria-hidden="true"
          />
          {loading ? 'verificando…' : running ? 'online' : 'offline'}
        </span>
        <span className="arsenal-fleet__sep" aria-hidden="true">
          ·
        </span>
        <span className="arsenal-fleet__stat">
          <strong>{loading ? '…' : toolCount}</strong> tools
        </span>
      </div>

      <ul className="settings-list">
        <li className="settings-list__item arsenal-card">
          <div className="settings-list__head">
            <span className="settings-list__title">
              <PixelIcon name="bolt" size={12} /> nexus (embutido)
            </span>
            <span
              className={`prov__badge ${
                loading
                  ? 'prov__badge--muted'
                  : running
                    ? 'prov__badge--ok'
                    : 'prov__badge--warn'
              }`}
            >
              {loading ? '…' : running ? 'online' : 'offline'}
            </span>
          </div>
          <p className="settings-list__detail">
            Endpoint: <code>{mcpInfo?.url ?? '—'}</code>
          </p>
          <p className="settings-list__detail">
            {toolCount} tools nativas · auth por token bearer por pane (cada
            agente recebe credencial própria ao spawn).
          </p>
          <p className="settings-list__detail arsenal-card__hint">
            Lista completa em Config → Tools. Chaves de geração em Config →
            Mídia.
          </p>
        </li>
      </ul>
    </section>
  );
}

function toolFamily(name: string): string {
  const bare = name.replace(/^nexus_/, '');
  const head = bare.split('_')[0] ?? bare;
  if (head === 'terminal' || head === 'shell') return 'terminal';
  if (head === 'file' || head === 'files' || head === 'fs') return 'files';
  if (head === 'browser' || head === 'web') return 'browser';
  if (head === 'image' || head === 'video' || head === 'audio' || head === 'media') {
    return 'mídia';
  }
  if (head === 'git' || head === 'github') return 'git';
  if (head === 'mission' || head === 'squad' || head === 'orch') return 'orquestração';
  return 'outras';
}

export function ToolsSection() {
  const [tools, setTools] = useState<NativeToolInfo[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.nexus.orch.listNativeTools().then((list) => {
      if (!cancelled) {
        setTools(list);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
    <section className="arsenal-section" aria-label="Tools">
      <header className="arsenal-section__intro">
        <h3 className="settings-detail__title">Tools</h3>
        <p className="settings-detail__hint">
          Ferramentas nativas do MCP embutido. Agentes chamam via{' '}
          <code>nexus_*</code> ou alias curto — o bridge confirma ações
          destrutivas quando a política exige.
        </p>
      </header>

      <div className="arsenal-fleet" role="status">
        <span className="arsenal-fleet__stat">
          <strong>{loading ? '…' : tools.length}</strong> tools
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
        <span className="settings-visually-hidden">Filtrar tools</span>
        <input
          className="settings-input arsenal-search__input"
          type="search"
          value={query}
          placeholder="filtrar por nome ou descrição…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {loading && (
        <p className="settings-detail__hint" role="status">
          Carregando tools…
        </p>
      )}

      {!loading && tools.length === 0 && (
        <EmptyState
          icon="config"
          title="Nenhuma tool registrada"
          body={
            <p>Verifique se o MCP embutido subiu (Config → MCPs).</p>
          }
          action={
            <ActionCard
              icon="bolt"
              title="Abrir MCPs"
              subtitle="servidor · status"
              variant="primary"
              size="sm"
              onClick={() => useSettingsStore.getState().openDrawer('mcps')}
            />
          }
        />
      )}

      {!loading && tools.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title={`Nada para “${query}”`}
          body={<p>Ajuste o filtro ou limpe a busca.</p>}
        />
      )}

      {families.map((family) => (
        <div key={family} className="arsenal-band">
          <h4 className="arsenal-band__label">
            {family}{' '}
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
                <p className="settings-list__detail">{tool.description}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function PluginsSection({ adapters }: { adapters: AdapterInfo[] }) {
  const [files, setFiles] = useState<InstalledItemInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.nexus.orch.listPluginFiles().then((list) => {
      if (!cancelled) setFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <section>
      <h3 className="settings-detail__title">Plugins</h3>
      <p className="settings-detail__hint">
        {adapters.length} adapters ativos (builtin + usuário). Arquivos do
        usuário em ~/.nexus/plugins ({files.length}) — hot-reload sem rebuild.
      </p>
      <InstalledList
        items={files}
        empty="Nenhum plugin de usuário — solte um JSON de adapter em ~/.nexus/plugins/adapters."
      />
    </section>
  );
}

export function HooksSection() {
  const [homes, setHomes] = useState<InstalledItemInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.nexus.orch.listHookHomes().then((list) => {
      if (!cancelled) setHomes(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <section>
      <h3 className="settings-detail__title">Hooks</h3>
      <p className="settings-detail__hint">
        Lifecycle scripts do skill-gate: workers Claude-like recebem $HOME
        efêmero com hooks PreToolUse / PostToolUse / Stop; demais CLIs mantêm
        o HOME real e usam o gate server-side. {homes.length} home(s) ativo(s).
      </p>
      <InstalledList
        items={homes}
        empty="Nenhum hook ativo — são gerados ao spawnar workers de squad com allowlist."
      />
    </section>
  );
}

export function RulesSection() {
  const squads = useOrchStore((s) => s.squads);
  const rows = squads.flatMap((squad) =>
    squad.agents.map((agent) => ({
      squad: squad.name,
      agent: agent.agentName,
      tools:
        agent.allowedTools == null
          ? 'irrestrito'
          : agent.allowedTools.join(', ') || '(nenhuma)',
      skills:
        agent.allowedSkills == null
          ? 'irrestrito'
          : agent.allowedSkills.join(', ') || '(nenhuma)',
    })),
  );
  return (
    <section>
      <h3 className="settings-detail__title">Rules</h3>
      <p className="settings-detail__hint">
        Permissões por agente (allowlists do skill-gate). Enforcement duplo:
        servidor MCP + hooks no cliente. null = irrestrito.
      </p>
      {rows.length === 0 ? (
        <EmptyState
          icon="key"
          title="Nenhuma regra"
          body={
            <p>
              Salve squads com allowedTools/allowedSkills para ver permissões
              por agente.
            </p>
          }
          action={
            <ActionCard
              icon="users"
              title="Abrir Squads"
              subtitle="Orquestração e allowlists"
              variant="primary"
              size="sm"
              onClick={() => useSettingsStore.getState().openDrawer('squads')}
            />
          }
        />
      ) : (
        <ul className="settings-list">
          {rows.map((row, index) => (
            <li key={index} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">
                  {row.agent}
                  <span className="settings-list__detail"> · {row.squad}</span>
                </span>
              </div>
              <p className="settings-list__detail">tools: {row.tools}</p>
              <p className="settings-list__detail">skills: {row.skills}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* Recipes, Atalhos e Remote moraram aqui; foram extraídos para
   CatalogSectionsOps.tsx (teto de 800 linhas por módulo). Re-export mantém
   os imports do SettingsDrawer intactos. */
export { RecipesSection, RemoteSection, ShortcutsSection } from './CatalogSectionsOps';
