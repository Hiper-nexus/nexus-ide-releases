import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AdapterInfo } from "../../shared/types";
import {
  isEngineGeneratedSquadId,
  isMissionRuntimeSquadId,
} from "../../shared/orch-types";
import type { Squad, SquadAgent } from "../../shared/orch-types";
import {
  DEFAULT_ORCH_SETTINGS,
  type SquadCliPolicy,
} from "../../shared/settings-types";
import {
  missionTitleFromGoal,
  retargetSquadInstructions,
} from "../../shared/mission-identity";
import { useOrchStore } from "../state/orch-store";
import { useWorkspaceStore } from "../state/workspace-store";
import {
  isMissionWizardDraftDirty,
  useMissionWizardStore,
  type MissionWizardDraft,
  type MissionWizardStep,
  type WizardMode,
} from "../state/mission-wizard-store";
import { useProviderStore } from "../state/provider-store";
import { useAccountStore } from "../state/account-store";
import { switchWorkspaceLayout } from "../state/layout-store";
import { useToastStore } from "../state/toast-store";
import { useVoiceStore } from "../voice/voice-store";
import { isMissingModelKeyError } from "../lib/credential-errors";
import { toUserFacingMissionError } from "../lib/user-facing-mission-error";
import {
  buildMissionAttachmentsContext,
  type MissionAttachment,
} from "../lib/mission-attachments";
import { createDraftHydrationBarrier } from "../lib/ui-overlay-policy";
import {
  buildIntentDispatchKickoffPrompt,
  initialGoalForArmedMission,
  launchLibrePanes,
  launchSquadMission,
} from "../orch/mission-launcher";
import { applySquadEdit } from "../../shared/squad-edit";
import { balanceSquadRosterCli } from "../orch/squad-roster";
import { automaticOrchestratorAdapterId } from "../orch/orchestrator-runtime";
import { isAdapterModelAuthenticated } from "../orch/mission-runtime-readiness";
import { CloseButton } from "./CloseButton";
import { MissionWizardReview } from "./MissionWizardReview";
import { MissionWizardPlanReview } from "./MissionWizardPlanReview";
import { MissionAttachmentPicker } from "./MissionAttachmentPicker";
import { MissionModePicker } from "./MissionModePicker";
import { PixelIcon } from "./PixelIcon";
import type { MissionOrchestrationMode } from "../../shared/mission-wave-pack";
import {
  WAVE_PACK_TEMPLATES,
  type WavePackTemplateId,
} from "../../shared/wave-pack-templates";
import type { Mission } from "../../shared/orch-types";
import {
  missionGoalNeedsFutureEvidence,
  MISSION_EVIDENCE_WAIT_MESSAGE,
} from "../../shared/mission-evidence";
import {
  suggestMissionLaneFromGoal,
  type MissionIntentSource,
  type MissionLane,
} from "../../shared/mission-intent";
import { isUiMissionText } from "../../shared/mission-work-kind";
import { NEXUS_PLAN_SQUAD_ID } from "../../shared/builtin-squad-ids";
import {
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACTIVE_STORAGE_KEY,
  REAL_MISSION_E2E_SQUAD_ID,
} from "../../shared/real-mission-e2e";
import { recordRealMissionProductWizardStep } from "../lib/real-mission-product-wizard-e2e";

/**
 * "Novo workspace" / "Nova Missão" wizard — the full flow:
 *   PASTA (novo workspace) → MODO → Livre: PANES → PROVIDERS
 *                                 → Squad: SQUAD → REVISAR
 *                                 → Agêntico: OBJETIVO → REVISAR
 * Copy, step breadcrumb, mode cards and the squad list (ORIGINALS + YOUR
 * SQUADS with "orquestrador + N agentes") drive the mission setup. No modo Agêntico o
 * usuário descreve o objetivo, o Squad Architect monta o time sob medida e o
 * wizard cai direto na revisão do roster para disparar.
 */

type Mode = WizardMode;
type Step = MissionWizardStep;

type MissionGoalSubmission = {
  missionId: string;
  goal: string;
  attachments: MissionAttachment[];
  source: MissionIntentSource;
  lane: MissionLane;
  orchestrationMode?: MissionOrchestrationMode;
  wavePackTemplateId?: WavePackTemplateId;
  /** Exact saved squad that armed this mission; avoids React/state re-resolution. */
  reviewedSquad?: Squad;
  /**
   * Beginner route: the reviewed team is already the renderer review.
   * Compile and continue to the main-owned native approval without replaying
   * the same objective in the intent composer or renderer plan.
   */
  directToNativeApproval?: boolean;
  /** Advanced/manual escape hatch that intentionally stops on plan review. */
  reviewPlan?: boolean;
};

/** Soft-close (keeps draft) vs discard (Cancelar / launch ok). */
function softClose(): void {
  useMissionWizardStore.getState().close();
}

function discardAndClose(): void {
  useMissionWizardStore.getState().close({ discard: true });
}

const PANE_COUNTS = [1, 2, 3, 4, 6];

const STEP_LABELS: Record<Step, string> = {
  "new-ws": "Pasta",
  mode: "Modo",
  "libre-count": "Panes",
  "libre-slots": "Providers",
  "squad-select": "Squad",
  "agentic-intent": "Objetivo",
  "squad-review": "Revisar",
  "intent-compose": "Objetivo",
  "intent-plan": "Plano",
};

function StepsBar({ steps, current }: { steps: Step[]; current: Step }) {
  const currentIndex = steps.indexOf(current);
  return (
    <div className="wizard__steps" aria-label="Etapas">
      {steps.map((s, i) => (
        <span key={s} className="wizard__step-wrap">
          {i > 0 && <span className="wizard__step-line" />}
          <span
            className={`wizard__step ${
              s === current
                ? "wizard__step--active"
                : i < currentIndex
                  ? "wizard__step--complete"
                  : ""
            }`}
            aria-current={s === current ? "step" : undefined}
          >
            {STEP_LABELS[s].toUpperCase()}
          </span>
        </span>
      ))}
    </div>
  );
}

function workerCount(squad: Squad): string {
  const workers = squad.agents.filter(
    (a) => a.category !== "orchestrator",
  ).length;
  const hasOrch = squad.agents.some((a) => a.category === "orchestrator");
  return hasOrch
    ? `orquestrador + ${workers} agente${workers === 1 ? "" : "s"}`
    : `${workers} agentes`;
}

/**
 * Estado durável da missão no instante do clique. O wizard guarda o plano de
 * quando compilou, e entre isso e "Começar" a missão pode ter bloqueado — é
 * essa defasagem que decide entre aprovar e retomar. Falha de leitura devolve
 * null para o chamador seguir com o que tem.
 */
async function currentMissionSnapshot(
  missionId: string,
): Promise<Mission | null> {
  try {
    const missions = await window.nexus.orch.listMissions();
    return missions.find((candidate) => candidate.id === missionId) ?? null;
  } catch {
    return null;
  }
}

/** FALE HUMANO also applies to the wizard: never leak queue jargon in the UI. */
function humanPromptQueueActivity(kind: string): string {
  switch (kind) {
    case "user_goal":
    case "voice_goal":
      return "Processando o objetivo";
    case "user_message":
    case "voice_message":
      return "Processando sua mensagem";
    case "preflight":
    case "bootstrap":
      return "Preparando o projeto";
    default:
      return "Trabalhando em segundo plano";
  }
}

export function effectiveMissionReviewGoal(input: {
  readonly mode: WizardMode | null;
  readonly intent: string;
  readonly missionGoal: string;
}): string {
  return input.mode === "agentic" ? input.intent : input.missionGoal;
}

export function MissionWizard() {
  const draftHydrationBarrier = useRef(createDraftHydrationBarrier()).current;
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const open = useMissionWizardStore((s) => s.open);
  const variant = useMissionWizardStore((s) => s.variant);
  const presetSquadId = useMissionWizardStore((s) => s.presetSquadId);
  const storeArmedMissionId = useMissionWizardStore((s) => s.armedMissionId);
  const agenticIntent = useMissionWizardStore((s) => s.agenticIntent);
  const agenticSource = useMissionWizardStore((s) => s.agenticSource);
  const agenticLaunchNonce = useMissionWizardStore((s) => s.agenticLaunchNonce);
  const squadPickerNonce = useMissionWizardStore((s) => s.squadPickerNonce);
  const voiceLaunchNonce = useMissionWizardStore((s) => s.voiceLaunchNonce);
  const squads = useOrchStore((s) => s.squads);
  const providers = useProviderStore((s) => s.providers);
  const accounts = useAccountStore((s) => s.accounts);
  const recents = useWorkspaceStore((s) => s.recents);
  const openWorkspace = useWorkspaceStore((s) => s.open);

  const hasNewWsStep = variant === "workspace";

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [configuredOrchestratorAdapterId, setConfiguredOrchestratorAdapterId] =
    useState(DEFAULT_ORCH_SETTINGS.defaultAdapterId);
  const [squadCliPolicy, setSquadCliPolicy] = useState<SquadCliPolicy>(
    DEFAULT_ORCH_SETTINGS.squadCliPolicy,
  );
  const [step, setStep] = useState<Step>("mode");
  const stepRef = useRef<Step>("mode");
  stepRef.current = step;
  const handledAgenticLaunchRef = useRef(0);
  const handledSquadPickerRef = useRef(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const [wsPath, setWsPath] = useState("");
  const [count, setCount] = useState(2);
  const [slots, setSlots] = useState<string[]>([]);
  const [squadId, setSquadId] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Intent-first: armed mission shell awaiting an explicit goal (0 tokens).
  const [armedMissionId, setArmedMissionId] = useState<string | null>(null);
  const [missionGoal, setMissionGoal] = useState("");
  const [missionAttachments, setMissionAttachments] = useState<
    MissionAttachment[]
  >([]);
  /** standard = sem restrições (default); consult = read-only; plan = design-only plan.md; ops = infra sem código. */
  const [missionLane, setMissionLane] = useState<
    "standard" | "consult" | "plan" | "ops"
  >("standard");
  /** Livre | Pack | Guiado — default Guiado (resolver / seal guided). */
  const [orchestrationMode, setOrchestrationMode] =
    useState<MissionOrchestrationMode>("guided");
  const [wavePackTemplateId, setWavePackTemplateId] =
    useState<WavePackTemplateId>("landing");
  /** Once the operator touches the lane radios, stop auto-suggest from goal text. */
  const laneTouchedByUserRef = useRef(false);
  /**
   * Restrições de lane moram na seção "Opções avançadas" (colapsada por
   * padrão). A sugestão por objetivo só preenche a escolha lá dentro — fora
   * dela a lane é sempre standard (sem restrições), nunca restringe por default.
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [plannedMission, setPlannedMission] = useState<Mission | null>(null);
  // Exact main-created immutable squad bound while this wizard arms a mission.
  // A ref survives the async compile/approval chain without exposing the
  // runtime snapshot as a reusable user configuration.
  const armedRuntimeSquadRef = useRef<Squad | null>(null);
  const armedMissionSnapshot = useOrchStore((state) =>
    armedMissionId
      ? (state.missions.find((mission) => mission.id === armedMissionId) ??
        null)
      : null,
  );
  const [prepareStatus, setPrepareStatus] = useState<
    "idle" | "running" | "ready" | "cancelled" | "error"
  >("idle");
  const [prepareDetail, setPrepareDetail] = useState<string | null>(null);
  /** Human summary of the mission prompt queue (null while idle). */
  const [promptQueueHint, setPromptQueueHint] = useState<string | null>(null);
  const prepareGenerationRef = useRef(0);
  // Suppress the broadcast-driven jump to the plan step while this wizard is
  // already dispatching the freshly compiled goal (one-click start).
  const autoDispatchingRef = useRef(false);
  // React state disables the buttons on the next render. This synchronous
  // fence also rejects a second click/voice command in the same event turn,
  // before `spawning` has reached the DOM.
  const missionTransitionInFlightRef = useRef(false);

  // Modo Agêntico: intenção em linguagem natural + estado do arquiteto.
  const [intent, setIntent] = useState("");

  // The active goal text lives in `missionGoal` on the squad/goal-composer
  // path and in `intent` on the (default) agentic path. Suggesting only from
  // `missionGoal` left the vibe-coder's main path permanently on standard —
  // an analysis request then got a full delivery graph with merge queue.
  const suggestedLane = useMemo(
    () =>
      suggestMissionLaneFromGoal(
        missionGoal.trim() ? missionGoal : intent,
      ),
    [missionGoal, intent],
  );

  // Lane suggestion applies whether or not the advanced section is open —
  // an analysis goal must reach the consult lane on autopilot, otherwise it
  // gets a full delivery graph (worktree + merge queue) for a question. The
  // visible chip keeps the choice inspectable and reversible; an operator
  // pick always wins.
  useEffect(() => {
    if (laneTouchedByUserRef.current) return;
    setMissionLane(suggestedLane ?? "standard");
  }, [suggestedLane]);
  const [designing, setDesigning] = useState(false);
  // Main returns an unpublished design plus an opaque, renderer/workspace-bound
  // capability. It remains local until the operator explicitly saves it or
  // main seals a hidden immutable copy for this one mission.
  const [designedSquad, setDesignedSquad] = useState<Squad | null>(null);
  const [designDraftToken, setDesignDraftToken] = useState<string | null>(null);
  // Editable copy of the selected squad's roster (cli/model/effort per agent).
  const [roster, setRoster] = useState<SquadAgent[]>([]);
  const [rosterSaved, setRosterSaved] = useState(false);
  const [highlightedAgentId, setHighlightedAgentId] = useState<string | null>(
    null,
  );
  const designRequestRef = useRef(0);
  const designInFlightRef = useRef(false);

  // Voice submits through main authority too. Follow the project-scoped
  // mission broadcast so that an externally submitted goal reaches the same
  // review screen instead of leaving the wizard on a stale composer.
  useEffect(() => {
    const snapshot = armedMissionSnapshot;
    const isReviewable =
      snapshot?.intentState === "ready_to_start" ||
      snapshot?.intentState === "awaiting_approval";
    const isCurrent =
      snapshot?.intentContract?.intentVersion === snapshot?.intentVersion;
    if (
      !open ||
      autoDispatchingRef.current ||
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
    setStep("intent-plan");
  }, [open, armedMissionSnapshot, plannedMission?.intentVersion]);

  // Surface prompt-queue state while composing — human copy only, and only
  // when something is actually happening (idle queues render nothing).
  useEffect(() => {
    if (!open || step !== "intent-compose" || !armedMissionId) {
      setPromptQueueHint(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void window.nexus.orch
        .getMissionPromptQueue?.({ missionId: armedMissionId })
        .then((snap) => {
          if (cancelled || !snap) return;
          const parts: string[] = [];
          if (snap.executing) {
            parts.push(`${humanPromptQueueActivity(snap.executing.kind)}…`);
          }
          if (snap.queued.length > 0) {
            parts.push(
              snap.queued.length === 1
                ? "1 pedido aguardando"
                : `${snap.queued.length} pedidos aguardando`,
            );
          }
          setPromptQueueHint(parts.length > 0 ? parts.join(" · ") : null);
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
    draftHydrationBarrier.markHydrating();
    let cancelled = false;
    void window.nexus.adapters
      .list()
      .then((list) => {
        if (!cancelled) setAdapters(list);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            toUserFacingMissionError(
              cause,
              "Não foi possível carregar os provedores. Tente novamente.",
            ),
          );
        }
      });
    void window.nexus.settings
      .orchGet()
      .then((settings) => {
        if (!cancelled) {
          setConfiguredOrchestratorAdapterId(
            settings.defaultAdapterId || DEFAULT_ORCH_SETTINGS.defaultAdapterId,
          );
          setSquadCliPolicy(settings.squadCliPolicy);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            toUserFacingMissionError(
              cause,
              "Não foi possível carregar o provedor da equipe. Tente novamente.",
            ),
          );
        }
      });

    const workspaceState = useWorkspaceStore.getState();
    const defaultWsPath = hasNewWsStep
      ? (workspaceState.current?.path ?? workspaceState.recents[0]?.path ?? "")
      : "";
    const draft = useMissionWizardStore.getState().draft;
    const restoreDraft = (d: MissionWizardDraft) => {
      setStep(d.step);
      setMode(d.mode);
      setSquadId(d.squadId);
      setArmedMissionId(d.armedMissionId);
      setIntent(d.intent);
      setMissionGoal(d.missionGoal);
      setMissionLane(d.missionLane);
      // Draft is operator intent — do not overwrite lane with goal heuristics.
      laneTouchedByUserRef.current = true;
      setCount(d.count);
      setSlots(d.slots);
      setWsPath(d.wsPath || defaultWsPath);
      setMissionAttachments(d.missionAttachments);
      setPlannedMission(null);
    };

    // Voice may target Modo Agêntico directly. The nonce matters when this
    // wizard was already open on another mode or with a previous objective.
    // Never clobber a longer draft when voice only re-opens agentic empty.
    if (
      agenticLaunchNonce > handledAgenticLaunchRef.current &&
      stepRef.current !== "squad-review"
    ) {
      handledAgenticLaunchRef.current = agenticLaunchNonce;
      setMode("agentic");
      setSquadId("");
      setDesignedSquad(null);
      setDesignDraftToken(null);
      setArmedMissionId(null);
      const seed =
        (agenticIntent ?? "").trim() ||
        (draft?.variant === variant ? draft.intent : "") ||
        "";
      setIntent(seed);
      setStep("agentic-intent");
      if (!(draft?.variant === variant && isMissionWizardDraftDirty(draft))) {
        setMissionGoal("");
        setMissionLane("standard");
        laneTouchedByUserRef.current = false;
        setCount(2);
        setSlots([]);
        setWsPath(defaultWsPath);
        setMissionAttachments([]);
      } else {
        setMissionGoal(draft.missionGoal);
        setMissionLane(draft.missionLane);
        laneTouchedByUserRef.current = true;
        setCount(draft.count);
        setSlots(draft.slots);
        setWsPath(draft.wsPath || defaultWsPath);
        setMissionAttachments(draft.missionAttachments);
      }
      // Selecting an existing squad is a distinct intent from designing one.
      // A monotonic nonce also switches an already-open wizard reliably.
    } else if (squadPickerNonce > handledSquadPickerRef.current) {
      handledSquadPickerRef.current = squadPickerNonce;
      setMode("squad");
      setSquadId("");
      setDesignedSquad(null);
      setDesignDraftToken(null);
      setIntent("");
      setStep("squad-select");
      setWsPath(defaultWsPath);
      setCount(2);
      setSlots([]);
      setMissionAttachments([]);
      // Intent-first: already-armed mission jumps to the goal composer.
    } else if (presetSquadId && storeArmedMissionId) {
      setMode("squad");
      setSquadId(presetSquadId);
      setDesignedSquad(null);
      setDesignDraftToken(null);
      setArmedMissionId(storeArmedMissionId);
      // Restore goal if this is the same armed shell we were composing.
      // Prefer draft, then the mission's compiled contract / description
      // (resume from rail "Sem objetivo" after a failed start).
      const armedSnapshot = useOrchStore
        .getState()
        .missions.find((m) => m.id === storeArmedMissionId);
      const seededGoal =
        (draft?.variant === variant &&
        draft.armedMissionId === storeArmedMissionId &&
        draft.missionGoal.trim()
          ? draft.missionGoal
          : "") ||
        armedSnapshot?.intentContract?.goal?.trim() ||
        armedSnapshot?.description?.trim() ||
        "";
      if (seededGoal) {
        setMissionGoal(seededGoal);
        const laneFromDraft =
          draft?.armedMissionId === storeArmedMissionId
            ? draft.missionLane
            : null;
        const laneFromMission =
          armedSnapshot?.intentContract?.lane === "consult"
            ? "consult"
            : armedSnapshot?.intentContract?.lane === "plan"
              ? "plan"
              : armedSnapshot?.intentContract?.lane === "ops"
                ? "ops"
                : "standard";
        setMissionLane(laneFromDraft ?? laneFromMission);
        // Restored shell / draft owns the lane — no auto-suggest override.
        laneTouchedByUserRef.current = true;
        setMissionAttachments(
          draft?.armedMissionId === storeArmedMissionId
            ? draft.missionAttachments
            : [],
        );
      } else {
        setMissionGoal("");
        setMissionLane("standard");
        laneTouchedByUserRef.current = false;
        setMissionAttachments([]);
      }
      setStep("intent-compose");
      setPlannedMission(null);
      setIntent("");
      setWsPath(defaultWsPath);
      // A preset squad (Home deck shortcut) skips MODO/SQUAD straight to review.
    } else if (presetSquadId) {
      setMode("squad");
      setSquadId(presetSquadId);
      setDesignedSquad(null);
      setDesignDraftToken(null);
      setArmedMissionId(null);
      setIntent("");
      setStep("squad-review");
      setWsPath(defaultWsPath);
      setCount(2);
      setSlots([]);
      setMissionAttachments([]);
    } else if (
      draft &&
      draft.variant === variant &&
      isMissionWizardDraftDirty(draft)
    ) {
      // Soft-close recovery: reopen Nova Missão with the typed objective intact.
      restoreDraft(draft);
    } else {
      setStep(hasNewWsStep ? "new-ws" : "mode");
      setMode(null);
      setSquadId("");
      setDesignedSquad(null);
      setDesignDraftToken(null);
      setArmedMissionId(null);
      setIntent("");
      setMissionGoal("");
      setMissionLane("standard");
      setWsPath(defaultWsPath);
      setCount(2);
      setSlots([]);
      setMissionAttachments([]);
    }
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
    variant,
    presetSquadId,
    storeArmedMissionId,
    agenticIntent,
    agenticLaunchNonce,
    squadPickerNonce,
  ]);

  // Persist in-progress form continuously so overlay/Jarvis mis-clicks don't
  // nuke the objective the user was typing.
  useEffect(() => {
    if (!open) return;
    if (draftHydrationBarrier.shouldSkipPersist()) return;
    useMissionWizardStore.getState().saveDraft({
      variant,
      step,
      mode,
      intent,
      missionGoal,
      missionLane,
      squadId,
      armedMissionId,
      count,
      slots,
      wsPath,
      missionAttachments,
    });
  }, [
    open,
    variant,
    step,
    mode,
    intent,
    missionGoal,
    missionLane,
    squadId,
    armedMissionId,
    count,
    slots,
    wsPath,
    missionAttachments,
  ]);

  useEffect(() => {
    if (!open) return;
    useMissionWizardStore.getState().setVisibleStep(step);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // aria-modal communicates the boundary; inert enforces it for keyboard,
    // pointer and assistive technology while keeping the dialog itself live.
    const siblings = dialog.parentElement
      ? Array.from(dialog.parentElement.children).filter(
          (candidate): candidate is HTMLElement =>
            candidate instanceof HTMLElement && candidate !== dialog,
        )
      : [];
    const previousSiblingState = siblings.map((sibling) => ({
      sibling,
      inert: sibling.inert,
      ariaHidden: sibling.getAttribute("aria-hidden"),
    }));
    for (const sibling of siblings) {
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }

    return () => {
      for (const { sibling, inert, ariaHidden } of previousSiblingState) {
        sibling.inert = inert;
        if (ariaHidden === null) sibling.removeAttribute("aria-hidden");
        else sibling.setAttribute("aria-hidden", ariaHidden);
      }
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      window.requestAnimationFrame(() => {
        if (restoreTarget?.isConnected) restoreTarget.focus();
      });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const body = dialog?.querySelector<HTMLElement>(".wizard__body");
    if (!dialog || !body) return;
    const preferred =
      body.querySelector<HTMLElement>("[data-wizard-plan-review-heading]") ??
      body.querySelector<HTMLElement>("[autofocus]") ??
      body.querySelector<HTMLElement>(
        "textarea:not([disabled]), input:not([disabled]):not([type='hidden']), " +
          "select:not([disabled]), button:not([disabled]), [href], " +
          "[tabindex]:not([tabindex='-1'])",
      );
    (preferred ?? dialog).focus();
  }, [open, step]);

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      softClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]):not([type='hidden']), " +
          "textarea:not([disabled]), select:not([disabled]), [href], " +
          "[tabindex]:not([tabindex='-1'])",
      ),
    ).filter(
      (candidate) =>
        candidate.getAttribute("aria-hidden") !== "true" &&
        candidate.getClientRects().length > 0,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !dialog.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  const installed = useMemo(
    () => adapters.filter((a) => a.installed),
    [adapters],
  );
  // Every adapter is selectable per pane (installed or not) — an uninstalled
  // pick still opens the pane and surfaces its install hint, so the user can
  // always choose the LLM for each slot.
  const defaultSlot = installed[0]?.id ?? adapters[0]?.id ?? "shell";

  const steps: Step[] = useMemo(() => {
    const prefix: Step[] = hasNewWsStep ? ["new-ws"] : [];
    if (mode === "squad") {
      const base: Step[] = [...prefix, "mode", "squad-select", "squad-review"];
      // Only surface intent steps once a mission shell is actually armed.
      if (
        armedMissionId ||
        step === "intent-compose" ||
        step === "intent-plan"
      ) {
        return [...base, "intent-compose", "intent-plan"];
      }
      return base;
    }
    if (mode === "agentic")
      return [...prefix, "mode", "agentic-intent", "squad-review"];
    if (mode === "libre")
      return [...prefix, "mode", "libre-count", "libre-slots"];
    return [...prefix, "mode"];
  }, [mode, hasNewWsStep, armedMissionId, step]);

  const originals = squads.filter((s) => s.builtin);
  // Fallbacks agênticos ('agentic-…') e customs por workspace ('custom-…')
  // são infraestrutura de missão criada pelo motor — um por design/tentativa.
  // Listá-los enche o picker de "Execução + QA" duplicados que o usuário
  // nunca configurou; a missão que os referencia continua funcionando.
  const userSquads = squads.filter(
    (s) =>
      !s.builtin &&
      !isEngineGeneratedSquadId(s.id) &&
      !isMissionRuntimeSquadId(s.id),
  );
  const selectedSquad =
    (designedSquad?.id === squadId ? designedSquad : null) ??
    squads.find((s) => s.id === squadId) ??
    null;
  const rosterOrchestrator =
    roster.find((agent) => agent.category === "orchestrator") ?? null;
  const rosterAdapters = useMemo(
    () =>
      adapters.map((adapter) => {
        const provider = providers.find(
          (item) => item.adapterId === adapter.id,
        );
        return { ...adapter, enabled: provider?.enabled ?? true };
      }),
    [adapters, providers],
  );
  const verifiedAutomaticOrchestratorId = useMemo(
    () => {
      const authenticatedAdapterIds = new Set(
        rosterAdapters
          .filter((adapter) =>
            isAdapterModelAuthenticated(
              adapter,
              providers,
              undefined,
              accounts,
            ),
          )
          .map((adapter) => adapter.id),
      );
      return (
      automaticOrchestratorAdapterId(
        rosterAdapters,
        configuredOrchestratorAdapterId,
        squadCliPolicy,
        authenticatedAdapterIds,
      ) ?? ""
      );
    },
    [
      accounts,
      configuredOrchestratorAdapterId,
      providers,
      rosterAdapters,
      squadCliPolicy,
    ],
  );

  // Derived: which worker (if any) has allowedTools == null (the guard condition).
  // Used to disable "Usar este squad" reactively without running the guard imperative.
  const rosterInvalidAgent = useMemo(
    () =>
      roster.find(
        (a) => a.category !== "orchestrator" && a.allowedTools == null,
      ) ?? null,
    [roster],
  );

  // Load the selected squad into an editable copy. Automatic Maestro routing
  // uses only verified providers; experimental routes require a real selection
  // in the review. Workers stay distributed across the other enabled CLIs.
  // Rebalance ONLY when the squad itself changes: adapters/providers emitem
  // onChanged o tempo todo (quota, install-check) e recarregar o roster nesses
  // eventos descartava a edição do usuário — o modelo escolhido na revisão
  // (ex.: Fable no orquestrador) voltava silenciosamente ao salvo no squad.
  const rosterSquadRef = useRef<string | null>(null);
  useEffect(() => {
    const sq = selectedSquad;
    if (!sq) {
      rosterSquadRef.current = null;
      setRoster([]);
      setRosterSaved(false);
      return;
    }
    const rosterPolicyKey = `${sq.id}\u0000${squadCliPolicy}`;
    if (rosterSquadRef.current === rosterPolicyKey) {
      // Adapters/settings load independently when the wizard opens. Fill an
      // initially empty Maestro once verified evidence arrives, without
      // rebalancing workers or discarding later operator edits.
      if (verifiedAutomaticOrchestratorId) {
        setRoster((current) => {
          const orchestrator =
            current.find((agent) => agent.category === "orchestrator") ?? null;
          if (!orchestrator || orchestrator.cli) return current;
          return current.map((agent) =>
            agent.id === orchestrator.id
              ? {
                  ...agent,
                  cli: verifiedAutomaticOrchestratorId,
                  model: undefined,
                }
              : agent,
          );
        });
      }
      return;
    }
    rosterSquadRef.current = rosterPolicyKey;
    setRoster(
      balanceSquadRosterCli(
        sq.agents,
        rosterAdapters,
        verifiedAutomaticOrchestratorId,
        {
          squadCliPolicy,
          preserveExactCliAssignments:
            sq.id === REAL_MISSION_E2E_SQUAD_ID,
        },
      ),
    );
    setRosterSaved(false);
  }, [
    squadId,
    selectedSquad,
    rosterAdapters,
    verifiedAutomaticOrchestratorId,
    squadCliPolicy,
  ]);

  // Preflight: when the REVISAR step opens, immediately highlight the first
  // agent that will block launch so the user sees the issue before clicking.
  useEffect(() => {
    if (step !== "squad-review") {
      setHighlightedAgentId(null);
      return;
    }
    const invalid = roster.find(
      (a) => a.category !== "orchestrator" && a.allowedTools == null,
    );
    if (invalid) {
      setHighlightedAgentId(invalid.id);
      setError(
        `"${invalid.agentName}" ainda precisa de uma lista segura de ferramentas. ` +
          "Abra as opções avançadas desse integrante para escolher o que ele pode usar.",
      );
      requestAnimationFrame(() => {
        const reduceMotion = window.matchMedia?.(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        document
          .querySelector(`[data-agent-id="${invalid.id}"]`)
          ?.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "center",
          });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Overclock wizard-fire: Live/Classic confirm_squad bumps voiceLaunchNonce.
  // MUST live before any early return so the hook count is stable every render.
  useEffect(() => {
    if (!open || voiceLaunchNonce <= 0) return;
    if (!selectedSquad || spawning) return;
    if (step === "squad-review") {
      void handleLaunchSquad();
    } else if (step === "intent-plan" && plannedMission) {
      void handleStartFromIntentPlan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on nonce
  }, [voiceLaunchNonce]);

  function updateAgent(id: string, patch: Partial<SquadAgent>) {
    setRoster((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
    setRosterSaved(false);
    // Clear the preflight highlight once the user fixes this agent's tool list.
    if (
      id === highlightedAgentId &&
      "allowedTools" in patch &&
      patch.allowedTools != null
    ) {
      setHighlightedAgentId(null);
      setError(null);
    }
  }

  function validateWorkerToolScopes(agents: SquadAgent[]): boolean {
    const unsafe = agents.find(
      (agent) =>
        agent.category !== "orchestrator" && agent.allowedTools == null,
    );
    if (!unsafe) return true;
    const message =
      `"${unsafe.agentName}" ainda precisa de uma lista segura de ferramentas. ` +
      "Abra as opções avançadas desse integrante para escolher o que ele pode usar.";
    setError(message);
    setHighlightedAgentId(unsafe.id);
    useToastStore
      .getState()
      .push("error", "Revise as ferramentas da equipe", message);
    return false;
  }

  /**
   * Global save and mission launch are intentionally different authorities.
   * The explicit button edits/creates a reusable squad as an inert settings
   * action; it never inserts a confirmation before launch.
   * Launch asks main for a fresh hidden snapshot: it never overwrites the
   * selected global squad and therefore needs no save modal before the single
   * mission-approval dialog.
   */
  async function persistRoster(
    purpose: "global" | "mission-runtime",
  ): Promise<Squad | null> {
    if (!selectedSquad) return null;
    if (!validateWorkerToolScopes(roster)) return null;
    let persisted: Squad;
    try {
      const launchSnapshot = purpose === "mission-runtime";
      const saveGeneratedDraftAsUserCopy =
        purpose === "global" && isEngineGeneratedSquadId(selectedSquad.id);
      persisted = applySquadEdit(
        {
          id: selectedSquad.id,
          name: selectedSquad.name,
          createdAt: selectedSquad.createdAt,
          // Launch is always a copy, including when the selected squad already
          // belongs to the user. Main replaces this provisional id with its
          // own UUID before persistence.
          // Engine-generated designs are hidden infrastructure until the
          // operator explicitly saves one. That click must mint a normal
          // user-owned id; otherwise the saved squad immediately disappears
          // behind the picker/reuse engine-prefix filter.
          builtin:
            launchSnapshot ||
            selectedSquad.builtin ||
            saveGeneratedDraftAsUserCopy,
          orchestratorInstructions:
            launchSnapshot && mode === "agentic" && intent.trim()
              ? retargetSquadInstructions(
                  selectedSquad.orchestratorInstructions,
                  intent.trim(),
                )
              : selectedSquad.orchestratorInstructions,
          nativeInstructions: selectedSquad.nativeInstructions,
          agents: roster.map((agent) => ({ ...agent })),
        },
        { agents: roster },
        launchSnapshot
          ? `runtime-request-${crypto.randomUUID()}`
          : `squad-${crypto.randomUUID()}`,
      ) as Squad;
    } catch (cause) {
      const message = toUserFacingMissionError(
        cause,
        "Não foi possível salvar essa equipe. Revise as opções avançadas e tente novamente.",
      );
      setError(message);
      useToastStore.getState().push("error", "Não deu pra salvar", message);
      return null;
    }
    const res = await window.nexus.orch.saveSquad(
      persisted,
      purpose === "mission-runtime"
        ? {
            purpose: "mission-runtime",
            guided:
              mode === "agentic" || isEngineGeneratedSquadId(selectedSquad.id),
            sourceSquadId: selectedSquad.id,
            designDraftToken:
              designedSquad?.id === selectedSquad.id
                ? (designDraftToken ?? undefined)
                : undefined,
          }
        : undefined,
    );
    if (!res.ok) {
      const message = toUserFacingMissionError(
        res.error,
        "Não foi possível salvar a equipe revisada. Tente novamente.",
      );
      setError(message);
      useToastStore.getState().push("error", "Não deu pra salvar", res.error);
      return null;
    }
    if (purpose === "mission-runtime") {
      if (!res.squad || !isMissionRuntimeSquadId(res.squad.id)) {
        const message =
          "A equipe não ficou pronta para esta missão. Tente preparar novamente.";
        setError(message);
        useToastStore
          .getState()
          .push("error", "Lançamento interrompido", message);
        return null;
      }
      armedRuntimeSquadRef.current = res.squad;
      return res.squad;
    }

    const saved = res.squad ?? persisted;
    const hydratePath = hasNewWsStep
      ? wsPath.trim()
      : (useWorkspaceStore.getState().current?.path ?? wsPath.trim());
    await useOrchStore.getState().hydrate(hydratePath);
    setDesignedSquad(null);
    setDesignDraftToken(null);
    setRosterSaved(true);
    setSquadId(saved.id);
    return saved;
  }

  async function saveRoster() {
    await persistRoster("global");
  }

  if (!open) return null;

  async function browse() {
    try {
      const picked = await window.nexus.workspace.pickPath();
      if (!picked) return;
      setWsPath(picked);
      if (hasNewWsStep) setStep("mode");
    } catch (err) {
      const message = toUserFacingMissionError(
        err,
        "Não foi possível abrir o seletor de pasta. Tente novamente.",
      );
      setError(message);
      useToastStore
        .getState()
        .push("error", "Falha ao procurar pasta", message);
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
    if (next === "libre") {
      setStep("libre-count");
      setSlots((prev) => fillSlots(prev, count));
    } else if (next === "agentic") {
      setStep("agentic-intent");
    } else {
      if (!squadId) setSquadId(squads[0]?.id ?? "");
      setStep("squad-select");
    }
  }

  /**
   * Atalho "Planejar · PRD": pula direto para a revisão do squad builtin
   * nexus-plan (achado de operador: a rota via Modo Squad → lista → escolher
   * era garimpo para a ação mais pedida do fluxo BMAD).
   */
  function choosePlanejamento() {
    setMode("squad");
    setSquadId(NEXUS_PLAN_SQUAD_ID);
    setMissionLane("plan");
    // The shortcut itself is an explicit operator lane decision. Keep it
    // stable when the advanced section is collapsed or the goal heuristic
    // runs after the user types the PRD objective.
    laneTouchedByUserRef.current = true;
    setStep("squad-review");
  }

  /** Modo Agêntico: intenção → arquiteto monta o time → revisão do roster. */
  async function handleDesignFromIntent() {
    if (designInFlightRef.current || designing || !intent.trim()) return;
    designInFlightRef.current = true;
    setDesignedSquad(null);
    setDesignDraftToken(null);
    const requestId = ++designRequestRef.current;
    const isCurrentRequest = () =>
      designRequestRef.current === requestId &&
      useMissionWizardStore.getState().open;
    setDesigning(true);
    setError(null);
    try {
      // Main binds the unpublished design token to the renderer's LIVE
      // project scope. A new workspace must therefore be opened before
      // designSquad; switching only at launch would make the later seal
      // correctly reject a token minted for the previous project.
      const activatedWorkspacePath = hasNewWsStep
        ? await ensureWorkspaceOpen()
        : useWorkspaceStore.getState().current?.path;
      if (!activatedWorkspacePath) return;
      if (!isCurrentRequest()) return;
      const workspacePath = activatedWorkspacePath;
      if (!workspacePath) {
        setError("Abra (ou informe) um workspace antes de montar o time.");
        return;
      }
      const designOnce = async () => {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
          return await Promise.race([
            window.nexus.orch.designSquad(
              workspacePath,
              [
                intent.trim(),
                buildMissionAttachmentsContext(missionAttachments),
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error("O arquiteto demorou demais. Tente novamente."),
                  ),
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
      if (useWorkspaceStore.getState().current?.path !== workspacePath) {
        setError(
          "A pasta mudou enquanto a equipe era preparada. Revise o objetivo e tente novamente.",
        );
        return;
      }
      if (!res.ok || !res.squad || !res.designDraftToken) {
        const message = res.error ?? "Não consegui montar o time.";
        if (isMissingModelKeyError(message)) {
          setError(
            "Conecte uma conta ou chave de modelo para montar a equipe sob medida.",
          );
          useVoiceStore.getState().openSettings();
        } else {
          setError(
            toUserFacingMissionError(
              message,
              "Não foi possível montar a equipe. Tente novamente.",
            ),
          );
        }
        return;
      }
      if (res.warning) {
        useToastStore
          .getState()
          .push("warn", "Doctor recuperou o arquiteto", res.warning);
      }
      // Design remains unpublished. The opaque token lets main resolve this
      // exact workspace/renderer-bound candidate when the mission is sealed.
      setDesignedSquad(res.squad);
      setDesignDraftToken(res.designDraftToken);
      setSquadId(res.squad.id);
      setStep("squad-review");
    } catch (cause) {
      const message = toUserFacingMissionError(
        cause,
        "Não foi possível montar a equipe. Tente novamente.",
      );
      if (!isCurrentRequest()) return;
      setError(message);
      useToastStore
        .getState()
        .push("error", "O Doctor liberou o wizard após a falha", message);
    } finally {
      designInFlightRef.current = false;
      if (isCurrentRequest()) setDesigning(false);
    }
  }

  function goCount(n: number) {
    setCount(n);
    setSlots((prev) => fillSlots(prev, n));
  }

  async function ensureWorkspaceOpen(): Promise<string | null> {
    if (!hasNewWsStep) {
      return (
        useWorkspaceStore.getState().current?.path || wsPath.trim() || null
      );
    }
    const target = wsPath.trim();
    if (!target) {
      setError("Escolha uma pasta antes de continuar.");
      return null;
    }
    if (target.startsWith("ssh://")) {
      setError(
        "Workspaces SSH chegam na próxima versão — use uma pasta local.",
      );
      return null;
    }

    const previousPath = useWorkspaceStore.getState().current?.path ?? null;
    if (previousPath === target) {
      try {
        await switchWorkspaceLayout(target);
        return target;
      } catch (cause) {
        const message = toUserFacingMissionError(
          cause,
          "A pasta abriu, mas a área de trabalho não ficou pronta. Tente novamente.",
        );
        setError(message);
        useToastStore
          .getState()
          .push("error", "Layout do workspace indisponível", message);
        return null;
      }
    }

    try {
      // WorkspaceStore owns the complete authority transaction: it flushes the
      // outgoing layout while Main still recognizes the old scope, opens the
      // picker-authorized path, hydrates the canonical target and only then
      // publishes `current`.
      await openWorkspace(target);
    } catch (cause) {
      const detail =
        cause instanceof Error ? cause.message : String(cause ?? "");
      const message = /not authorized by (?:the )?folder picker/i.test(detail)
        ? "Para sua segurança, escolha esta pasta pelo botão Procurar antes de continuar."
        : /invalid or inaccessible|path is invalid/i.test(detail)
          ? "Esta pasta não existe ou não está acessível. Escolha outra em Procurar."
          : toUserFacingMissionError(
              cause,
              "Não foi possível abrir esta pasta. Escolha outra em Procurar ou tente novamente.",
            );
      setError(message);
      useToastStore
        .getState()
        .push("error", "Não foi possível abrir o workspace", message);
      return null;
    }

    // Main canonicalizes picker-authorized directories (for example
    // /tmp → /private/tmp). Its returned current.path is the authoritative
    // target; invalid paths throw instead of silently retaining the old one.
    const openedPath = useWorkspaceStore.getState().current?.path ?? null;
    if (!openedPath) {
      setError("A pasta não foi aberta. Escolha novamente em Procurar.");
      return null;
    }
    // openWorkspace only resolves after the canonical target layout is ready.
    // A second switch here used to reload the same pane tree and could race
    // mission design with redundant persistence work.
    setWsPath(openedPath);
    return openedPath;
  }

  async function handleLaunchLibre() {
    if (spawning) return;
    setSpawning(true);
    setError(null);
    try {
      if (!(await ensureWorkspaceOpen())) return;
      launchLibrePanes(slots.slice(0, count), adapters);
      discardAndClose();
    } finally {
      setSpawning(false);
    }
  }

  async function handleLaunchSquad() {
    if (spawning || missionTransitionInFlightRef.current || !selectedSquad) {
      return;
    }
    missionTransitionInFlightRef.current = true;
    setSpawning(true);
    setError(null);
    try {
      let effectiveSquad: Squad = { ...selectedSquad, agents: roster };
      if (!validateWorkerToolScopes(effectiveSquad.agents)) return;
      if (!(await ensureWorkspaceOpen())) return;

      // Every launch gets a new hidden, immutable main-owned snapshot. This is
      // an inert persistence step (no CLI/token/effect), so the only operator
      // ceremony remains the semantic mission approval immediately before
      // execution.
      const persistedSquad = await persistRoster("mission-runtime");
      if (!persistedSquad) return;
      effectiveSquad = persistedSquad;

      // Launch with the reviewed roster. Pass all adapters so preflight can
      // explain an unavailable configured provider instead of failing silently.
      // Agêntico: a missão nasce com o objetivo do usuário como título — nunca
      // com o nome de um squad reusado de outra missão.
      const result = await launchSquadMission(effectiveSquad, adapters, {
        missionTitle:
          mode === "agentic" && intent.trim()
            ? missionTitleFromGoal(intent, effectiveSquad.name)
            : undefined,
      });
      if (!result.ok) {
        setError(
          toUserFacingMissionError(
            result.error,
            "Não foi possível preparar a equipe para esta missão. Tente novamente.",
          ),
        );
        return;
      }
      // Intent-first: squad is armed with zero agent panes / tokens.
      if (result.armed && result.missionId) {
        await recordRealMissionProductWizardStep(
          "mission-armed",
          result.missionId,
        );
        const productWizardE2EActive =
          window.sessionStorage.getItem(
            REAL_MISSION_E2E_PRODUCT_WIZARD_ACTIVE_STORAGE_KEY,
          ) === "1";
        // Physical product-wizard release gate opens the exact fixture squad
        // via openForSquad (no agentic composer). Main only seals a causal
        // receipt for REAL_MISSION_E2E_GOAL, so after the trusted launch click
        // we submit that exact objective and continue to native approval —
        // the operator never has to retype the multi-line gate goal.
        const armedGoal = productWizardE2EActive
          ? REAL_MISSION_E2E_GOAL
          : initialGoalForArmedMission({
              isAgentic: mode === "agentic",
              designedIntent: intent,
            });
        setArmedMissionId(result.missionId);
        setMissionGoal(armedGoal);
        setPlannedMission(null);

        // The beginner already authored the goal and reviewed the generated
        // team. Keep that immutable click snapshot across the async arm so
        // React state cannot send an empty/stale missionId or goal. The next
        // visible decision is the main-owned native approval.
        if ((mode === "agentic" || productWizardE2EActive) && armedGoal) {
          await compileAndRouteMissionGoal({
            missionId: result.missionId,
            goal: armedGoal,
            attachments: missionAttachments.map((attachment) => ({
              ...attachment,
            })),
            source: productWizardE2EActive ? "typed" : agenticSource,
            lane: missionLane,
            orchestrationMode,
            ...(orchestrationMode === "pack"
              ? { wavePackTemplateId }
              : {}),
            reviewedSquad: effectiveSquad,
            directToNativeApproval: true,
          });
          return;
        }

        // Manual/saved-squad flow still needs an objective, so its composer
        // remains the correct next step.
        setStep("intent-compose");
        useToastStore
          .getState()
          .push(
            "info",
            `${selectedSquad.name} pronto`,
            "Aguardando seu objetivo. Nenhum especialista iniciado. 0 tokens usados.",
          );
        return;
      }
      discardAndClose();
    } catch (cause) {
      setError(
        toUserFacingMissionError(
          cause,
          "Não foi possível preparar a equipe para esta missão. Tente novamente.",
        ),
      );
    } finally {
      missionTransitionInFlightRef.current = false;
      setSpawning(false);
    }
  }

  /**
   * Compile from an explicit snapshot and route to the correct decision.
   *
   * The beginner route has already reviewed the generated team, so every
   * dispatchable risk level continues to the one native approval. Manual and
   * advanced routes retain their composer/plan behavior. Evidence and invalid
   * intent states always stop before approval (fail closed).
   */
  async function compileAndRouteMissionGoal(
    submission: MissionGoalSubmission,
  ): Promise<void> {
    const goal = submission.goal.trim();
    let compiledMission: Mission | null = null;
    // Main may publish awaiting_approval before the submit IPC promise settles.
    // Arm this fence before the await so that broadcast cannot flash the
    // optional renderer plan review while the guided route is already moving
    // to its single native approval.
    const directApproval = submission.directToNativeApproval === true;
    if (directApproval) autoDispatchingRef.current = true;
    try {
      const planned = await window.nexus.orch.submitMissionIntent({
        missionId: submission.missionId,
        goal,
        evidenceAttached: submission.attachments.length > 0,
        source: submission.source,
        lane: submission.lane,
        ...(submission.orchestrationMode
          ? { orchestrationMode: submission.orchestrationMode }
          : {}),
        ...(submission.orchestrationMode === "pack" &&
        submission.wavePackTemplateId
          ? { wavePackTemplateId: submission.wavePackTemplateId }
          : {}),
        // Somente a rota que REALMENTE exibe esta submissão na revisão de
        // plano in-app marca a superfície: o Start da revisão vale como a
        // aprovação (grant main-owned, single-use). As rotas que vão direto
        // para a aprovação nativa (beginner / "Continuar para aprovação")
        // mantêm o modal como a única autorização.
        ...(submission.reviewPlan === true && !directApproval
          ? { planReviewSurface: "product-wizard" as const }
          : {}),
      });
      await recordRealMissionProductWizardStep(
        "intent-submitted",
        submission.missionId,
      );
      compiledMission = planned;
      // Prefer main's intentState as source of truth (contract may already be
      // compiled while the shell stays human-waiting for evidence).
      const waitingForEvidence =
        planned.intentState === "awaiting_goal" ||
        missionGoalNeedsFutureEvidence(goal, submission.attachments.length > 0);
      if (waitingForEvidence) {
        // This is a real missing input, not duplicate ceremony: preserve the
        // armed shell and original goal so the user can attach evidence.
        setArmedMissionId(submission.missionId);
        setMissionGoal(goal);
        setPlannedMission(null);
        setStep("intent-compose");
        setError(MISSION_EVIDENCE_WAIT_MESSAGE);
        return;
      }
      setPlannedMission(planned);
      const dispatchable =
        planned.intentState === "ready_to_start" ||
        planned.intentState === "awaiting_approval";
      const shouldDispatch =
        dispatchable &&
        (submission.directToNativeApproval ||
          (!submission.reviewPlan && planned.intentState === "ready_to_start"));
      if (shouldDispatch) {
        if (!directApproval) autoDispatchingRef.current = true;
        try {
          const dispatched = await dispatchPlannedMission(
            planned,
            submission.attachments,
            submission.reviewedSquad,
          );
          if (dispatched) return;
        } finally {
          if (!directApproval) autoDispatchingRef.current = false;
        }
      }
      setStep("intent-plan");
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Falha ao compilar o objetivo.";
      // Once compilation exists, retry from the exact reviewed contract instead
      // of arming a duplicate shell. Before compilation, fall back to the same
      // armed mission's composer.
      setStep(compiledMission ? "intent-plan" : "intent-compose");
      setError(
        toUserFacingMissionError(
          message,
          "Não foi possível preparar o objetivo. Revise o texto e tente novamente.",
        ),
      );
    } finally {
      if (directApproval) autoDispatchingRef.current = false;
    }
  }

  async function handleSubmitMissionGoal(options?: { reviewPlan?: boolean }) {
    if (
      spawning ||
      missionTransitionInFlightRef.current ||
      !armedMissionId ||
      !missionGoal.trim()
    ) {
      return;
    }
    missionTransitionInFlightRef.current = true;
    if (prepareStatus === "running") {
      prepareGenerationRef.current += 1;
    }
    setSpawning(true);
    setError(null);
    try {
      await compileAndRouteMissionGoal({
        missionId: armedMissionId,
        goal: missionGoal,
        attachments: missionAttachments.map((attachment) => ({
          ...attachment,
        })),
        // Proveniência real do objetivo: issue importada e voz não são
        // "digitado" — o contrato registra de onde a missão nasceu.
        source: mode === "agentic" ? agenticSource : "typed",
        lane: missionLane,
        orchestrationMode,
        ...(orchestrationMode === "pack"
          ? { wavePackTemplateId }
          : {}),
        reviewPlan: options?.reviewPlan,
      });
    } finally {
      missionTransitionInFlightRef.current = false;
      setSpawning(false);
    }
  }

  async function handlePrepareProject() {
    if (!armedMissionId || prepareStatus === "running") return;
    const generation = ++prepareGenerationRef.current;
    setPrepareStatus("running");
    setPrepareDetail("Autorizando preparação e aquecendo o mapa local…");
    setError(null);
    try {
      await window.nexus.orch.prepareMissionProject({
        missionId: armedMissionId,
      });
      // Main owns the cancellable warm; renderer only reads the completed snapshot.
      const map = await window.nexus.orientation.get().catch(() => null);
      if (generation !== prepareGenerationRef.current) return;
      if (map && (map.status === "ready" || map.status === "partial")) {
        setPrepareStatus("ready");
        setPrepareDetail(
          map.status === "ready"
            ? "Projeto preparado. O mapa local está pronto; nenhum agente foi iniciado e não houve gasto de execução."
            : "Projeto preparado. O mapa local já permite continuar e terminará os detalhes em segundo plano; nenhum agente foi iniciado.",
        );
      } else {
        setPrepareStatus("ready");
        setPrepareDetail(
          "Preparação autorizada. O mapa local continua em segundo plano; você já pode continuar.",
        );
      }
    } catch (cause) {
      if (generation !== prepareGenerationRef.current) return;
      setPrepareStatus("error");
      const friendly = toUserFacingMissionError(
        cause,
        "Não foi possível preparar o projeto. Você ainda pode continuar sem essa etapa.",
      );
      setPrepareDetail(friendly);
      setError(friendly);
    }
  }

  function handleCancelPrepare() {
    prepareGenerationRef.current += 1;
    setPrepareStatus("cancelled");
    setPrepareDetail(
      "Preparação cancelada. A missão continua aguardando objetivo.",
    );
    if (armedMissionId) {
      void window.nexus.orch
        .cancelMissionPreparation({ missionId: armedMissionId })
        .catch(() => undefined);
    }
  }

  function handleOpenEmptyTerminal() {
    launchLibrePanes(["shell"], adapters);
    discardAndClose();
  }

  /** Shared dispatch core (plan step and one-click start). True = launched. */
  async function dispatchPlannedMission(
    planned: Mission,
    attachments: readonly MissionAttachment[] = missionAttachments,
    reviewedSquad?: Squad,
  ): Promise<boolean> {
    const boundRuntimeSquad =
      reviewedSquad ??
      (armedRuntimeSquadRef.current?.id === planned.squadId
        ? armedRuntimeSquadRef.current
        : squads.find((squad) => squad.id === planned.squadId));
    const squadSnapshot = boundRuntimeSquad ?? selectedSquad;
    if (!squadSnapshot || !planned.id) return false;
    const contract = planned.intentContract;
    if (!contract?.goal) {
      setError(
        "O plano da missão não ficou pronto. Volte ao objetivo e tente novamente.",
      );
      return false;
    }
    // Uma missão que já bloqueou (kickoff sem recibo, provider fora, boot que
    // não chegou a ocioso) não despacha por aprovação: approveIntent recusa
    // sair de blocked_* e o erro cru de IPC vazava para o usuário sem saída.
    // A retomada main-owned é o caminho sancionado — ela re-arma o estado e
    // revalida squad, contrato e runtime antes de qualquer spawn.
    //
    // Field trap (28/07): this short-circuit caught EVERY blocked mission,
    // including one blocked before it ever had an approval — "Encerrar como
    // bloqueada" on a pending mission. Resume then refuses with "A aprovação
    // da missão não está mais vigente", the OpsBoard refuses the lifecycle
    // change, and ✕ only offers a destructive delete: the mission is wedged
    // with deletion as the only exit. The re-approval lane for blocked_* was
    // already implemented in approveIntentFromRenderer and simply never
    // reached, because this branch intercepted first. Resume is the sanctioned
    // path only while an approval is actually current; otherwise the mission
    // needs approval, which is exactly what the code below does.
    const live = await currentMissionSnapshot(planned.id);
    const blockedSnapshot = live ?? planned;
    if (
      blockedSnapshot.status === "blocked" &&
      blockedSnapshot.intentContract?.approvedAt !== undefined
    ) {
      const { reopenMission } = await import("../orch/mission-reopen");
      const resumed = await reopenMission(blockedSnapshot);
      if (!resumed.ok) {
        setError(
          toUserFacingMissionError(
            resumed.error,
            "Não deu pra retomar a missão bloqueada.",
          ),
        );
        return false;
      }
      discardAndClose();
      return true;
    }
    // The main-owned bootstrap derives the roster exclusively from the saved
    // squad. Persist the exact roster reviewed in this wizard before approval
    // so a transient renderer object can never become hidden launch authority.
    const launchSquad: Squad = boundRuntimeSquad
      ? {
          ...boundRuntimeSquad,
          agents: boundRuntimeSquad.agents.map((agent) => ({ ...agent })),
        }
      : { ...squadSnapshot, agents: roster };
    // Squad reusado no agêntico: as instruções salvas ainda abrem com a
    // missão ANTIGA ("# Missão Clone Overclock…") — retarget para o objetivo
    // do contrato antes do kickoff, senão o orquestrador recebe duas missões.
    // Sempre o squad PERSISTIDO: se o built-in virou cópia, é o id da cópia
    // que o bootstrap main-owned vai encontrar no catálogo.
    const effectiveSquad: Squad = {
      ...launchSquad,
      agents: launchSquad.agents,
      orchestratorInstructions:
        mode === "agentic"
          ? retargetSquadInstructions(
              launchSquad.orchestratorInstructions,
              contract.goal,
            )
          : launchSquad.orchestratorInstructions,
    };
    const {
      compactMissionContext,
      missionCompactHasProgress,
      renderMissionCompact,
    } = await import("../../shared/mission-context-compact");
    const compact = compactMissionContext({
      mission: planned,
      handoffs: [],
    });
    const goalPrompt = [
      buildIntentDispatchKickoffPrompt({
        squad: effectiveSquad,
        missionTitle:
          mode === "agentic"
            ? missionTitleFromGoal(contract.goal, squadSnapshot.name)
            : undefined,
        missionId: planned.id,
        goal: contract.goal,
        acceptanceCriteria: contract.acceptanceCriteria,
        risk: contract.risk,
        maxWorkers: contract.budgets.maxWorkers,
        // First dispatch has no progress yet — the compact would only restate
        // goal/criteria that the kickoff already carries. Include it only when
        // it adds durable memory (resumes, learnings, files).
        compactMemoryMarkdown: missionCompactHasProgress(compact)
          ? renderMissionCompact(compact)
          : null,
        lane: contract.lane ?? "standard",
        operatorChoice: squadCliPolicy === "operator-choice",
        uiMissionObjective: isUiMissionText(
          [contract.goal, ...contract.acceptanceCriteria].join("\n"),
        ),
      }),
      buildMissionAttachmentsContext(attachments),
    ]
      .filter(Boolean)
      .join("\n\n");
    const result = await launchSquadMission(effectiveSquad, adapters, {
      existingMissionId: planned.id,
      missionTitle:
        mode === "agentic"
          ? missionTitleFromGoal(contract.goal, squadSnapshot.name)
          : undefined,
      goalPrompt,
      authorizeDispatch: async () => {
        const approved = await window.nexus.orch.approveMissionIntent({
          missionId: planned.id,
          evidenceAttached: attachments.length > 0,
          attachmentPaths:
            attachments.length > 0
              ? attachments.map((attachment) => attachment.path)
              : undefined,
        });
        if (
          approved.intentVersion !== planned.intentVersion ||
          approved.intentContract?.goal !== contract.goal
        ) {
          throw new Error(
            "O objetivo mudou durante o preflight; revise o plano novamente.",
          );
        }
        await recordRealMissionProductWizardStep(
          "approval-returned",
          planned.id,
        );
      },
    });
    if (!result.ok) {
      setError(
        toUserFacingMissionError(
          result.error,
          "Não foi possível iniciar a missão. Tente novamente.",
        ),
      );
      return false;
    }
    const isStarting = result.starting === true;
    const isRecovering = result.recovering === true;
    useToastStore.getState().push(
      isStarting || isRecovering ? "info" : "success",
      isStarting
        ? "Missão iniciando"
        : isRecovering
          ? "Missão em recuperação"
          : "Missão iniciada",
      isStarting
        ? `${planned.title} · o processo principal já assumiu a execução`
        : isRecovering
          ? `${planned.title} · o Nexus tentará novamente sem precisar de outro clique`
          : planned.title,
    );
    discardAndClose();
    return true;
  }

  async function handleStartFromIntentPlan() {
    if (
      spawning ||
      missionTransitionInFlightRef.current ||
      !selectedSquad ||
      !plannedMission?.id
    ) {
      return;
    }
    missionTransitionInFlightRef.current = true;
    setSpawning(true);
    setError(null);
    try {
      await dispatchPlannedMission(plannedMission);
    } catch (cause) {
      setError(
        toUserFacingMissionError(
          cause,
          "Não foi possível iniciar a missão. Tente novamente.",
        ),
      );
    } finally {
      missionTransitionInFlightRef.current = false;
      setSpawning(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="wizard"
      role="dialog"
      aria-modal="true"
      aria-label={hasNewWsStep ? "Novo workspace" : "Nova missão"}
      tabIndex={-1}
      onKeyDownCapture={handleDialogKeyDown}
    >
      {/* Soft-close: keeps typed objective. Hard discard only via Cancelar. */}
      <div className="wizard__overlay" onClick={softClose} />
      <div className="wizard__panel" data-step={step}>
        <header className="wizard__header">
          <span className="wizard__logo">&gt;_</span>
          <span className="wizard__title">
            {hasNewWsStep ? "Novo workspace" : "Nova Missão"}
          </span>
          <CloseButton
            className="wizard__close"
            onClick={softClose}
            label="Fechar"
          />
        </header>
        <StepsBar steps={steps} current={step} />

        <div className="wizard__body">
          {error &&
            [
              "new-ws",
              "mode",
              "agentic-intent",
              "libre-count",
              "squad-select",
            ].includes(step) && (
              <p className="wizard__error" role="alert" aria-live="assertive">
                {error}
              </p>
            )}
          {step === "new-ws" && (
            <div className="wizard__section">
              <label className="wizard__label" htmlFor="wizard-workspace-path">
                PASTA DO PROJETO
              </label>
              <div className="wizard__pasta">
                <input
                  id="wizard-workspace-path"
                  className="wizard__input"
                  value={wsPath}
                  placeholder="Escolha uma pasta em Procurar"
                  readOnly
                  aria-describedby="wizard-workspace-path-help"
                  autoFocus
                />
                <button
                  className="wizard__browse"
                  onClick={() => void browse()}
                >
                  PROCURAR
                </button>
              </div>
              <p id="wizard-workspace-path-help" className="wizard__hint-sm">
                A confirmação no seletor do sistema protege seus outros
                projetos. Workspaces SSH chegam em uma próxima versão.
              </p>
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
                  <button
                    className="wizard__btn wizard__btn--ghost"
                    onClick={discardAndClose}
                  >
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => setStep("mode")}
                    disabled={!wsPath.trim()}
                  >
                    Próximo ›
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "mode" && (
            <div className="wizard__section">
              <p className="wizard__label">COMO QUER TRABALHAR</p>
              <p
                className="wizard__mode-desc"
                style={{ marginTop: -6, marginBottom: 4 }}
              >
                Escolha o caminho. Pode mudar depois — o Nexus guarda o contexto
                da pasta.
              </p>
              <MissionModePicker
                selectedMode={mode}
                squadCount={squads.length}
                hasPlanningSquad={squads.some(
                  (s) => s.id === NEXUS_PLAN_SQUAD_ID,
                )}
                onChooseMode={chooseMode}
                onChoosePlanning={choosePlanejamento}
              />
              <div className="wizard__actions">
                {hasNewWsStep ? (
                  <button
                    className="wizard__btn"
                    onClick={() => setStep("new-ws")}
                  >
                    ‹ Voltar
                  </button>
                ) : (
                  <span />
                )}
                <button
                  className="wizard__btn wizard__btn--ghost"
                  onClick={discardAndClose}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {step === "agentic-intent" && (
            <div className="wizard__section">
              <label className="wizard__label" htmlFor="wizard-agentic-intent">
                O QUE VOCÊ QUER?
              </label>
              <textarea
                id="wizard-agentic-intent"
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
              {missionLane !== "standard" && (
                <button
                  type="button"
                  className="wizard__btn wizard__btn--ghost"
                  style={{ marginTop: 6, color: "var(--accent)" }}
                  title="O objetivo sugere este modo; clique para executar sem restrições"
                  onClick={() => {
                    laneTouchedByUserRef.current = true;
                    setMissionLane("standard");
                  }}
                >
                  Modo:{" "}
                  {missionLane === "consult"
                    ? "Só pesquisar (somente leitura)"
                    : missionLane === "plan"
                      ? "Só planejar"
                      : "Só infra"}{" "}
                  · mudar para execução
                </button>
              )}
              <p className="wizard__hint-sm">
                O Nexus lê seu objetivo e o projeto, monta a equipe certa e
                inclui revisão, segurança ou UX quando necessário. Você confere
                os agentes antes de começar.
              </p>
              <MissionAttachmentPicker
                attachments={missionAttachments}
                onChange={setMissionAttachments}
                disabled={designing}
              />
              <div className="wizard__actions">
                <button
                  className="wizard__btn"
                  onClick={() => setStep("mode")}
                  disabled={designing}
                >
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button
                    className="wizard__btn wizard__btn--ghost"
                    onClick={discardAndClose}
                  >
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => void handleDesignFromIntent()}
                    disabled={designing || !intent.trim()}
                  >
                    {designing ? (
                      "Preparando missão…"
                    ) : (
                      <>
                        <PixelIcon name="bolt" />
                        Preparar missão
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "libre-count" && (
            <div className="wizard__section">
              <p className="wizard__label">Quantos panes?</p>
              <div className="wizard__chips">
                {PANE_COUNTS.map((n) => (
                  <button
                    key={n}
                    className={`wizard__chip ${count === n ? "wizard__chip--active" : ""}`}
                    onClick={() => goCount(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="wizard__actions">
                <button className="wizard__btn" onClick={() => setStep("mode")}>
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button
                    className="wizard__btn wizard__btn--ghost"
                    onClick={discardAndClose}
                  >
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => setStep("libre-slots")}
                  >
                    Próximo ›
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "libre-slots" && (
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
                          {a.installed ? "" : " — não instalado"}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {error && (
                <p className="wizard__error" role="alert" aria-live="assertive">
                  {error}
                </p>
              )}
              <div className="wizard__actions">
                <button
                  className="wizard__btn"
                  onClick={() => setStep("libre-count")}
                >
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button
                    className="wizard__btn wizard__btn--ghost"
                    onClick={discardAndClose}
                  >
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => void handleLaunchLibre()}
                    disabled={spawning}
                  >
                    {spawning ? "Iniciando…" : "Iniciar Missão"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "squad-select" && (
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
                        className={`wizard__squad ${squadId === s.id ? "wizard__squad--active" : ""}`}
                        onClick={() => setSquadId(s.id)}
                      >
                        <span className="wizard__squad-name">
                          {s.name}{" "}
                          <span className="wizard__badge-original">
                            ORIGINAL
                          </span>
                        </span>
                        <span className="wizard__squad-count">
                          {workerCount(s)}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {userSquads.length > 0 && (
                <>
                  <p className="wizard__label">TIMES SALVOS</p>
                  <div className="wizard__squads">
                    {userSquads.map((s) => (
                      <button
                        key={s.id}
                        className={`wizard__squad ${squadId === s.id ? "wizard__squad--active" : ""}`}
                        onClick={() => setSquadId(s.id)}
                      >
                        <span className="wizard__squad-name">
                          <PixelIcon name="users" /> {s.name}
                        </span>
                        <span className="wizard__squad-count">
                          {workerCount(s)}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="wizard__actions">
                <button className="wizard__btn" onClick={() => setStep("mode")}>
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button
                    className="wizard__btn wizard__btn--ghost"
                    onClick={discardAndClose}
                  >
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    onClick={() => setStep("squad-review")}
                    disabled={!squadId}
                  >
                    Revisar ›
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "squad-review" && selectedSquad && (
            <MissionWizardReview
              squad={selectedSquad}
              roster={roster}
              adapters={adapters}
              providers={providers}
              accounts={accounts}
              squadCliPolicy={squadCliPolicy}
              missionGoal={effectiveMissionReviewGoal({
                mode,
                intent,
                missionGoal,
              })}
              guided={
                mode === "agentic" || selectedSquad.id === NEXUS_PLAN_SQUAD_ID
              }
              launchLabel={
                selectedSquad.id === NEXUS_PLAN_SQUAD_ID
                  ? "Definir objetivo do PRD"
                  : undefined
              }
              highlightedAgentId={highlightedAgentId}
              error={error}
              spawning={spawning}
              rosterSaved={rosterSaved}
              rosterInvalidAgent={rosterInvalidAgent}
              onSaveRoster={() => saveRoster()}
              onUpdateAgent={updateAgent}
              onSelectOrchestratorAdapter={(adapterId) => {
                if (!rosterOrchestrator) return;
                const selectedAdapter = adapters.find(
                  (adapter) => adapter.id === adapterId,
                );
                updateAgent(rosterOrchestrator.id, {
                  cli: adapterId,
                  model: selectedAdapter?.models.default,
                });
              }}
              onError={setError}
              onBack={() =>
                setStep(mode === "agentic" ? "agentic-intent" : "squad-select")
              }
              onCancel={discardAndClose}
              onLaunch={() => void handleLaunchSquad()}
            />
          )}

          {step === "intent-compose" && selectedSquad && (
            <div className="wizard__section">
              <label className="wizard__label" htmlFor="wizard-mission-goal">
                {selectedSquad.name.toUpperCase()} PRONTO
              </label>
              <p className="wizard__mode-desc" style={{ marginBottom: 12 }}>
                Aguardando seu objetivo. Nenhum especialista iniciado.{" "}
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
                id="wizard-mission-goal"
                className="wizard__input"
                style={{ minHeight: 120, resize: "vertical" }}
                value={missionGoal}
                placeholder="Descreva o objetivo da missão…"
                onChange={(e) => setMissionGoal(e.target.value)}
                autoFocus
              />
              <MissionAttachmentPicker
                attachments={missionAttachments}
                onChange={setMissionAttachments}
                disabled={spawning}
              />
              {missionGoalNeedsFutureEvidence(
                missionGoal,
                missionAttachments.length > 0,
              ) && (
                <p
                  className="wizard__mode-desc"
                  style={{ marginTop: 8, color: "var(--accent)" }}
                  role="status"
                >
                  A missão ficará aguardando os anexos. O Nexus não vai
                  despachar especialistas enquanto os prints/áudios não
                  chegarem.
                </p>
              )}
              <div style={{ marginTop: 12, marginBottom: 4 }}>
                <button
                  type="button"
                  className="wizard__btn wizard__btn--ghost"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  {advancedOpen ? "▾" : "▸"} Opções avançadas
                </button>
                {!advancedOpen && missionLane !== "standard" && (
                  <button
                    type="button"
                    className="wizard__btn wizard__btn--ghost"
                    style={{ marginLeft: 8, color: "var(--accent)" }}
                    title="O objetivo sugere este modo; clique para revisar ou trocar"
                    onClick={() => setAdvancedOpen(true)}
                  >
                    Modo:{" "}
                    {missionLane === "consult"
                      ? "Só pesquisar (somente leitura)"
                      : missionLane === "plan"
                        ? "Só planejar"
                        : "Só infra"}{" "}
                    · trocar
                  </button>
                )}
                {!advancedOpen && orchestrationMode !== "guided" && (
                  <button
                    type="button"
                    className="wizard__btn wizard__btn--ghost"
                    style={{ marginLeft: 8, color: "var(--accent)" }}
                    title="Orquestração Livre ou Pack; clique para revisar"
                    onClick={() => setAdvancedOpen(true)}
                  >
                    Orquestração:{" "}
                    {orchestrationMode === "livre"
                      ? "Livre"
                      : `Pack · ${wavePackTemplateId}`}{" "}
                    · trocar
                  </button>
                )}
                {advancedOpen && (
                  <fieldset
                    className="wizard__mode-desc"
                    style={{
                      marginTop: 8,
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "10px 12px",
                    }}
                  >
                    <legend style={{ padding: "0 4px" }}>
                      Restringir o que o Nexus pode fazer
                    </legend>
                    {!laneTouchedByUserRef.current && suggestedLane && (
                      <p
                        className="wizard__mode-desc"
                        style={{ marginBottom: 8, color: "var(--accent)" }}
                        role="status"
                      >
                        Sugerido pelo objetivo:{" "}
                        {suggestedLane === "plan"
                          ? "Só planejar"
                          : suggestedLane === "ops"
                            ? "Só infra"
                            : "Só pesquisar"}
                        . Pode mudar abaixo.
                      </p>
                    )}
                    <label
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        marginBottom: 8,
                      }}
                    >
                      <input
                        type="radio"
                        name="mission-lane"
                        checked={missionLane === "standard"}
                        onChange={() => {
                          laneTouchedByUserRef.current = true;
                          setMissionLane("standard");
                        }}
                      />
                      <span>
                        <strong>Sem restrições (recomendado)</strong> — o Nexus
                        executa tudo: código, terminal, deploy.
                      </span>
                    </label>
                    <label
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        marginBottom: 8,
                      }}
                    >
                      <input
                        type="radio"
                        name="mission-lane"
                        checked={missionLane === "consult"}
                        onChange={() => {
                          laneTouchedByUserRef.current = true;
                          setMissionLane("consult");
                        }}
                      />
                      <span>
                        <strong>Só pesquisar (não muda nada)</strong>
                      </span>
                    </label>
                    <label
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        marginBottom: 8,
                      }}
                    >
                      <input
                        type="radio"
                        name="mission-lane"
                        checked={missionLane === "plan"}
                        onChange={() => {
                          laneTouchedByUserRef.current = true;
                          setMissionLane("plan");
                        }}
                      />
                      <span>
                        <strong>Só planejar (escreve apenas o plano)</strong>
                      </span>
                    </label>
                    <label
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                      }}
                    >
                      <input
                        type="radio"
                        name="mission-lane"
                        checked={missionLane === "ops"}
                        onChange={() => {
                          laneTouchedByUserRef.current = true;
                          setMissionLane("ops");
                        }}
                      />
                      <span>
                        <strong>Só infra (não edita código do projeto)</strong>
                      </span>
                    </label>
                  </fieldset>
                )}
                {advancedOpen && (
                  <fieldset
                    className="wizard__mode-desc"
                    style={{
                      marginTop: 8,
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "10px 12px",
                    }}
                  >
                    <legend style={{ padding: "0 4px" }}>
                      Orquestração (Livre · Pack · Guiado)
                    </legend>
                    <label
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        marginBottom: 8,
                      }}
                    >
                      <input
                        type="radio"
                        name="mission-orch-mode"
                        checked={orchestrationMode === "guided"}
                        onChange={() => setOrchestrationMode("guided")}
                      />
                      <span>
                        <strong>Guiado</strong> — grafo selado, cerca PREVC
                        quando sensível
                      </span>
                    </label>
                    <label
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        marginBottom: 8,
                      }}
                    >
                      <input
                        type="radio"
                        name="mission-orch-mode"
                        checked={orchestrationMode === "pack"}
                        onChange={() => setOrchestrationMode("pack")}
                      />
                      <span>
                        <strong>Wave Pack</strong> — N stories em panes
                        paralelos (template obrigatório no lançamento)
                      </span>
                    </label>
                    <label
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                      }}
                    >
                      <input
                        type="radio"
                        name="mission-orch-mode"
                        checked={orchestrationMode === "livre"}
                        onChange={() => setOrchestrationMode("livre")}
                      />
                      <span>
                        <strong>Livre</strong> — sem seal Guided; orquestrador
                        spawna ≤ maxWorkers
                      </span>
                    </label>
                    {orchestrationMode === "pack" ? (
                      <label style={{ display: "block", marginTop: 8 }}>
                        Template Pack
                        <select
                          className="wizard__input"
                          style={{
                            display: "block",
                            width: "100%",
                            marginTop: 6,
                          }}
                          value={wavePackTemplateId}
                          onChange={(e) =>
                            setWavePackTemplateId(
                              e.target.value as WavePackTemplateId,
                            )
                          }
                        >
                          {WAVE_PACK_TEMPLATES.map((template) => (
                            <option key={template.id} value={template.id}>
                              {template.label} — {template.hint}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </fieldset>
                )}
              </div>
              <div
                className="wizard__mode-desc"
                style={{ marginTop: 12, marginBottom: 8 }}
              >
                <p style={{ marginBottom: 6 }}>
                  <strong>Preparar projeto</strong> (opcional): aquece o mapa
                  local do repositório. Não abre agentes nem inventa tarefas.
                  Você pode ocultar o andamento; o aquecimento local pode
                  terminar em segundo plano.
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="wizard__btn wizard__btn--ghost"
                    disabled={prepareStatus === "running" || !armedMissionId}
                    onClick={() => void handlePrepareProject()}
                  >
                    {prepareStatus === "running"
                      ? "Preparando…"
                      : prepareStatus === "ready"
                        ? "Preparar de novo"
                        : "Preparar projeto"}
                  </button>
                  {prepareStatus === "running" && (
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
              {error && (
                <p className="wizard__error" role="alert" aria-live="assertive">
                  {error}
                </p>
              )}
              <div className="wizard__actions">
                <button
                  className="wizard__btn wizard__btn--ghost"
                  onClick={() => setStep("squad-review")}
                >
                  ‹ Voltar
                </button>
                <div className="wizard__actions-right">
                  <button
                    className="wizard__btn wizard__btn--ghost"
                    onClick={discardAndClose}
                  >
                    Cancelar
                  </button>
                  <button
                    className="wizard__btn wizard__btn--ghost"
                    disabled={spawning || !missionGoal.trim()}
                    onClick={() =>
                      void handleSubmitMissionGoal({ reviewPlan: true })
                    }
                  >
                    Revisar plano ›
                  </button>
                  <button
                    className="wizard__btn wizard__btn--primary"
                    disabled={spawning || !missionGoal.trim()}
                    onClick={() => void handleSubmitMissionGoal()}
                  >
                    {spawning
                      ? "Preparando aprovação…"
                      : "Continuar para aprovação"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "intent-plan" && selectedSquad && plannedMission && (
            <MissionWizardPlanReview
              mission={plannedMission}
              squad={selectedSquad}
              roster={roster}
              adapters={adapters}
              error={error}
              spawning={spawning}
              onBack={() => setStep("intent-compose")}
              onCancel={discardAndClose}
              onStart={() => void handleStartFromIntentPlan()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
