import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type { Squad } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { switchWorkspaceLayout } from '../state/layout-store';
import { launchLibrePanes, launchSquadMission } from '../orch/mission-launcher';

/**
 * "Novo workspace" / "Nova Missão" wizard — true Overclock v0.7.5 parity:
 *   PASTA (novo workspace) → MODO → Livre: PANES → PROVIDERS
 *                                 → Squad: SQUAD → REVISAR
 * Copy, step breadcrumb, mode cards and the squad list (ORIGINALS + YOUR
 * SQUADS with "orq + N workers") mirror the real app.
 */

type Mode = 'libre' | 'squad';
type Step =
  | 'new-ws'
  | 'mode'
  | 'libre-count'
  | 'libre-slots'
  | 'squad-select'
  | 'squad-review';

const PANE_COUNTS = [1, 2, 3, 4, 6];

const STEP_LABELS: Record<Step, string> = {
  'new-ws': 'Pasta',
  mode: 'Modo',
  'libre-count': 'Panes',
  'libre-slots': 'Providers',
  'squad-select': 'Squad',
  'squad-review': 'Revisar',
};

function StepsBar({ steps, current }: { steps: Step[]; current: Step }) {
  return (
    <div className="wizard__steps" aria-label="Etapas">
      {steps.map((s, i) => (
        <span key={s} className="wizard__step-wrap">
          {i > 0 && <span className="wizard__step-line" />}
          <span
            className={`wizard__step ${s === current ? 'wizard__step--active' : ''}`}
          >
            {STEP_LABELS[s].toUpperCase()}
          </span>
        </span>
      ))}
    </div>
  );
}

function workerCount(squad: Squad): string {
  const workers = squad.agents.filter((a) => a.category !== 'orchestrator').length;
  const hasOrch = squad.agents.some((a) => a.category === 'orchestrator');
  return hasOrch ? `orq + ${workers} worker${workers === 1 ? '' : 's'}` : `${workers} agentes`;
}

export function MissionWizard() {
  const open = useMissionWizardStore((s) => s.open);
  const variant = useMissionWizardStore((s) => s.variant);
  const close = useMissionWizardStore((s) => s.close);
  const squads = useOrchStore((s) => s.squads);
  const recents = useWorkspaceStore((s) => s.recents);
  const openWorkspace = useWorkspaceStore((s) => s.open);

  const hasNewWsStep = variant === 'workspace';

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<Mode | null>(null);
  const [wsPath, setWsPath] = useState('');
  const [count, setCount] = useState(2);
  const [slots, setSlots] = useState<string[]>([]);
  const [squadId, setSquadId] = useState('');
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.nexus.adapters.list().then(setAdapters);
    setStep(hasNewWsStep ? 'new-ws' : 'mode');
    setMode(null);
    setWsPath('');
    setCount(2);
    setSlots([]);
    setSquadId('');
    setError(null);
  }, [open, hasNewWsStep]);

  const installed = useMemo(
    () => adapters.filter((a) => a.installed),
    [adapters],
  );
  // Every adapter is selectable per pane (installed or not) — an uninstalled
  // pick still opens the pane and surfaces its install hint, so the user can
  // always choose the LLM for each slot.
  const defaultSlot = installed[0]?.id ?? adapters[0]?.id ?? 'shell';

  const steps: Step[] = useMemo(() => {
    const prefix: Step[] = hasNewWsStep ? ['new-ws'] : [];
    if (mode === 'squad') return [...prefix, 'mode', 'squad-select', 'squad-review'];
    if (mode === 'libre') return [...prefix, 'mode', 'libre-count', 'libre-slots'];
    return [...prefix, 'mode'];
  }, [mode, hasNewWsStep]);

  const originals = squads.filter((s) => s.builtin);
  const userSquads = squads.filter((s) => !s.builtin);
  const selectedSquad = squads.find((s) => s.id === squadId) ?? null;

  if (!open) return null;

  async function browse() {
    const picked = await window.nexus.workspace.pickPath();
    if (picked) setWsPath(picked);
  }

  function fillSlots(prev: string[], n: number): string[] {
    const next = [...prev];
    next.length = n;
    for (let i = 0; i < n; i++) {
      if (!next[i]) next[i] = defaultSlot;
    }
    return next;
  }

  function chooseMode(next: Mode) {
    setMode(next);
    if (next === 'libre') {
      setStep('libre-count');
      setSlots((prev) => fillSlots(prev, count));
    } else {
      if (!squadId) setSquadId(squads[0]?.id ?? '');
      setStep('squad-select');
    }
  }

  function goCount(n: number) {
    setCount(n);
    setSlots((prev) => fillSlots(prev, n));
  }

  async function ensureWorkspaceOpen(): Promise<boolean> {
    if (!hasNewWsStep) return true;
    const target = wsPath.trim();
    if (!target) return false;
    if (target.startsWith('ssh://')) {
      setError('Workspaces SSH chegam na próxima versão — use uma pasta local.');
      return false;
    }
    await openWorkspace(target);
    const opened = useWorkspaceStore.getState().current?.path === target;
    if (!opened) {
      setError('Pasta inválida ou inacessível.');
      return false;
    }
    // The pane tree must belong to the new workspace BEFORE we spawn into it
    // (the App effect also switches, but asynchronously — this await removes
    // the race between hydration and the spawns below).
    await switchWorkspaceLayout(target);
    return true;
  }

  async function handleLaunchLibre() {
    if (spawning) return;
    setSpawning(true);
    setError(null);
    try {
      if (!(await ensureWorkspaceOpen())) return;
      launchLibrePanes(slots.slice(0, count), adapters);
      close();
    } finally {
      setSpawning(false);
    }
  }

  async function handleLaunchSquad() {
    if (spawning || !selectedSquad) return;
    setSpawning(true);
    setError(null);
    try {
      if (!(await ensureWorkspaceOpen())) return;
      const result = launchSquadMission(selectedSquad, installed);
      if (!result.ok) {
        setError(result.error ?? 'Falha ao iniciar o squad.');
        return;
      }
      close();
    } finally {
      setSpawning(false);
    }
  }

  return (
    <div className="wizard" role="dialog" aria-label={hasNewWsStep ? 'Novo workspace' : 'Nova missão'}>
      <div className="wizard__overlay" onClick={close} />
      <div className="wizard__panel">
        <header className="wizard__header">
          <span className="wizard__logo">&gt;_</span>
          <span className="wizard__title">
            {hasNewWsStep ? 'Novo workspace' : 'Nova Missão'}
          </span>
          <button className="wizard__close" onClick={close} aria-label="Fechar">
            ✕
          </button>
        </header>
        <StepsBar steps={steps} current={step} />

        <div className="wizard__body">
          {step === 'new-ws' && (
            <div className="wizard__section">
              <p className="wizard__label">PASTA / SSH</p>
              <div className="wizard__pasta">
                <input
                  className="wizard__input"
                  value={wsPath}
                  placeholder="/Users/…, ssh://host/path ou Procurar"
                  onChange={(e) => setWsPath(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && wsPath.trim() && setStep('mode')
                  }
                  autoFocus
                />
                <button className="wizard__browse" onClick={() => void browse()}>
                  PROCURAR
                </button>
              </div>
              {recents.length > 0 && (
                <div className="wizard__recent-chips">
                  {recents.slice(0, 5).map((ws) => (
                    <button
                      key={ws.path}
                      className="wizard__chip-recent"
                      onClick={() => setWsPath(ws.path)}
                      title={ws.path}
                    >
                      {ws.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="wizard__actions">
                <span />
                <div className="wizard__actions-right">
                  <button className="wizard__btn wizard__btn--ghost" onClick={close}>
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => setStep('mode')}
                    disabled={!wsPath.trim()}
                  >
                    Próximo ›
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 'mode' && (
            <div className="wizard__section">
              <p className="wizard__label">ESCOLHA O MODO</p>
              <div className="wizard__modes">
                <button
                  className={`wizard__mode ${mode === 'libre' ? 'wizard__mode--active' : ''}`}
                  onClick={() => chooseMode('libre')}
                >
                  <span className="wizard__mode-icon">&gt;_</span>
                  <span className="wizard__mode-title">Modo Livre</span>
                  <span className="wizard__mode-desc">
                    Escolha providers e quantidade de panes
                  </span>
                </button>
                <button
                  className={`wizard__mode ${mode === 'squad' ? 'wizard__mode--active' : ''}`}
                  onClick={() => chooseMode('squad')}
                  disabled={squads.length === 0}
                >
                  <span className="wizard__mode-icon">👥</span>
                  <span className="wizard__mode-title">Modo Squad</span>
                  <span className="wizard__mode-desc">
                    Use um preset de squad salvo
                    {squads.length === 0 && ' (nenhum squad salvo)'}
                  </span>
                </button>
              </div>
              <div className="wizard__actions">
                {hasNewWsStep ? (
                  <button className="wizard__btn" onClick={() => setStep('new-ws')}>
                    ‹ Voltar
                  </button>
                ) : (
                  <span />
                )}
                <button className="wizard__btn wizard__btn--ghost" onClick={close}>
                  Cancelar
                </button>
              </div>
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
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button className="wizard__btn wizard__btn--ghost" onClick={close}>
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => setStep('libre-slots')}
                  >
                    Próximo ›
                  </button>
                </div>
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
                      value={slots[i] ?? defaultSlot}
                      onChange={(e) =>
                        setSlots((prev) =>
                          prev.map((s, j) => (j === i ? e.target.value : s)),
                        )
                      }
                    >
                      <option value="shell">shell (terminal)</option>
                      {adapters.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.icon} {a.label}
                          {a.installed ? '' : ' — não instalado'}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {error && <p className="wizard__error">{error}</p>}
              <div className="wizard__actions">
                <button className="wizard__btn" onClick={() => setStep('libre-count')}>
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button className="wizard__btn wizard__btn--ghost" onClick={close}>
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => void handleLaunchLibre()}
                    disabled={spawning}
                  >
                    {spawning ? 'Iniciando…' : 'Iniciar Missão'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 'squad-select' && (
            <div className="wizard__section">
              {originals.length > 0 && (
                <>
                  <p className="wizard__label wizard__label--originals">
                    ✦ NEXUS ORIGINALS
                  </p>
                  <div className="wizard__squads">
                    {originals.map((s) => (
                      <button
                        key={s.id}
                        className={`wizard__squad ${squadId === s.id ? 'wizard__squad--active' : ''}`}
                        onClick={() => setSquadId(s.id)}
                      >
                        <span className="wizard__squad-name">
                          {s.name}{' '}
                          <span className="wizard__badge-original">ORIGINAL</span>
                        </span>
                        <span className="wizard__squad-count">{workerCount(s)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {userSquads.length > 0 && (
                <>
                  <p className="wizard__label">YOUR SQUADS</p>
                  <div className="wizard__squads">
                    {userSquads.map((s) => (
                      <button
                        key={s.id}
                        className={`wizard__squad ${squadId === s.id ? 'wizard__squad--active' : ''}`}
                        onClick={() => setSquadId(s.id)}
                      >
                        <span className="wizard__squad-name">👥 {s.name}</span>
                        <span className="wizard__squad-count">{workerCount(s)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="wizard__actions">
                <button className="wizard__btn" onClick={() => setStep('mode')}>
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button className="wizard__btn wizard__btn--ghost" onClick={close}>
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => setStep('squad-review')}
                    disabled={!squadId}
                  >
                    Revisar ›
                  </button>
                </div>
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
                      {a.effort ? ` · ${a.effort}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {error && <p className="wizard__error">{error}</p>}
              <div className="wizard__actions">
                <button className="wizard__btn" onClick={() => setStep('squad-select')}>
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button className="wizard__btn wizard__btn--ghost" onClick={close}>
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => void handleLaunchSquad()}
                    disabled={spawning}
                  >
                    {spawning ? 'Iniciando…' : 'Iniciar Squad'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
