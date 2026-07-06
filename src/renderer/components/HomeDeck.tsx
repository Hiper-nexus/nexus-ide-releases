import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type { Squad } from '../../shared/orch-types';
import { useHomeStore } from '../state/home-store';
import { useOrchStore } from '../state/orch-store';
import { useLayoutStore } from '../state/layout-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useVoiceStore } from '../voice/voice-store';
import { listPanes } from '../lib/split-tree';
import { isMissingModelKeyError } from '../lib/credential-errors';
import { NexusMark } from './NexusMark';
import { PixelIcon } from './PixelIcon';

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
  const openVoiceSettings = useVoiceStore((s) => s.openSettings);
  const addShellPane = useLayoutStore((s) => s.addShellPane);
  const paneCount = useLayoutStore((s) => listPanes(s.root).length);

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [designing, setDesigning] = useState(false);
  const [designNote, setDesignNote] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    void window.nexus.adapters.list().then(setAdapters);
  }, [visible]);

  // Anything spawning panes (missions, agents, orchestration) takes over.
  useEffect(() => {
    if (visible && paneCount > 1) hide();
  }, [visible, paneCount, hide]);

  // Escape dispensa o Home para o terminal ao fundo — saída sempre à mão.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, hide]);

  const installed = useMemo(
    () => adapters.filter((a) => a.installed),
    [adapters],
  );
  // Seus squads (custom) primeiro — os originais re-semeiam sozinhos, então
  // nunca podem empurrar um squad seu para fora da lista.
  const featured = useMemo(
    () =>
      [...squads]
        .sort((a, b) => Number(a.builtin ?? false) - Number(b.builtin ?? false))
        .slice(0, 6),
    [squads],
  );

  if (!visible) return null;

  return (
    <div className="home-deck" role="region" aria-label="Início do workspace">
      <div className="home-deck__panel">
        <header className="home-deck__head">
          <NexusMark size={26} className="home-deck__logo" />
          <div className="home-deck__title-wrap">
            <h1 className="home-deck__title">Pronto para operar</h1>
            <p className="home-deck__ws" title={workspace?.path}>
              {workspace?.name ?? 'workspace'}
            </p>
          </div>
          <button
            className="home-deck__close"
            onClick={hide}
            title="Fechar (Esc) — usa o terminal ao fundo"
            aria-label="Fechar o painel inicial"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 3 L11 11 M11 3 L3 11"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
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
            <PixelIcon name="mission" />
            Iniciar missão
          </button>
          <button
            className="home-deck__btn"
            disabled={designing}
            title="Analisa a stack e os arquivos deste projeto e gera um squad com os papéis certos"
            onClick={() => {
              if (!workspace?.path) return;
              setDesigning(true);
              setDesignNote('Analisando o projeto…');
              void window.nexus.orch
                .designSquad(workspace.path)
                .then((res) => {
                  setDesigning(false);
                  if (res.ok && res.squad) {
                    setDesignNote(null);
                    openForSquad(res.squad.id);
                  } else {
                    const error = res.error ?? 'Não consegui gerar o squad.';
                    if (isMissingModelKeyError(error)) {
                      setDesignNote('Configure uma key de modelo para gerar o squad.');
                      openVoiceSettings();
                    } else {
                      setDesignNote(error);
                    }
                  }
                });
            }}
          >
            <PixelIcon name="sparkle" />
            {designing ? 'Analisando…' : 'Squad sob medida'}
          </button>
          <button
            className="home-deck__btn"
            onClick={() => {
              hide();
              addShellPane();
            }}
          >
            <PixelIcon name="terminal" />
            Terminal
          </button>
        </div>
        {designNote && <p className="home-deck__ws">{designNote}</p>}

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
                    <span className="home-deck__squad-go" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <PixelIcon name="chevron" size={7} />
                    </span>
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
          <button className="home-deck__dismiss" onClick={hide} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            usar só o terminal <PixelIcon name="chevron" size={7} />
          </button>
        </footer>
      </div>
    </div>
  );
}
