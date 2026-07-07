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
    return <p className="settings-detail__hint">{empty}</p>;
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
        empty={
          tier === 'todos'
            ? 'Nenhum agent instalado — use o Marketplace para instalar.'
            : `Nenhum agent no tier ${tier} — rode "Enriquecer" para classificar.`
        }
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
        empty={
          tier === 'todos'
            ? 'Nenhuma skill instalada — use o Marketplace para instalar.'
            : `Nenhuma skill no tier ${tier} — rode "Enriquecer" para classificar.`
        }
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
        <p className="settings-detail__hint">nenhum provider de mídia</p>
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
        <p className="settings-detail__hint">nenhum LLM/CLI habilitado</p>
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
  const mcpInfo = useOrchStore((s) => s.mcpInfo);
  return (
    <section>
      <h3 className="settings-detail__title">MCPs</h3>
      <p className="settings-detail__hint">
        Servidores MCP disponíveis para os agentes dos panes.
      </p>
      <ul className="settings-list">
        <li className="settings-list__item">
          <div className="settings-list__head">
            <span className="settings-list__title">nexus (embutido)</span>
            <span
              className={`settings-chip ${mcpInfo?.running ? 'settings-chip--ok' : 'settings-chip--warn'}`}
            >
              {mcpInfo?.running ? 'online' : 'offline'}
            </span>
          </div>
          <p className="settings-list__detail">
            {mcpInfo?.url ?? '—'} · {mcpInfo?.toolCount ?? 0} tools · auth por
            token bearer individual por pane
          </p>
        </li>
      </ul>
    </section>
  );
}

export function ToolsSection() {
  const [tools, setTools] = useState<NativeToolInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.nexus.orch.listNativeTools().then((list) => {
      if (!cancelled) setTools(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <section>
      <h3 className="settings-detail__title">Tools</h3>
      <p className="settings-detail__hint">
        {tools.length} tools nativas do servidor MCP embutido (aliases
        nexus_* e nomes diretos aceitos).
      </p>
      <ul className="settings-list">
        {tools.map((tool) => (
          <li key={tool.name} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title settings-list__title--mono">
                {tool.name}
              </span>
            </div>
            <p className="settings-list__detail">{tool.description}</p>
          </li>
        ))}
      </ul>
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
        <p className="settings-detail__hint">
          Nenhuma regra — salve squads com allowedTools/allowedSkills.
        </p>
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
