import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useProviderStore } from '../state/provider-store';
import { switchWorkspaceLayout } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { useVoiceStore } from '../voice/voice-store';
import { isMissingModelKeyError } from '../lib/credential-errors';
import { launchLibrePanes, launchSquadMission } from '../orch/mission-launcher';
import { balanceSquadRosterCli } from '../orch/squad-roster';
import { CloseButton } from './CloseButton';
import { MissionWizardReview } from './MissionWizardReview';
import { PixelIcon } from './PixelIcon';

/**
 * "Novo workspace" / "Nova Missão" wizard — the full flow:
 *   PASTA (novo workspace) → MODO → Livre: PANES → PROVIDERS
 *                                 → Squad: SQUAD → REVISAR
 *                                 → Agêntico: OBJETIVO → REVISAR
 * Copy, step breadcrumb, mode cards and the squad list (ORIGINALS + YOUR
 * SQUADS with "orq + N workers") drive the mission setup. No modo Agêntico o
 * usuário descreve o objetivo, o Squad Architect monta o time sob medida e o
 * wizard cai direto na revisão do roster para disparar.
 */

type Mode = 'libre' | 'squad' | 'agentic';
type Step =
  | 'new-ws'
  | 'mode'
  | 'libre-count'
  | 'libre-slots'
  | 'squad-select'
  | 'agentic-intent'
  | 'squad-review';

const PANE_COUNTS = [1, 2, 3, 4, 6];

const STEP_LABELS: Record<Step, string> = {
  'new-ws': 'Pasta',
  mode: 'Modo',
  'libre-count': 'Panes',
  'libre-slots': 'Providers',
  'squad-select': 'Squad',
  'agentic-intent': 'Objetivo',
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
  const presetSquadId = useMissionWizardStore((s) => s.presetSquadId);
  const close = useMissionWizardStore((s) => s.close);
  const squads = useOrchStore((s) => s.squads);
  const providers = useProviderStore((s) => s.providers);
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
  // Modo Agêntico: intenção em linguagem natural + estado do arquiteto.
  const [intent, setIntent] = useState('');
  const [designing, setDesigning] = useState(false);
  // Editable copy of the selected squad's roster (cli/model/effort per agent).
  const [roster, setRoster] = useState<SquadAgent[]>([]);
  const [rosterSaved, setRosterSaved] = useState(false);
  const [highlightedAgentId, setHighlightedAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.nexus.adapters.list().then(setAdapters);
    // A preset squad (Home deck shortcut) skips MODO/SQUAD straight to review.
    if (presetSquadId) {
      setMode('squad');
      setSquadId(presetSquadId);
      setStep('squad-review');
    } else {
      setStep(hasNewWsStep ? 'new-ws' : 'mode');
      setMode(null);
      setSquadId('');
    }
    setWsPath('');
    setCount(2);
    setSlots([]);
    setError(null);
  }, [open, hasNewWsStep, presetSquadId]);

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
    if (mode === 'agentic') return [...prefix, 'mode', 'agentic-intent', 'squad-review'];
    if (mode === 'libre') return [...prefix, 'mode', 'libre-count', 'libre-slots'];
    return [...prefix, 'mode'];
  }, [mode, hasNewWsStep]);

  const originals = squads.filter((s) => s.builtin);
  const userSquads = squads.filter((s) => !s.builtin);
  const selectedSquad = squads.find((s) => s.id === squadId) ?? null;
  const rosterAdapters = useMemo(
    () =>
      adapters.map((adapter) => {
        const provider = providers.find((item) => item.adapterId === adapter.id);
        return { ...adapter, enabled: provider?.enabled ?? true };
      }),
    [adapters, providers],
  );

  // Derived: which worker (if any) has allowedTools == null (the guard condition).
  // Used to disable "Iniciar Squad" reactively without running the guard imperative.
  const rosterInvalidAgent = useMemo(
    () =>
      roster.find(
        (a) => a.category !== 'orchestrator' && a.allowedTools == null,
      ) ?? null,
    [roster],
  );

  // Load the selected squad's roster into an editable copy. The orchestrator is
  // FORCED onto Claude: only Claude Code reliably drives the embedded nexus MCP
  // server (spawning + coordinating worker panes via nexus_pane_* tools). Codex,
  // Grok, Gemini et al. boot fine as WORKERS, so they are auto-distributed across
  // the roster and stay fully editable (any CLI/model/effort).
  useEffect(() => {
    const sq = squads.find((s) => s.id === squadId);
    setRoster(sq ? balanceSquadRosterCli(sq.agents, rosterAdapters) : []);
    setRosterSaved(false);
  }, [squadId, squads, rosterAdapters]);

  // Preflight: when the REVISAR step opens, immediately highlight the first
  // agent that will block launch so the user sees the issue before clicking.
  useEffect(() => {
    if (step !== 'squad-review') {
      setHighlightedAgentId(null);
      return;
    }
    const invalid = roster.find(
      (a) => a.category !== 'orchestrator' && a.allowedTools == null,
    );
    if (invalid) {
      setHighlightedAgentId(invalid.id);
      setError(
        `Worker "${invalid.agentName}" está com tools bloqueadas (campo nulo). ` +
          'Liste tools explícitas (ex.: Bash, Read, Edit) ou deixe vazio para bloquear todas.',
      );
      // Scroll the offending row into view.
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-agent-id="${invalid.id}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function updateAgent(id: string, patch: Partial<SquadAgent>) {
    setRoster((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    setRosterSaved(false);
    // Clear the preflight highlight once the user fixes this agent's tool list.
    if (id === highlightedAgentId && 'allowedTools' in patch && patch.allowedTools != null) {
      setHighlightedAgentId(null);
      setError(null);
    }
  }

  function validateWorkerToolScopes(agents: SquadAgent[]): boolean {
    const unsafe = agents.find(
      (agent) => agent.category !== 'orchestrator' && agent.allowedTools == null,
    );
    if (!unsafe) return true;
    const message =
      `Worker "${unsafe.agentName}" está sem allowlist de tools. ` +
      'No campo "tools" desse worker, liste as ferramentas permitidas (ex.: Bash, Read, Edit) ' +
      'ou deixe vazio para bloquear todas. ' +
      'O wildcard * só é permitido no orquestrador.';
    setError(message);
    setHighlightedAgentId(unsafe.id);
    useToastStore.getState().push('error', 'Allowlist insegura', message);
    return false;
  }

  async function saveRoster() {
    if (!selectedSquad) return;
    if (!validateWorkerToolScopes(roster)) return;
    const res = await window.nexus.orch.saveSquad({
      ...selectedSquad,
      agents: roster,
    });
    setRosterSaved(res.ok);
    if (!res.ok) {
      useToastStore
        .getState()
        .push('error', 'Não deu pra salvar', res.error);
    }
  }

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
    } else if (next === 'agentic') {
      setStep('agentic-intent');
    } else {
      if (!squadId) setSquadId(squads[0]?.id ?? '');
      setStep('squad-select');
    }
  }

  /** Modo Agêntico: intenção → arquiteto monta o time → revisão do roster. */
  async function handleDesignFromIntent() {
    if (designing || !intent.trim()) return;
    setDesigning(true);
    setError(null);
    try {
      const workspacePath = hasNewWsStep
        ? wsPath.trim()
        : useWorkspaceStore.getState().current?.path ?? wsPath.trim();
      if (!workspacePath) {
        setError('Abra (ou informe) um workspace antes de montar o time.');
        return;
      }
      const res = await window.nexus.orch.designSquad(workspacePath, intent.trim());
      if (!res.ok || !res.squad) {
        const message = res.error ?? 'Não consegui montar o time.';
        if (isMissingModelKeyError(message)) {
          setError('Configure uma key de modelo para montar o time sob medida.');
          useVoiceStore.getState().openSettings();
        } else {
          setError(message);
        }
        return;
      }
      // O squad já foi salvo no main — garantir que a lista local o contém
      // antes de renderizar a revisão.
      await useOrchStore.getState().hydrate();
      setSquadId(res.squad.id);
      setStep('squad-review');
    } finally {
      setDesigning(false);
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
      const effectiveSquad: Squad = { ...selectedSquad, agents: roster };
      if (!validateWorkerToolScopes(effectiveSquad.agents)) return;
      if (!(await ensureWorkspaceOpen())) return;
      // Launch with the EDITED roster (the user may have changed the
      // orchestrator's CLI/model in the review step). Pass ALL adapters so the
      // orchestrator pane always opens (install hint shows in-pane if needed).
      const result = launchSquadMission(effectiveSquad, adapters);
      if (!result.ok) {
        setError(result.error ?? 'Falha ao iniciar o squad.');
        useToastStore
          .getState()
          .push('error', 'Não deu pra iniciar o squad', result.error);
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
          <CloseButton className="wizard__close" onClick={close} label="Fechar" />
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
                  <span className="wizard__mode-icon">
                    <PixelIcon name="terminal" size={22} />
                  </span>
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
                  <span className="wizard__mode-icon">
                    <PixelIcon name="users" size={22} />
                  </span>
                  <span className="wizard__mode-title">Modo Squad</span>
                  <span className="wizard__mode-desc">
                    Use um preset de squad salvo
                    {squads.length === 0 && ' (nenhum squad salvo)'}
                  </span>
                </button>
                <button
                  className={`wizard__mode ${mode === 'agentic' ? 'wizard__mode--active' : ''}`}
                  onClick={() => chooseMode('agentic')}
                >
                  <span className="wizard__mode-icon">
                    <PixelIcon name="bolt" size={22} />
                  </span>
                  <span className="wizard__mode-title">Modo Agêntico</span>
                  <span className="wizard__mode-desc">
                    Descreva o que quer — a IA monta o time e dispara
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

          {step === 'agentic-intent' && (
            <div className="wizard__section">
              <p className="wizard__label">O QUE VOCÊ QUER?</p>
              <textarea
                className="wizard__input wizard__intent"
                value={intent}
                rows={4}
                placeholder={
                  'ex.: "landing page premium espelhando o site X" · ' +
                  '"auditar segurança da API de pagamentos" · ' +
                  '"corrigir todos os testes quebrados"'
                }
                onChange={(e) => setIntent(e.target.value)}
                autoFocus
              />
              <p className="wizard__hint-sm">
                O arquiteto lê seu objetivo + a stack do workspace e monta o
                time sob medida (QA, security e UX entram quando o objetivo
                pede). Você revisa o roster antes de disparar.
              </p>
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
                    onClick={() => void handleDesignFromIntent()}
                    disabled={designing || !intent.trim()}
                  >
                    {designing ? (
                      'Montando o time…'
                    ) : (
                      <>
                        <PixelIcon name="bolt" />
                        Montar time
                      </>
                    )}
                  </button>
                </div>
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
                        <span className="wizard__squad-name">
                          <PixelIcon name="users" /> {s.name}
                        </span>
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
            <MissionWizardReview
              squad={selectedSquad}
              roster={roster}
              adapters={adapters}
              highlightedAgentId={highlightedAgentId}
              error={error}
              spawning={spawning}
              rosterSaved={rosterSaved}
              rosterInvalidAgent={rosterInvalidAgent}
              onSaveRoster={() => void saveRoster()}
              onUpdateAgent={updateAgent}
              onError={setError}
              onBack={() =>
                setStep(mode === 'agentic' ? 'agentic-intent' : 'squad-select')
              }
              onCancel={close}
              onLaunch={() => void handleLaunchSquad()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
