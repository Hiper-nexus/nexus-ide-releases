import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { DEFAULT_ORCH_SETTINGS } from '../../shared/settings-types';
import { useOrchStore } from '../state/orch-store';
import { useWorkspaceStore } from '../state/workspace-store';
import {
  useMissionWizardStore,
  type MissionWizardStep,
} from '../state/mission-wizard-store';
import { useProviderStore } from '../state/provider-store';
import { switchWorkspaceLayout } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { useVoiceStore } from '../voice/voice-store';
import { isMissingModelKeyError } from '../lib/credential-errors';
import {
  buildIntentDispatchKickoffPrompt,
  initialGoalForArmedMission,
  launchLibrePanes,
  launchSquadMission,
} from '../orch/mission-launcher';
import { balanceSquadRosterCli } from '../orch/squad-roster';
import { CloseButton } from './CloseButton';
import { MissionWizardReview } from './MissionWizardReview';
import { PixelIcon } from './PixelIcon';
import type { Mission } from '../../shared/orch-types';

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
type Step = MissionWizardStep;

const PANE_COUNTS = [1, 2, 3, 4, 6];

const STEP_LABELS: Record<Step, string> = {
  'new-ws': 'Pasta',
  mode: 'Modo',
  'libre-count': 'Panes',
  'libre-slots': 'Providers',
  'squad-select': 'Squad',
  'agentic-intent': 'Objetivo',
  'squad-review': 'Revisar',
  'intent-compose': 'Objetivo',
  'intent-plan': 'Plano',
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
  const storeArmedMissionId = useMissionWizardStore((s) => s.armedMissionId);
  const agenticIntent = useMissionWizardStore((s) => s.agenticIntent);
  const agenticLaunchNonce = useMissionWizardStore((s) => s.agenticLaunchNonce);
  const squadPickerNonce = useMissionWizardStore((s) => s.squadPickerNonce);
  const voiceLaunchNonce = useMissionWizardStore((s) => s.voiceLaunchNonce);
  const close = useMissionWizardStore((s) => s.close);
  const squads = useOrchStore((s) => s.squads);
  const providers = useProviderStore((s) => s.providers);
  const recents = useWorkspaceStore((s) => s.recents);
  const openWorkspace = useWorkspaceStore((s) => s.open);

  const hasNewWsStep = variant === 'workspace';

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [orchestratorAdapterId, setOrchestratorAdapterId] = useState(
    DEFAULT_ORCH_SETTINGS.defaultAdapterId,
  );
  const [step, setStep] = useState<Step>('mode');
  const stepRef = useRef<Step>('mode');
  stepRef.current = step;
  const handledAgenticLaunchRef = useRef(0);
  const handledSquadPickerRef = useRef(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const [wsPath, setWsPath] = useState('');
  const [count, setCount] = useState(2);
  const [slots, setSlots] = useState<string[]>([]);
  const [squadId, setSquadId] = useState('');
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Intent-first: armed mission shell awaiting an explicit goal (0 tokens).
  const [armedMissionId, setArmedMissionId] = useState<string | null>(null);
  const [missionGoal, setMissionGoal] = useState('');
  /** standard = code PREVC; consult = read-only investigation contract. */
  const [missionLane, setMissionLane] = useState<'standard' | 'consult'>(
    'standard',
  );
  const [plannedMission, setPlannedMission] = useState<Mission | null>(null);
  const armedMissionSnapshot = useOrchStore((state) =>
    armedMissionId
      ? state.missions.find((mission) => mission.id === armedMissionId) ?? null
      : null,
  );
  const [prepareStatus, setPrepareStatus] = useState<
    'idle' | 'running' | 'ready' | 'cancelled' | 'error'
  >('idle');
  const [prepareDetail, setPrepareDetail] = useState<string | null>(null);
  /** Intent prompt queue surface: executing / queued / cancelled counts. */
  const [promptQueueHint, setPromptQueueHint] = useState<string | null>(null);
  const prepareGenerationRef = useRef(0);
  // Modo Agêntico: intenção em linguagem natural + estado do arquiteto.
  const [intent, setIntent] = useState('');
  const [designing, setDesigning] = useState(false);
  // Editable copy of the selected squad's roster (cli/model/effort per agent).
  const [roster, setRoster] = useState<SquadAgent[]>([]);
  const [rosterSaved, setRosterSaved] = useState(false);
  const [highlightedAgentId, setHighlightedAgentId] = useState<string | null>(null);
  const designRequestRef = useRef(0);
  const designInFlightRef = useRef(false);

  // Voice submits through main authority too. Follow the project-scoped
  // mission broadcast so that an externally submitted goal reaches the same
  // review screen instead of leaving the wizard on a stale composer.
  useEffect(() => {
    const snapshot = armedMissionSnapshot;
    const isReviewable =
      snapshot?.intentState === 'ready_to_start' ||
      snapshot?.intentState === 'awaiting_approval';
    const isCurrent =
      snapshot?.intentContract?.intentVersion === snapshot?.intentVersion;
    if (
      !open ||
      !snapshot ||
      !isReviewable ||
      !isCurrent ||
      !snapshot.intentContract?.goal ||
      plannedMission?.intentVersion === snapshot.intentVersion
    ) {
      return;
    }
    setMissionGoal(snapshot.intentContract.goal);
    setPlannedMission(snapshot);
    setStep('intent-plan');
  }, [
    open,
    armedMissionSnapshot,
    plannedMission?.intentVersion,
  ]);

  // Surface prompt-queue state (executing / queued / cancelled) while composing.
  useEffect(() => {
    if (!open || step !== 'intent-compose' || !armedMissionId) {
      setPromptQueueHint(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void window.nexus.orch
        .getMissionPromptQueue?.({ missionId: armedMissionId })
        .then((snap) => {
          if (cancelled || !snap) return;
          const exec = snap.executing
            ? `${snap.executing.kind}:${snap.executing.status}`
            : '—';
          setPromptQueueHint(
            `Fila da missão · exec=${exec} · queued=${snap.queued.length} · cancelled=${snap.cancelled.length}`,
          );
        })
        .catch(() => {
          /* optional API */
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, step, armedMissionId, prepareStatus]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.nexus.adapters
      .list()
      .then((list) => {
        if (!cancelled) setAdapters(list);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Falha ao carregar os providers.',
          );
        }
      });
    void window.nexus.settings
      .orchGet()
      .then((settings) => {
        if (!cancelled) {
          setOrchestratorAdapterId(
            settings.defaultAdapterId || DEFAULT_ORCH_SETTINGS.defaultAdapterId,
          );
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Falha ao carregar o provider do orquestrador.',
          );
        }
      });
    // Voice may target Modo Agêntico directly. The nonce matters when this
    // wizard was already open on another mode or with a previous objective.
    if (
      agenticLaunchNonce > handledAgenticLaunchRef.current &&
      stepRef.current !== 'squad-review'
    ) {
      handledAgenticLaunchRef.current = agenticLaunchNonce;
      setMode('agentic');
      setSquadId('');
      setIntent(agenticIntent ?? '');
      setStep('agentic-intent');
    // Selecting an existing squad is a distinct intent from designing one.
    // A monotonic nonce also switches an already-open wizard reliably.
    } else if (squadPickerNonce > handledSquadPickerRef.current) {
      handledSquadPickerRef.current = squadPickerNonce;
      setMode('squad');
      setSquadId('');
      setIntent('');
      setStep('squad-select');
    // Intent-first: already-armed mission jumps to the goal composer.
    } else if (presetSquadId && storeArmedMissionId) {
      setMode('squad');
      setSquadId(presetSquadId);
      setArmedMissionId(storeArmedMissionId);
      setMissionGoal('');
      setMissionLane('standard');
      setPlannedMission(null);
      setIntent('');
      setStep('intent-compose');
    // A preset squad (Home deck shortcut) skips MODO/SQUAD straight to review.
    } else if (presetSquadId) {
      setMode('squad');
      setSquadId(presetSquadId);
      setArmedMissionId(null);
      setIntent('');
      setStep('squad-review');
    } else {
      setStep(hasNewWsStep ? 'new-ws' : 'mode');
      setMode(null);
      setSquadId('');
      setArmedMissionId(null);
      setIntent('');
    }
    const workspaceState = useWorkspaceStore.getState();
    setWsPath(
      hasNewWsStep
        ? workspaceState.current?.path ?? workspaceState.recents[0]?.path ?? ''
        : '',
    );
    setCount(2);
    setSlots([]);
    setError(null);
    // A previous design request may have hung or completed after the modal was
    // closed. Every fresh open must be interactive again.
    setDesigning(false);
    return () => {
      cancelled = true;
      designRequestRef.current += 1;
    };
  }, [
    open,
    hasNewWsStep,
    presetSquadId,
    storeArmedMissionId,
    agenticIntent,
    agenticLaunchNonce,
    squadPickerNonce,
  ]);

  useEffect(() => {
    if (!open) return;
    useMissionWizardStore.getState().setVisibleStep(step);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

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
    if (mode === 'squad') {
      const base: Step[] = [...prefix, 'mode', 'squad-select', 'squad-review'];
      // Only surface intent steps once a mission shell is actually armed.
      if (armedMissionId || step === 'intent-compose' || step === 'intent-plan') {
        return [...base, 'intent-compose', 'intent-plan'];
      }
      return base;
    }
    if (mode === 'agentic') return [...prefix, 'mode', 'agentic-intent', 'squad-review'];
    if (mode === 'libre') return [...prefix, 'mode', 'libre-count', 'libre-slots'];
    return [...prefix, 'mode'];
  }, [mode, hasNewWsStep, armedMissionId, step]);

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

  // Load the selected squad into an editable copy. The orchestrator follows the
  // provider selected in Settings; workers stay distributed across the other
  // enabled CLIs.
  useEffect(() => {
    const sq = squads.find((s) => s.id === squadId);
    setRoster(
      sq
        ? balanceSquadRosterCli(
            sq.agents,
            rosterAdapters,
            orchestratorAdapterId,
          )
        : [],
    );
    setRosterSaved(false);
  }, [squadId, squads, rosterAdapters, orchestratorAdapterId]);

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
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-agent-id="${invalid.id}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Overclock wizard-fire: Live/Classic confirm_squad bumps voiceLaunchNonce.
  // MUST live before any early return so the hook count is stable every render.
  useEffect(() => {
    if (!open || voiceLaunchNonce <= 0) return;
    if (!selectedSquad || spawning) return;
    if (step === 'squad-review') {
      void handleLaunchSquad();
    } else if (step === 'intent-plan' && plannedMission) {
      void handleStartFromIntentPlan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on nonce
  }, [voiceLaunchNonce]);

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
    try {
      const picked = await window.nexus.workspace.pickPath();
      if (!picked) return;
      setWsPath(picked);
      if (hasNewWsStep) setStep('mode');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Não consegui abrir o seletor de pasta.';
      setError(message);
      useToastStore.getState().push('error', 'Falha ao procurar pasta', message);
    }
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
    if (designInFlightRef.current || designing || !intent.trim()) return;
    designInFlightRef.current = true;
    const requestId = ++designRequestRef.current;
    const isCurrentRequest = () =>
      designRequestRef.current === requestId &&
      useMissionWizardStore.getState().open;
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
      const designOnce = async () => {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
          return await Promise.race([
            window.nexus.orch.designSquad(workspacePath, intent.trim()),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('O arquiteto demorou demais. Tente novamente.')),
                10_000,
              );
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      };
      const res = await designOnce();
      if (!isCurrentRequest()) return;
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
      if (res.warning) {
        useToastStore.getState().push('warn', 'Doctor recuperou o arquiteto', res.warning);
      }
      // O squad já foi salvo no main — garantir que a lista local o contém
      // antes de renderizar a revisão.
      await useOrchStore.getState().hydrate(workspacePath);
      if (!isCurrentRequest()) return;
      if (!useOrchStore.getState().squads.some((squad) => squad.id === res.squad!.id)) {
        throw new Error('O time foi criado, mas não apareceu no catálogo local.');
      }
      setSquadId(res.squad.id);
      setStep('squad-review');
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : 'Não consegui montar o time. Tente novamente.';
      if (!isCurrentRequest()) return;
      setError(message);
      useToastStore.getState().push(
        'error',
        'O Doctor liberou o wizard após a falha',
        message,
      );
    } finally {
      designInFlightRef.current = false;
      if (isCurrentRequest()) setDesigning(false);
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
      // Launch with the reviewed roster. Pass all adapters so preflight can
      // explain an unavailable configured provider instead of failing silently.
      const result = await launchSquadMission(effectiveSquad, adapters);
      if (!result.ok) {
        setError(result.error ?? 'Falha ao iniciar o squad.');
        useToastStore
          .getState()
          .push('error', 'Não deu pra iniciar o squad', result.error);
        return;
      }
      // Intent-first: squad is armed with zero agent panes / tokens.
      if (result.armed && result.missionId) {
        setArmedMissionId(result.missionId);
        setMissionGoal(
          initialGoalForArmedMission({
            isAgentic: mode === 'agentic',
            designedIntent: intent,
          }),
        );
        setPlannedMission(null);
        setStep('intent-compose');
        useToastStore
          .getState()
          .push(
            'info',
            `${selectedSquad.name} pronto`,
            'Aguardando seu objetivo. Nenhum especialista iniciado. 0 tokens usados.',
          );
        return;
      }
      close();
    } finally {
      setSpawning(false);
    }
  }

  async function handleSubmitMissionGoal() {
    if (spawning || !armedMissionId || !missionGoal.trim()) return;
    if (prepareStatus === 'running') {
      prepareGenerationRef.current += 1;
    }
    setSpawning(true);
    setError(null);
    try {
      const planned = await window.nexus.orch.submitMissionIntent({
        missionId: armedMissionId,
        goal: missionGoal.trim(),
        source: 'typed',
        lane: missionLane,
      });
      setPlannedMission(planned);
      setStep('intent-plan');
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Falha ao compilar o objetivo.';
      setError(message);
    } finally {
      setSpawning(false);
    }
  }

  async function handlePrepareProject() {
    if (!armedMissionId || prepareStatus === 'running') return;
    const generation = ++prepareGenerationRef.current;
    setPrepareStatus('running');
    setPrepareDetail('Autorizando preparação e aquecendo o mapa local…');
    setError(null);
    try {
      await window.nexus.orch.prepareMissionProject({ missionId: armedMissionId });
      // Main owns the cancellable warm; renderer only reads the completed snapshot.
      const map = await window.nexus.orientation.get().catch(() => null);
      if (generation !== prepareGenerationRef.current) return;
      const queue = await window.nexus.orch
        .getMissionPromptQueue?.({ missionId: armedMissionId })
        .catch(() => null);
      const queueHint = queue
        ? ` Fila: exec=${queue.executing?.kind ?? '—'} · queued=${queue.queued.length} · cancelled=${queue.cancelled.length}.`
        : '';
      if (map && (map.status === 'ready' || map.status === 'partial')) {
        setPrepareStatus('ready');
        setPrepareDetail(
          `Mapa ${map.status} (hash ${map.mapHash?.slice(0, 8) ?? '—'}). Sem workers e sem gasto de execução.${queueHint}`,
        );
      } else {
        setPrepareStatus('ready');
        setPrepareDetail(
          `Preparação autorizada. Mapa ainda aquecendo em background — pode descrever o objetivo.${queueHint}`,
        );
      }
    } catch (cause) {
      if (generation !== prepareGenerationRef.current) return;
      setPrepareStatus('error');
      const message =
        cause instanceof Error ? cause.message : 'Falha ao preparar o projeto.';
      setPrepareDetail(message);
      setError(message);
    }
  }

  function handleCancelPrepare() {
    prepareGenerationRef.current += 1;
    setPrepareStatus('cancelled');
    setPrepareDetail('Preparação cancelada. A missão continua aguardando objetivo.');
    if (armedMissionId) {
      void window.nexus.orch
        .cancelMissionPreparation({ missionId: armedMissionId })
        .catch(() => undefined);
    }
  }

  function handleOpenEmptyTerminal() {
    launchLibrePanes(['shell'], adapters);
    close();
  }

  async function handleStartFromIntentPlan() {
    if (spawning || !selectedSquad || !plannedMission?.id) return;
    setSpawning(true);
    setError(null);
    try {
      const contract = plannedMission.intentContract;
      if (!contract?.goal) {
        setError('Contrato de intenção ausente antes do despacho.');
        return;
      }
      const effectiveSquad: Squad = { ...selectedSquad, agents: roster };
      const { compactMissionContext, renderMissionCompact } = await import(
        '../../shared/mission-context-compact'
      );
      const compact = compactMissionContext({
        mission: plannedMission,
        handoffs: [],
      });
      const goalPrompt = buildIntentDispatchKickoffPrompt({
        squad: effectiveSquad,
        missionId: plannedMission.id,
        goal: contract.goal,
        acceptanceCriteria: contract.acceptanceCriteria,
        risk: contract.risk,
        maxWorkers: contract.budgets.maxWorkers,
        compactMemoryMarkdown: renderMissionCompact(compact),
        lane: contract.lane ?? 'standard',
      });
      const result = await launchSquadMission(effectiveSquad, adapters, {
        existingMissionId: plannedMission.id,
        goalPrompt,
        authorizeDispatch: async () => {
          const approved = await window.nexus.orch.approveMissionIntent({
            missionId: plannedMission.id,
          });
          if (
            approved.intentVersion !== plannedMission.intentVersion ||
            approved.intentContract?.goal !== contract.goal
          ) {
            throw new Error('O objetivo mudou durante o preflight; revise o plano novamente.');
          }
        },
      });
      if (!result.ok) {
        setError(result.error ?? 'Falha ao despachar a missão.');
        useToastStore
          .getState()
          .push('error', 'Não deu pra iniciar a execução', result.error);
        return;
      }
      close();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Falha ao iniciar a execução.';
      setError(message);
    } finally {
      setSpawning(false);
    }
  }

  return (
    <div
      className="wizard"
      role="dialog"
      aria-modal="true"
      aria-label={hasNewWsStep ? 'Novo workspace' : 'Nova missão'}
    >
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
              providers={providers}
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

          {step === 'intent-compose' && selectedSquad && (
            <div className="wizard__section">
              <p className="wizard__label">{selectedSquad.name.toUpperCase()} PRONTO</p>
              <p className="wizard__mode-desc" style={{ marginBottom: 12 }}>
                Aguardando seu objetivo. Nenhum especialista iniciado.{' '}
                <strong>0 tokens de modelo usados.</strong>
              </p>
              {promptQueueHint && (
                <p
                  className="wizard__mode-desc"
                  style={{ marginBottom: 10, opacity: 0.85 }}
                  aria-live="polite"
                >
                  {promptQueueHint}
                </p>
              )}
              <textarea
                className="wizard__input"
                style={{ minHeight: 120, resize: 'vertical' }}
                value={missionGoal}
                placeholder="Descreva o objetivo da missão…"
                onChange={(e) => setMissionGoal(e.target.value)}
                autoFocus
              />
              <fieldset
                className="wizard__mode-desc"
                style={{
                  marginTop: 12,
                  marginBottom: 4,
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <legend style={{ padding: '0 4px' }}>Tipo de entrega</legend>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
                  <input
                    type="radio"
                    name="mission-lane"
                    checked={missionLane === 'standard'}
                    onChange={() => setMissionLane('standard')}
                  />
                  <span>
                    <strong>Código (PREVC)</strong> — worktrees, workers e
                    conclusão só com receipts imutáveis.
                  </span>
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="radio"
                    name="mission-lane"
                    checked={missionLane === 'consult'}
                    onChange={() => setMissionLane('consult')}
                  />
                  <span>
                    <strong>Consulta (somente leitura)</strong> — logs, status,
                    doctor; sem editar código. Done exige learning durável.
                  </span>
                </label>
              </fieldset>
              <div
                className="wizard__mode-desc"
                style={{ marginTop: 12, marginBottom: 8 }}
              >
                <p style={{ marginBottom: 6 }}>
                  <strong>Preparar projeto</strong> (opcional): aquece o mapa local
                  do repositório. Não abre agentes nem inventa tarefas. Você pode
                  ocultar o andamento; o aquecimento local pode terminar em segundo plano.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="wizard__btn wizard__btn--ghost"
                    disabled={prepareStatus === 'running' || !armedMissionId}
                    onClick={() => void handlePrepareProject()}
                  >
                    {prepareStatus === 'running'
                      ? 'Preparando…'
                      : prepareStatus === 'ready'
                        ? 'Preparar de novo'
                        : 'Preparar projeto'}
                  </button>
                  {prepareStatus === 'running' && (
                    <button
                      type="button"
                      className="wizard__btn wizard__btn--ghost"
                      onClick={handleCancelPrepare}
                    >
                      Cancelar preparação
                    </button>
                  )}
                  <button
                    type="button"
                    className="wizard__btn wizard__btn--ghost"
                    onClick={handleOpenEmptyTerminal}
                  >
                    Abrir terminal vazio
                  </button>
                </div>
                {prepareDetail && (
                  <p style={{ marginTop: 8 }} aria-live="polite">
                    {prepareDetail}
                  </p>
                )}
              </div>
              {error && <p className="wizard__error">{error}</p>}
              <div className="wizard__actions">
                <button
                  className="wizard__btn wizard__btn--ghost"
                  onClick={() => setStep('squad-review')}
                >
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button className="wizard__btn wizard__btn--ghost" onClick={close}>
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    disabled={spawning || !missionGoal.trim()}
                    onClick={() => void handleSubmitMissionGoal()}
                  >
                    {spawning ? 'Compilando…' : 'Continuar ›'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 'intent-plan' && selectedSquad && plannedMission && (
            <div className="wizard__section">
              <p className="wizard__label">PLANO RESUMIDO</p>
              <p className="wizard__mode-desc">
                <strong>Objetivo:</strong>{' '}
                {plannedMission.intentContract?.goal ?? plannedMission.description}
              </p>
              {plannedMission.intentContract && (
                <>
                  <p className="wizard__mode-desc">
                    <strong>Lane:</strong>{' '}
                    {plannedMission.intentContract.lane === 'consult'
                      ? 'consulta (somente leitura)'
                      : 'código (PREVC)'}
                    {' · '}
                    <strong>Risco:</strong> {plannedMission.intentContract.risk}
                    {' · '}
                    <strong>Workers máx.:</strong>{' '}
                    {plannedMission.intentContract.budgets.maxWorkers}
                  </p>
                  <ul className="wizard__mode-desc">
                    {plannedMission.intentContract.acceptanceCriteria.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </>
              )}
              {plannedMission.intentState === 'awaiting_approval' && (
                <p className="wizard__mode-desc">
                  Superfície sensível detectada — confirme o plano antes de
                  despachar especialistas.
                </p>
              )}
              <p className="wizard__mode-desc">
                Depois de começar, o Nexus pilota implementação, revisão e QA
                pelo PREVC. Ele só volta a você para uma decisão real, uma
                autorização sensível ou um bloqueio comprovado.
              </p>
              {error && <p className="wizard__error">{error}</p>}
              <div className="wizard__actions">
                <button
                  className="wizard__btn wizard__btn--ghost"
                  onClick={() => setStep('intent-compose')}
                >
                  ‹ Editar objetivo
                </button>
                <div className="wizard__actions-right">
                  <button className="wizard__btn wizard__btn--ghost" onClick={close}>
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    disabled={spawning}
                    onClick={() => void handleStartFromIntentPlan()}
                  >
                    {spawning
                      ? 'Iniciando…'
                      : plannedMission.intentState === 'awaiting_approval'
                        ? 'Confirmar e começar'
                        : 'Começar'}
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
