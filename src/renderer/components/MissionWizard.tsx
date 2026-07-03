import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type { Squad } from '../../shared/orch-types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';

/**
 * Mission wizard — mirrors the Overclock flow:
 *   mode → LIVRE (libre-count → libre-slots) | SQUAD (squad-select → review).
 * LIVRE spawns N agent panes in the workspace; SQUAD creates a mission and
 * launches the squad's orchestrator (which then delegates via the MCP tools).
 */

type Mode = 'libre' | 'squad';
type Step = 'mode' | 'libre-count' | 'libre-slots' | 'squad-select' | 'squad-review';

const PANE_COUNTS = [1, 2, 3, 4, 6];

const STEP_LABELS: Record<Step, string> = {
  mode: 'Modo',
  'libre-count': 'Panes',
  'libre-slots': 'Providers',
  'squad-select': 'Squad',
  'squad-review': 'Revisar',
};

function StepsBar({ steps, current }: { steps: Step[]; current: Step }) {
  return (
    <div className="wizard__steps">
      {steps.map((s) => (
        <span
          key={s}
          className={`wizard__step ${s === current ? 'wizard__step--active' : ''}`}
        >
          {STEP_LABELS[s]}
        </span>
      ))}
    </div>
  );
}

export function MissionWizard() {
  const open = useMissionWizardStore((s) => s.open);
  const close = useMissionWizardStore((s) => s.close);
  const squads = useOrchStore((s) => s.squads);
  const spawnOrchPane = useLayoutStore((s) => s.spawnOrchPane);
  const spawnAgent = useLayoutStore((s) => s.spawnAgent);

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState<Step>('mode');
  const [count, setCount] = useState(1);
  const [slots, setSlots] = useState<string[]>([]);
  const [squadId, setSquadId] = useState<string>('');
  const [spawning, setSpawning] = useState(false);

  useEffect(() => {
    if (!open) return;
    void window.nexus.adapters.list().then(setAdapters);
    // Reset wizard state each time it opens.
    setMode(null);
    setStep('mode');
    setCount(1);
    setSlots([]);
    setSquadId(squads[0]?.id ?? '');
  }, [open, squads]);

  const installed = useMemo(
    () => adapters.filter((a) => a.installed),
    [adapters],
  );

  const steps: Step[] = useMemo(() => {
    if (mode === 'squad') return ['mode', 'squad-select', 'squad-review'];
    if (mode === 'libre') return ['mode', 'libre-count', 'libre-slots'];
    return ['mode'];
  }, [mode]);

  if (!open) return null;

  function chooseMode(next: Mode) {
    setMode(next);
    if (next === 'libre') {
      setStep('libre-count');
      setSlots(Array.from({ length: count }, () => installed[0]?.id ?? 'shell'));
    } else {
      setStep('squad-select');
    }
  }

  function setSlot(index: number, adapterId: string) {
    setSlots((prev) => prev.map((s, i) => (i === index ? adapterId : s)));
  }

  function goCount(n: number) {
    setCount(n);
    setSlots((prev) => {
      const next = [...prev];
      next.length = n;
      for (let i = 0; i < n; i++) {
        if (!next[i]) next[i] = installed[0]?.id ?? 'shell';
      }
      return next;
    });
  }

  async function launchLibre() {
    setSpawning(true);
    try {
      for (const adapterId of slots) {
        if (adapterId === 'shell') {
          // Split a plain shell pane in the workspace.
          const { focusedPaneId, split } = useLayoutStore.getState();
          if (focusedPaneId) split(focusedPaneId, 'row');
        } else {
          const adapter = installed.find((a) => a.id === adapterId);
          spawnAgent(adapterId, adapter?.models.default ?? '');
        }
      }
      close();
    } finally {
      setSpawning(false);
    }
  }

  async function launchSquad(squad: Squad) {
    setSpawning(true);
    try {
      const orchestrator =
        squad.agents.find((a) => a.category === 'orchestrator') ??
        squad.agents[0];
      if (!orchestrator) {
        close();
        return;
      }
      // Spawn the orchestrator pane; it will create the mission + delegate via
      // the embedded MCP tools. Model/instructions come from the squad agent.
      spawnOrchPane({
        adapterId: orchestrator.cli,
        model: orchestrator.model,
        title: `${squad.name} · ${orchestrator.agentName}`,
        orchRequestId: `squad-${squad.id}-${Date.now().toString(36)}`,
      });
      close();
    } finally {
      setSpawning(false);
    }
  }

  const selectedSquad = squads.find((s) => s.id === squadId) ?? null;

  return (
    <div className="wizard" role="dialog" aria-label="Nova missão">
      <div className="wizard__overlay" onClick={close} />
      <div className="wizard__panel">
        <header className="wizard__header">
          <span className="wizard__title">Nova Missão</span>
          <StepsBar steps={steps} current={step} />
          <button className="wizard__close" onClick={close} aria-label="Fechar">
            ✕
          </button>
        </header>

        <div className="wizard__body">
          {step === 'mode' && (
            <div className="wizard__modes">
              <button
                className="wizard__mode"
                onClick={() => chooseMode('libre')}
              >
                <span className="wizard__mode-icon">⚡</span>
                <span className="wizard__mode-title">Livre</span>
                <span className="wizard__mode-desc">
                  Agentes solo — abra N panes livres neste workspace, sem
                  orquestração.
                </span>
              </button>
              <button
                className="wizard__mode"
                onClick={() => chooseMode('squad')}
                disabled={squads.length === 0}
              >
                <span className="wizard__mode-icon">👥</span>
                <span className="wizard__mode-title">Iniciar Squad</span>
                <span className="wizard__mode-desc">
                  Time orquestrado — um orquestrador delega para workers via MCP.
                  {squads.length === 0 && ' (salve um squad primeiro)'}
                </span>
              </button>
            </div>
          )}

          {step === 'libre-count' && (
            <div className="wizard__section">
              <p className="wizard__label">Quantos panes?</p>
              <div className="wizard__chips">
                {PANE_COUNTS.map((n) => (
                  <button
                    key={n}
                    className={`wizard__chip ${count === n ? 'wizard__chip--active' : ''}`}
                    onClick={() => goCount(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="wizard__actions">
                <button className="wizard__btn" onClick={() => setStep('mode')}>
                  ← Voltar
                </button>
                <button
                  className="wizard__btn wizard__btn--primary"
                  onClick={() => setStep('libre-slots')}
                >
                  Próximo →
                </button>
              </div>
            </div>
          )}

          {step === 'libre-slots' && (
            <div className="wizard__section">
              <p className="wizard__label">Provider de cada pane</p>
              <div className="wizard__slots">
                {Array.from({ length: count }, (_, i) => (
                  <label key={i} className="wizard__slot">
                    <span>Pane {i + 1}</span>
                    <select
                      className="wizard__select"
                      value={slots[i] ?? 'shell'}
                      onChange={(e) => setSlot(i, e.target.value)}
                    >
                      <option value="shell">shell</option>
                      {installed.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.icon} {a.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="wizard__actions">
                <button
                  className="wizard__btn"
                  onClick={() => setStep('libre-count')}
                >
                  ← Voltar
                </button>
                <button
                  className="wizard__btn wizard__btn--primary"
                  onClick={() => void launchLibre()}
                  disabled={spawning}
                >
                  {spawning ? 'Iniciando…' : 'Iniciar Missão'}
                </button>
              </div>
            </div>
          )}

          {step === 'squad-select' && (
            <div className="wizard__section">
              <p className="wizard__label">Escolha um squad</p>
              <div className="wizard__squads">
                {squads.map((s) => (
                  <button
                    key={s.id}
                    className={`wizard__squad ${squadId === s.id ? 'wizard__squad--active' : ''}`}
                    onClick={() => setSquadId(s.id)}
                  >
                    <span className="wizard__squad-name">{s.name}</span>
                    <span className="wizard__squad-desc">
                      {s.agents.length} agente(s)
                    </span>
                  </button>
                ))}
              </div>
              <div className="wizard__actions">
                <button className="wizard__btn" onClick={() => setStep('mode')}>
                  ← Voltar
                </button>
                <button
                  className="wizard__btn wizard__btn--primary"
                  onClick={() => setStep('squad-review')}
                  disabled={!squadId}
                >
                  Próximo →
                </button>
              </div>
            </div>
          )}

          {step === 'squad-review' && selectedSquad && (
            <div className="wizard__section">
              <p className="wizard__label">{selectedSquad.name}</p>
              <ul className="wizard__roster">
                {selectedSquad.agents.map((a) => (
                  <li key={a.id} className="wizard__roster-item">
                    <span className="wizard__roster-role">{a.category}</span>
                    <span className="wizard__roster-name">{a.agentName}</span>
                    <span className="wizard__roster-cli">
                      {a.cli}
                      {a.model ? ` · ${a.model}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="wizard__actions">
                <button
                  className="wizard__btn"
                  onClick={() => setStep('squad-select')}
                >
                  ← Voltar
                </button>
                <button
                  className="wizard__btn wizard__btn--primary"
                  onClick={() => void launchSquad(selectedSquad)}
                  disabled={spawning}
                >
                  {spawning ? 'Iniciando…' : 'Iniciar Squad'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
