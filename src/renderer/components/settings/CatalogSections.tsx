import { useEffect, useState } from 'react';
import type {
  AdapterInfo,
  AgentSpecWriteRequest,
  EnrichedCatalogInfo,
  HarnessTier,
  InstalledItemInfo,
  NativeToolInfo,
  RecipeOverlayResult,
  RemoteBridgeInfo,
  RemoteSpawnResult,
} from '../../../shared/types';
import type { MediaProviderInfo } from '../../../shared/media-types';
import { useOrchStore } from '../../state/orch-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useLayoutStore } from '../../state/layout-store';
import { waitForSession } from '../../terminal/terminal-host';

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
          {enriching ? '✨ Enriquecendo…' : '✨ Enriquecer'}
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
            : `Nenhum agent no tier ${tier} — rode ✨ Enriquecer para classificar.`
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
            : `Nenhuma skill no tier ${tier} — rode ✨ Enriquecer para classificar.`
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
        Lifecycle scripts do skill-gate: cada worker gated recebe um $HOME
        efêmero com hooks PreToolUse / PostToolUse / Stop que consultam o gate
        local. {homes.length} home(s) ativo(s).
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

export function RecipesSection() {
  const workspace = useWorkspaceStore((s) => s.current);
  const squads = useOrchStore((s) => s.squads);
  const [overlay, setOverlay] = useState<RecipeOverlayResult | null>(null);
  const [manualStacks, setManualStacks] = useState('');
  const [agentSpec, setAgentSpec] = useState<AgentSpecWriteRequest>({
    name: '',
    tools: [],
    skills: [],
    model: '',
    effort: '',
    category: '',
    systemPrompt: '',
  });
  const [agentSpecResult, setAgentSpecResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.nexus.orch
      .getRecipeOverlay(workspace?.path)
      .then((result) => {
        if (!cancelled) {
          setOverlay(result);
          setManualStacks(result.overlay?.stacks.join(', ') ?? '');
        }
      })
      .catch(() => {
        if (!cancelled) setOverlay(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.path, squads, refreshTick]);

  const issues = overlay?.issues ?? [];
  const suggestions = overlay?.suggestions ?? [];
  const categories = Object.entries(overlay?.categories ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  async function saveStacks() {
    await window.nexus.orch.saveCatalogOverlay({
      workspacePath: workspace?.path,
      stacks: manualStacks
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setRefreshTick((tick) => tick + 1);
  }

  async function saveAgentSpec() {
    const result = await window.nexus.orch.writeAgentSpec({
      ...agentSpec,
      tools: (agentSpec.tools ?? []).filter(Boolean),
      skills: (agentSpec.skills ?? []).filter(Boolean),
    });
    setAgentSpecResult(result.ok ? result.path ?? 'salvo' : result.error ?? 'erro');
  }

  return (
    <section>
      <h3 className="settings-detail__title">Recipes</h3>
      <p className="settings-detail__hint">
        Lint de squads/recipes contra catálogo local. Referências inexistentes
        precisam de gap explícito no formato <code>gap:nome: motivo</code>.
      </p>

      <div className="settings-pill-row">
        <button
          className="settings-btn"
          onClick={() => setRefreshTick((tick) => tick + 1)}
          disabled={loading}
        >
          {loading ? 'Atualizando…' : 'Atualizar lint'}
        </button>
        {(overlay?.stacks.length ? overlay.stacks : ['workspace']).map((stack) => (
          <span key={stack} className="settings-chip">
            {stack}
          </span>
        ))}
        <span className={`settings-chip ${overlay?.ok ? 'settings-chip--ok' : 'settings-chip--warn'}`}>
          {overlay?.ok ? 'lint ok' : `${issues.length} issue(s)`}
        </span>
      </div>

      <div className="settings-list__item">
        <div className="settings-list__head">
          <span className="settings-list__title">Overlay de stacks</span>
          <button className="settings-btn" onClick={() => void saveStacks()}>
            Salvar
          </button>
        </div>
        <input
          className="settings-input"
          value={manualStacks}
          placeholder="react, electron, rust"
          onChange={(e) => setManualStacks(e.target.value)}
        />
      </div>

      {suggestions.length > 0 && (
        <ul className="settings-list">
          {suggestions.map((recipe) => (
            <li key={recipe.id} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{recipe.title}</span>
                <span className="settings-chip">{recipe.agents.join(' · ')}</span>
              </div>
              <p className="settings-list__detail">
                tools: {recipe.tools.join(', ')}
              </p>
              {recipe.gaps.length > 0 && (
                <p className="settings-list__detail">gaps: {recipe.gaps.join(', ')}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="settings-list__item">
        <div className="settings-list__head">
          <span className="settings-list__title">Agent spec writer</span>
          <button
            className="settings-btn"
            onClick={() => void saveAgentSpec()}
            disabled={!agentSpec.name.trim()}
          >
            Salvar agent
          </button>
        </div>
        <div className="settings-form-grid">
          <input
            className="settings-input"
            value={agentSpec.name}
            placeholder="nome-do-agent"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, name: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.model}
            placeholder="modelo"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, model: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.effort}
            placeholder="effort"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, effort: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.category}
            placeholder="categoria"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, category: e.target.value }))}
          />
        </div>
        <input
          className="settings-input"
          value={(agentSpec.tools ?? []).join(', ')}
          placeholder="tools separadas por vírgula"
          onChange={(e) =>
            setAgentSpec((prev) => ({
              ...prev,
              tools: e.target.value.split(',').map((item) => item.trim()),
            }))
          }
        />
        <textarea
          className="settings-textarea"
          value={agentSpec.systemPrompt}
          placeholder="system prompt"
          onChange={(e) =>
            setAgentSpec((prev) => ({ ...prev, systemPrompt: e.target.value }))
          }
        />
        {agentSpecResult && (
          <p className="settings-list__detail">{agentSpecResult}</p>
        )}
      </div>

      {categories.length > 0 && (
        <ul className="settings-list settings-list--compact">
          {categories.map(([category, count]) => (
            <li key={category} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{category}</span>
                <span className="settings-chip">{count}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {issues.length === 0 ? (
        <p className="settings-detail__hint">
          Nenhum problema encontrado em allowedTools/allowedSkills.
        </p>
      ) : (
        <ul className="settings-list">
          {issues.map((issue, index) => (
            <li key={`${issue.squadId}-${issue.agentId}-${issue.ref}-${index}`} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">
                  {issue.agentName ?? issue.squadName}
                </span>
                <span className="settings-chip settings-chip--warn">{issue.field}</span>
              </div>
              <p className="settings-list__detail">{issue.message}</p>
              <p className="settings-list__detail">
                {issue.squadName} · {issue.ref}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: '⌘D', action: 'Split à direita' },
  { keys: '⌘⇧D', action: 'Split abaixo' },
  { keys: '⌘W', action: 'Fechar pane focado' },
  { keys: 'clique', action: 'Focar pane' },
  { keys: '⬡ Canvas', action: 'Alternar grid ↔ canvas (barra)' },
  { keys: '☾ / ☀', action: 'Dormir/acordar pane' },
  { keys: 'Space (segurar)', action: 'Push-to-talk de voz (configurável)' },
];

export function ShortcutsSection() {
  return (
    <section>
      <h3 className="settings-detail__title">Atalhos</h3>
      <p className="settings-detail__hint">Teclado e gestos do workspace.</p>
      <ul className="settings-list">
        {SHORTCUTS.map((shortcut) => (
          <li key={shortcut.keys} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title settings-list__title--mono">
                {shortcut.keys}
              </span>
              <span className="settings-list__detail">{shortcut.action}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RemoteSection() {
  const [info, setInfo] = useState<RemoteBridgeInfo | null>(null);
  const [target, setTarget] = useState('');
  const [cli, setCli] = useState<'claude' | 'codex' | 'agy' | 'kimi'>('claude');
  const [sessionName, setSessionName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<RemoteSpawnResult | null>(null);

  async function refresh() {
    setInfo(await window.nexus.remote.bridgeStatus());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createRemote() {
    const next = await window.nexus.remote.createTmux({
      target,
      cli,
      sessionName: sessionName || undefined,
      prompt: prompt || undefined,
    });
    setResult(next);
    if (next.ok && next.attachCommand) {
      const proceed = window.confirm(
        `Abrir um shell pane e executar automaticamente?\n\n${next.attachCommand}`,
      );
      if (!proceed) return;
      const paneId = useLayoutStore.getState().addShellPane();
      const sessionId = await waitForSession(paneId);
      if (sessionId) window.nexus.pty.write(sessionId, `${next.attachCommand}\n`);
    }
  }

  return (
    <section>
      <h3 className="settings-detail__title">Remote</h3>
      <div className="settings-pill-row">
        <span className={`settings-chip ${info?.running ? 'settings-chip--ok' : 'settings-chip--warn'}`}>
          {info?.running ? 'wss online' : 'offline'}
        </span>
        <button
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeStart());
          }}
        >
          Iniciar
        </button>
        <button
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeRotatePairing());
          }}
        >
          Novo código
        </button>
        <button
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeRevokeTokens());
          }}
        >
          Revogar tokens
        </button>
      </div>

      {info && (
        <ul className="settings-list">
          <li className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title settings-list__title--mono">
                {info.pairingCode ?? '------'}
              </span>
              <span className="settings-chip">{info.tokenCount} token(s)</span>
            </div>
            <p className="settings-list__detail">
              {info.urls.join(' · ') || 'sem URL ativa'}
            </p>
            {info.urls.length > 0 && (
              <p className="settings-list__detail">
                📱 abra no celular:{' '}
                {info.urls
                  .filter((u) => !u.includes('127.0.0.1'))
                  .map((u) => u.replace('wss://', 'https://'))
                  .join(' · ') || 'só localhost — conecte na mesma rede'}
              </p>
            )}
            <p className="settings-list__detail">
              cert: {info.certFingerprint ?? '—'} · clients: {info.clientCount}
            </p>
          </li>
        </ul>
      )}

      <div className="settings-list__item">
        <div className="settings-list__head">
          <span className="settings-list__title">SSH/tmux</span>
          <button
            className="settings-btn"
            onClick={() => void createRemote()}
            disabled={!target.trim()}
          >
            Criar/adotar
          </button>
        </div>
        <div className="settings-form-grid">
          <input
            className="settings-input"
            value={target}
            placeholder="user@host"
            onChange={(e) => setTarget(e.target.value)}
          />
          <select
            className="settings-input"
            value={cli}
            onChange={(e) => setCli(e.target.value as typeof cli)}
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="agy">agy</option>
            <option value="kimi">kimi</option>
          </select>
          <input
            className="settings-input"
            value={sessionName}
            placeholder="tmux session"
            onChange={(e) => setSessionName(e.target.value)}
          />
        </div>
        <textarea
          className="settings-textarea"
          value={prompt}
          placeholder="prompt inicial"
          onChange={(e) => setPrompt(e.target.value)}
        />
        {result && (
          <p className="settings-list__detail">
            {result.ok ? result.attachCommand : result.error}
          </p>
        )}
      </div>
    </section>
  );
}
