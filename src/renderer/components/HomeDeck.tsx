import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type { Squad } from '../../shared/orch-types';
import { useHomeStore } from '../state/home-store';
import { useOrchStore } from '../state/orch-store';
import { useLayoutStore } from '../state/layout-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { listPanes } from '../lib/split-tree';

/**
 * Home deck — the ops-deck empty state rendered over the pane area when a
 * workspace opens without a saved mission. Non-modal: the shell pane stays
 * live underneath and one click dismisses into it. Answers "what can I run
 * right now?" with live operational status (detected CLIs, MCP, squads) and
 * one-click mission starts.
 */

function workerCount(squad: Squad): string {
  const workers = squad.agents.filter((a) => a.category !== 'orchestrator').length;
  const hasOrch = squad.agents.some((a) => a.category === 'orchestrator');
  return hasOrch ? `orq + ${workers} worker${workers === 1 ? '' : 's'}` : `${workers} agentes`;
}

export function HomeDeck() {
  const visible = useHomeStore((s) => s.visible);
  const hide = useHomeStore((s) => s.hide);
  const squads = useOrchStore((s) => s.squads);
  const mcpInfo = useOrchStore((s) => s.mcpInfo);
  const workspace = useWorkspaceStore((s) => s.current);
  const openWizard = useMissionWizardStore((s) => s.openForMission);
  const openForSquad = useMissionWizardStore((s) => s.openForSquad);
  const addShellPane = useLayoutStore((s) => s.addShellPane);
  const paneCount = useLayoutStore((s) => listPanes(s.root).length);

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  useEffect(() => {
    if (!visible) return;
    void window.nexus.adapters.list().then(setAdapters);
  }, [visible]);

  // Anything spawning panes (missions, agents, orchestration) takes over.
  useEffect(() => {
    if (visible && paneCount > 1) hide();
  }, [visible, paneCount, hide]);

  const installed = useMemo(
    () => adapters.filter((a) => a.installed),
    [adapters],
  );
  const featured = useMemo(() => squads.slice(0, 3), [squads]);

  if (!visible) return null;

  return (
    <div className="home-deck" role="region" aria-label="Início do workspace">
      <div className="home-deck__panel">
        <header className="home-deck__head">
          <span className="home-deck__logo">◈</span>
          <div className="home-deck__title-wrap">
            <h1 className="home-deck__title">Pronto para operar</h1>
            <p className="home-deck__ws" title={workspace?.path}>
              {workspace?.name ?? 'workspace'}
            </p>
          </div>
        </header>

        <div className="home-deck__status" aria-label="Status operacional">
          <span className={`home-deck__stat ${installed.length > 0 ? 'home-deck__stat--live' : ''}`}>
            <i className="home-deck__dot" aria-hidden="true" />
            {installed.length > 0
              ? `${installed.length} CLI${installed.length === 1 ? '' : 's'} de IA detectada${installed.length === 1 ? '' : 's'}`
              : 'nenhuma CLI de IA detectada'}
          </span>
          <span className={`home-deck__stat ${mcpInfo?.running ? 'home-deck__stat--live' : ''}`}>
            <i className="home-deck__dot" aria-hidden="true" />
            {mcpInfo?.running ? `MCP ativo · ${mcpInfo.toolCount} tools` : 'MCP iniciando…'}
          </span>
        </div>

        <div className="home-deck__actions">
          <button className="home-deck__cta" onClick={openWizard} autoFocus>
            ▸ Iniciar missão
          </button>
          <button
            className="home-deck__btn"
            onClick={() => {
              hide();
              addShellPane();
            }}
          >
            ＋ Terminal
          </button>
        </div>

        {featured.length > 0 && (
          <section className="home-deck__squads" aria-label="Squads prontos">
            <h2 className="home-deck__section-title">Iniciar com um squad</h2>
            <ul className="home-deck__squad-list">
              {featured.map((s) => (
                <li key={s.id}>
                  <button
                    className="home-deck__squad"
                    onClick={() => openForSquad(s.id)}
                  >
                    <span className="home-deck__squad-name">{s.name}</span>
                    <span className="home-deck__squad-meta">{workerCount(s)}</span>
                    <span className="home-deck__squad-go" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="home-deck__foot">
          <span className="home-deck__keys">
            <kbd>⌘D</kbd> dividir · <kbd>⇧⌘D</kbd> dividir ↓ · <kbd>⌘W</kbd> fechar pane
          </span>
          <button className="home-deck__dismiss" onClick={hide}>
            usar só o terminal ›
          </button>
        </footer>
      </div>
    </div>
  );
}
