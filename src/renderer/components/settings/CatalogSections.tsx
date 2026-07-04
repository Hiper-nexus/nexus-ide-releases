import { useEffect, useState } from 'react';
import type {
  AdapterInfo,
  InstalledItemInfo,
  NativeToolInfo,
} from '../../../shared/types';
import { useOrchStore } from '../../state/orch-store';

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

function InstalledList({
  items,
  empty,
}: {
  items: InstalledItemInfo[];
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="settings-detail__hint">{empty}</p>;
  }
  return (
    <ul className="settings-list">
      {items.map((item) => (
        <li key={item.file} className="settings-list__item">
          <div className="settings-list__head">
            <span className="settings-list__title">{item.name}</span>
            <span className="settings-chip">{item.kind}</span>
          </div>
          <p className="settings-list__detail">
            {item.file} · {timeLabel(item.modifiedAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function AgentsSection() {
  const items = useInstalledCatalog('agent');
  const squadAgents = useOrchStore((s) =>
    s.squads.reduce((count, squad) => count + squad.agents.length, 0),
  );
  return (
    <section>
      <h3 className="settings-detail__title">Agents</h3>
      <p className="settings-detail__hint">
        AI subagents instalados do catálogo ({items.length}) + {squadAgents}{' '}
        agente(s) definidos em squads.
      </p>
      <InstalledList
        items={items}
        empty="Nenhum agent instalado — use o Marketplace para instalar."
      />
    </section>
  );
}

export function SkillsSection() {
  const items = useInstalledCatalog('skill');
  return (
    <section>
      <h3 className="settings-detail__title">Skills</h3>
      <p className="settings-detail__hint">
        Cache local de skills instaladas do catálogo ({items.length}).
      </p>
      <InstalledList
        items={items}
        empty="Nenhuma skill instalada — use o Marketplace para instalar."
      />
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

const SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: '⌘D', action: 'Split à direita' },
  { keys: '⌘⇧D', action: 'Split abaixo' },
  { keys: '⌘W', action: 'Fechar pane focado' },
  { keys: 'clique', action: 'Focar pane' },
  { keys: '⬡ Canvas', action: 'Alternar grid ↔ canvas (barra)' },
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
