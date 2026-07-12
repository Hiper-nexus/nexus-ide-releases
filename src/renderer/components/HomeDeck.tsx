import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type { Squad } from '../../shared/orch-types';
import { useHomeStore } from '../state/home-store';
import { useOrchStore } from '../state/orch-store';
import { useLayoutStore } from '../state/layout-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useVoiceStore } from '../voice/voice-store';
import { useSettingsStore } from '../state/settings-store';
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
  const openSettings = useSettingsStore((s) => s.toggleDrawer);
  const addShellPane = useLayoutStore((s) => s.addShellPane);
  const paneCount = useLayoutStore((s) => listPanes(s.root).length);
  const viewKind = useLayoutStore((s) => s.viewKind);

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adaptersLoaded, setAdaptersLoaded] = useState(false);
  const [designing, setDesigning] = useState(false);
  const [designNote, setDesignNote] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void window.nexus.adapters
      .list()
      .then((next) => {
        if (!cancelled) setAdapters(next);
      })
      .catch(() => {
        if (!cancelled) setAdapters([]);
      })
      .finally(() => {
        if (!cancelled) setAdaptersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
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
  const needsCli = adaptersLoaded && installed.length === 0;
  const isReady = adaptersLoaded && installed.length > 0 && mcpInfo?.running;

  if (!visible) return null;

  return (
    <div className="home-deck" role="region" aria-label="Início do workspace">
      <div className="home-deck__panel">
        <header className="home-deck__head">
          <NexusMark size={26} className="home-deck__logo" />
          <div className="home-deck__title-wrap">
            <h1 className="home-deck__title">
              {isReady
                ? 'Base operacional pronta'
                : needsCli
                  ? 'Conecte uma CLI para operar'
                  : 'Preparando base operacional'}
            </h1>
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
            <PixelIcon name="close" size={12} />
          </button>
        </header>

        <div className="home-deck__status" aria-label="Estado do sistema">
          <span className={`home-deck__stat ${installed.length > 0 ? 'home-deck__stat--live' : ''}`}>
            <i className="home-deck__dot" aria-hidden="true" />
            {adaptersLoaded
              ? `${installed.length} CLI${installed.length === 1 ? '' : 's'} pronta${installed.length === 1 ? '' : 's'}`
              : 'Verificando CLIs'}
          </span>
          <span className={`home-deck__stat ${mcpInfo?.running ? 'home-deck__stat--live' : ''}`}>
            <i className="home-deck__dot" aria-hidden="true" />
            {mcpInfo?.running
              ? `MCP online · ${mcpInfo.toolCount} ferramentas`
              : mcpInfo
                ? 'MCP indisponível'
                : 'MCP conectando'}
          </span>
        </div>

        <section className="home-deck__next" aria-labelledby="home-next-title">
          <div className="home-deck__next-copy">
            <p className="home-deck__next-label">Próxima ação</p>
            <h2 id="home-next-title">
              {needsCli ? 'Configurar uma CLI de IA' : 'Iniciar uma missão'}
            </h2>
            <p>
              {needsCli
                ? 'Ative pelo menos um provider para abrir agentes e squads neste workspace.'
                : 'Defina o objetivo e escolha um squad, ou deixe o Nexus montar a equipe a partir deste projeto.'}
            </p>
          </div>
          <div className="home-deck__actions">
            <button
              className="home-deck__cta"
              onClick={needsCli ? openSettings : openWizard}
              autoFocus
            >
              <PixelIcon name={needsCli ? 'config' : 'mission'} />
              {needsCli ? 'Configurar provider' : 'Iniciar missão'}
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
                  })
                  .catch((cause) => {
                    setDesignNote(
                      cause instanceof Error
                        ? cause.message
                        : 'Não foi possível analisar este projeto.',
                    );
                  })
                  .finally(() => setDesigning(false));
              }}
            >
              <PixelIcon name="sparkle" />
              {designing ? 'Analisando…' : 'Criar squad sob medida'}
            </button>
            <button
              className="home-deck__btn"
              onClick={() => {
                hide();
                addShellPane();
              }}
            >
              <PixelIcon name="terminal" />
              Abrir terminal
            </button>
          </div>
        </section>
        {designNote && <p className="home-deck__notice" role="status">{designNote}</p>}

        {featured.length > 0 && (
          <section className="home-deck__squads" aria-label="Squads prontos">
            <h2 className="home-deck__section-title">Squads prontos</h2>
            <ul className="home-deck__squad-list">
              {featured.map((s) => (
                <li key={s.id}>
                  <button
                    className="home-deck__squad"
                    onClick={() => openForSquad(s.id)}
                  >
                    <span className="home-deck__squad-name">{s.name}</span>
                    <span className="home-deck__squad-meta">{workerCount(s)}</span>
                    <span className="home-deck__squad-go" aria-hidden="true">
                      <PixelIcon name="chevron" size={10} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="home-deck__foot">
          <span className="home-deck__keys">
            {viewKind === 'canvas' ? (
              <><kbd>⌘K</kbd> comandos · <kbd>F</kbd> centralizar · arraste panes</>
            ) : (
              <><kbd>⌘K</kbd> comandos · <kbd>⌘N</kbd> missão · <kbd>⌘D</kbd> dividir · <kbd>⌘1-9</kbd> focar</>
            )}
          </span>
          <button className="home-deck__dismiss" onClick={hide}>
            Ir para o terminal <PixelIcon name="chevron" size={10} />
          </button>
        </footer>
      </div>
    </div>
  );
}
