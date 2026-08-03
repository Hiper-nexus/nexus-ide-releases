import type { AdapterInfo, PaneModel } from "../../shared/types";
import type { Squad } from "../../shared/orch-types";
import {
  adapterCapabilityMatrixOf,
  orchestrationEvidenceOf,
} from "../../shared/adapter-types";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import {
  buildIntentDispatchKickoffPrompt as buildSharedIntentDispatchKickoffPrompt,
  type IntentDispatchKickoffInput,
} from '../../shared/mission-dispatch-kickoff';
import {
  buildMissionKickoffPrompt,
  type SquadLaunchProfile,
} from './mission-launcher-kickoff-prompt';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { QUOTA_HIGH_USAGE_THRESHOLD } from "../../shared/quota-types";
import { useLayoutStore } from "../state/layout-store";
import { useHomeStore } from "../state/home-store";
import { useOrchStore } from "../state/orch-store";
import { useToastStore } from "../state/toast-store";
import {
  createPane,
  isStructuralPlaceholderPane,
  listPanes,
} from "../lib/split-tree";
import { getActiveWorkspacePath } from "../state/active-workspace";
import {
  getPaneSessionId,
  waitForSession,
} from "../terminal/terminal-host";
import {
  hasDeclaredOrchestratorMcpRoute,
  isDeclaredOrchestratorAdapter,
  resolveOrchestratorRuntime,
} from "./orchestrator-runtime";
import {
  conflictingOrchestratorPanes,
} from "./mission-auth-conflict";

export {
  buildMissionKickoffPrompt,
  type SquadLaunchProfile,
};

/**
 * Launch logic behind the wizard when a
 * mission starts:
 *  - LIVRE: open N solo panes (shell or agent CLI) in the workspace;
 *  - SQUAD: spawn the squad's orchestrator CLI and, once it finishes booting,
 *    inject its orchestratorInstructions + roster as the kickoff prompt
 *    (bracketed paste, then Enter) so it immediately starts delegating via
 *    the embedded MCP tools.
 */

/**
 * Mata TODAS as sessões CLI do grid. Prefer `killConflictingOrchestrators`
 * quando o adapter entrante não partilha login (multi-missão segura).
 * Claude dual-orch reescreve o mesmo keychain — aí o kill seletivo/full
 * ainda é obrigatório.
 */
export function killLiveAgents(): void {
  const { root } = useLayoutStore.getState();
  for (const pane of listPanes(root)) {
    if (pane.kind === "cli-agent") {
      const sid = getPaneSessionId(pane.id);
      if (sid) window.nexus.pty.kill(sid);
    }
  }
}

export {
  conflictingOrchestratorPanes,
  hardReopenWouldKillAgents,
  killConflictingOrchestrators,
  sharedAuthFamily,
} from "./mission-auth-conflict";
/**
 * Cold orientation builds scan the whole repo and can take far longer than a
 * CLI boot. The kickoff already has a "mapa aquecendo" fallback, so never hold
 * the paste hostage to the warm — the doctor recovers the map on demand.
 */
const ORIENTATION_KICKOFF_WAIT_MS = 4_000;

/** Resolve with `null` (instead of hanging) when the warm outlasts the boot. */
export async function orientationForKickoff(
  ensure: () => Promise<{ orientationMarkdown?: string | null } | null>,
  timeoutMs = ORIENTATION_KICKOFF_WAIT_MS,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ensure().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return result?.orientationMarkdown ?? null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Modo Livre: build a fresh grid of EXACTLY one pane per slot, each backed by
 * the chosen provider (or a plain shell). Replaces the current grid so "2
 * panes" reliably shows two — no fragile iterative splitting.
 */
export function launchLibrePanes(
  slots: string[],
  _adapters: AdapterInfo[],
): void {
  const cwd = getActiveWorkspacePath() ?? undefined;
  const panes: PaneModel[] = slots.map((slot) => {
    if (slot === "shell") return createPane("shell", cwd);
    return createPane("cli-agent", cwd, slot);
  });
  useHomeStore.getState().hide();
  useLayoutStore.getState().setPanes(panes);
}

export interface SquadLaunchResult {
  ok: boolean;
  paneId?: string;
  /** Intent-first: mission armed without an agent pane. */
  armed?: boolean;
  /** Approval succeeded and Main is materializing the first mission pane. */
  starting?: boolean;
  /** Main still owns the approved mission and will retry without operator input. */
  recovering?: boolean;
  missionId?: string;
  error?: string;
}

export interface SquadLaunchOptions {
  /** Lightweight profiles can bypass the repository orchestration playbook. */
  profile?: SquadLaunchProfile;
  /** Dedicated squads may require a specific provider regardless of defaults. */
  adapterId?: string;
  /**
   * Force legacy zero-click kickoff (orchestrator pane + playbook).
   * Default follows orch.intentFirstMissionRuntimeV1.
   */
  forceLegacyLaunch?: boolean;
  /**
   * When dispatching after intent approval, bind work to this mission and
   * inject a goal-scoped kickoff instead of the bootstrap playbook.
   */
  existingMissionId?: string;
  /** Goal text for post-intent dispatch kickoff. */
  goalPrompt?: string;
  /**
   * Runs only after provider/account preflight succeeds and immediately before
   * creating the orchestrator pane. Used to make intent dispatch fail closed
   * without leaving a mission authorized when no provider can launch.
   */
  authorizeDispatch?: () => Promise<void>;
  /**
   * Título da missão quando o objetivo do usuário é conhecido (modo agêntico).
   * Sem ele, a missão herda o nome do squad — errado quando o squad é reusado
   * de outra missão ("Clone Reference ADE" numa missão de dashboards).
   */
  missionTitle?: string;
  /** Full immediate goal/briefing; native-confirmed and contract-bound. */
  missionGoal?: string;
}

export function initialGoalForArmedMission(input: {
  isAgentic: boolean;
  designedIntent: string;
}): string {
  return input.isAgentic ? input.designedIntent.trim() : '';
}

export function squadLaunchDedupeKey(
  cwd: string | undefined,
  squadId: string,
  existingMissionId?: string,
): string {
  return [cwd ?? '', squadId, existingMissionId ?? ''].join('\u0000');
}

/**
 * Compact post-approval kickoff. It keeps the approved goal as scope while
 * preserving the Nexus autopilot invariants that used to live only in the
 * legacy monolithic prompt.
 */
export function buildIntentDispatchKickoffPrompt(input: {
  squad: IntentDispatchKickoffInput['squad'];
  missionId: IntentDispatchKickoffInput['missionId'];
  goal: IntentDispatchKickoffInput['goal'];
  acceptanceCriteria: IntentDispatchKickoffInput['acceptanceCriteria'];
  risk: IntentDispatchKickoffInput['risk'];
  maxWorkers: IntentDispatchKickoffInput['maxWorkers'];
  attachmentPaths?: IntentDispatchKickoffInput['attachmentPaths'];
  compactMemoryMarkdown?: IntentDispatchKickoffInput['compactMemoryMarkdown'];
  lane?: IntentDispatchKickoffInput['lane'];
  missionTitle?: IntentDispatchKickoffInput['missionTitle'];
  promotedPlan?: IntentDispatchKickoffInput['promotedPlan'];
  guidedPrevcRequired?: IntentDispatchKickoffInput['guidedPrevcRequired'];
  standardTopology?: IntentDispatchKickoffInput['standardTopology'];
  operatorChoice?: IntentDispatchKickoffInput['operatorChoice'];
  uiMissionObjective?: IntentDispatchKickoffInput['uiMissionObjective'];
}): string {
  return buildSharedIntentDispatchKickoffPrompt(input);
}

interface MissionMaterializationInput {
  paneId: string;
  title: string;
  goal?: string;
  squadId: string;
  /** When set, bind the live pane to this armed mission instead of creating one. */
  existingMissionId?: string;
  orchestratorPane: {
    paneId: string;
    adapterId: string;
    model?: string;
    accountId?: string;
    cwd?: string;
    title?: string;
    agentName?: string;
  };
}

interface MissionMaterializationDeps {
  waitForSession(paneId: string): Promise<string | null>;
  createMission(
    input: Omit<MissionMaterializationInput, 'paneId' | 'existingMissionId'>,
  ): ReturnType<typeof window.nexus.orch.createMission>;
  bindMission?(
    input: {
      missionId: string;
      title: string;
      squadId: string;
      orchestratorPane: MissionMaterializationInput['orchestratorPane'];
    },
  ): ReturnType<typeof window.nexus.orch.bindMissionOrchestrator>;
  updateMission(
    missionId: string,
    patch: { status: 'running' },
  ): ReturnType<typeof window.nexus.orch.updateMission>;
  removeMission?(
    missionId: string,
  ): ReturnType<typeof window.nexus.orch.removeMission>;
}

/** Autoridade só existe quando o PTY concreto e o registro persistido existem. */
export async function materializeSquadMission(
  input: MissionMaterializationInput,
  deps: MissionMaterializationDeps = {
    waitForSession,
    createMission: (missionInput) =>
      window.nexus.orch.createMission(missionInput),
    bindMission: (bindInput) =>
      window.nexus.orch.bindMissionOrchestrator(bindInput),
    updateMission: (missionId, patch) =>
      window.nexus.orch.updateMission(missionId, patch),
    removeMission: (missionId) => window.nexus.orch.removeMission(missionId),
  },
) {
  const sessionId = await deps.waitForSession(input.paneId);
  if (!sessionId) {
    throw new Error('O terminal do orquestrador não iniciou em 20 segundos.');
  }
  if (input.existingMissionId) {
    if (!deps.bindMission) {
      throw new Error('bindMission dependency required for existingMissionId');
    }
    const mission = await deps.bindMission({
      missionId: input.existingMissionId,
      title: input.title,
      squadId: input.squadId,
      orchestratorPane: input.orchestratorPane,
    });
    return { sessionId, mission };
  }
  const mission = await deps.createMission({
    title: input.title,
    ...(input.goal ? { goal: input.goal } : {}),
    squadId: input.squadId,
    orchestratorPane: input.orchestratorPane,
  });
  // Main creates and publishes the authorized legacy mission atomically. The
  // renderer cannot promote lifecycle state after the fact.
  return { sessionId, mission };
}

/**
 * A freshly hydrated workspace contains one placeholder shell. Starting a
 * squad replaces placeholder-only layouts instead of leaving an unexplained
 * empty terminal beside the orchestrator. Existing agent/mixed layouts are
 * preserved for multi-mission operation.
 */
export function panesAfterSquadLaunch(
  existing: PaneModel[],
  killedIds: ReadonlySet<string>,
  orchestrator: PaneModel,
): PaneModel[] {
  if (
    existing.length === 0 ||
    (existing.length === 1 && isStructuralPlaceholderPane(existing[0]!)) ||
    (killedIds.size > 0 && existing.every((pane) => killedIds.has(pane.id)))
  ) {
    return [orchestrator];
  }
  return [...existing.filter((pane) => !killedIds.has(pane.id)), orchestrator];
}

const FALLBACK_ORCHESTRATOR_ADAPTER_ID = "claude";
const squadLaunchesInFlight = new Map<string, string>();

export async function launchSquadMission(
  squad: Squad,
  adapters: AdapterInfo[],
  options: SquadLaunchOptions = {},
): Promise<SquadLaunchResult> {
  const profile: SquadLaunchProfile =
    options.profile ??
    (squad.id === PET_STUDIO_SQUAD_ID ? 'pet-studio' : 'standard');
  const orchestrator =
    squad.agents.find((a) => a.category === "orchestrator") ?? null;
  if (!orchestrator) {
    return { ok: false, error: "Este squad não tem Maestro." };
  }
  if (options.existingMissionId && !options.goalPrompt?.trim()) {
    return {
      ok: false,
      error: "Uma missão aprovada exige um kickoff vinculado ao objetivo atual.",
    };
  }
  if (options.goalPrompt && !options.existingMissionId) {
    return {
      ok: false,
      error: "Um kickoff de objetivo exige uma missão aprovada vinculada.",
    };
  }

  const orchDefaults = await window.nexus.settings.orchGet();
  const operatorChoice = isOperatorChoicePolicy(
    orchDefaults.squadCliPolicy,
  );
  if (
    options.forceLegacyLaunch &&
    profile !== 'pet-studio' &&
    orchDefaults.intentFirstMissionRuntimeV1 !== false
  ) {
    return {
      ok: false,
      error:
        'O lançamento legado exige a exceção principal intent-first desativada nas configurações.',
    };
  }

  const rosterAdapterId = orchestrator.cli?.trim();
  const configuredAdapterId =
    options.adapterId ||
    (profile === 'pet-studio' ? 'codex' : undefined) ||
    rosterAdapterId ||
    orchDefaults.defaultAdapterId ||
    FALLBACK_ORCHESTRATOR_ADAPTER_ID;
  const selectedAdapter = adapters.find(
    (adapter) => adapter.id === configuredAdapterId,
  );
  if (!selectedAdapter) {
    return {
      ok: false,
      error:
        `Provider do orquestrador \`${configuredAdapterId}\` não foi carregado. ` +
        "Escolha outro em Configurações › Providers.",
    };
  }
  const selectedCapabilities = adapterCapabilityMatrixOf(selectedAdapter);
  const operatorRouteReady =
    selectedAdapter.kind === 'cli-pty' &&
    selectedAdapter.installed &&
    selectedAdapter.missionControlCapable === true &&
    selectedCapabilities.launchable &&
    selectedCapabilities.promptInjectable &&
    selectedCapabilities.statusObservable;
  if (
    operatorChoice
      ? !operatorRouteReady
      : !hasDeclaredOrchestratorMcpRoute(selectedAdapter)
  ) {
    return {
      ok: false,
      error:
        operatorChoice
          ? `${selectedAdapter.label} não oferece o canal Main-owned de controle e conclusão necessário para coordenar esta missão. Ela continua disponível como worker/reviewer quando tiver handoff PTY.`
          : `${selectedAdapter.label} ainda não declara uma rota Nexus MCP ` +
            "para coordenar squads. Escolha um provider compatível nas Configurações.",
    };
  }
  if (
    operatorChoice
      ? !selectedAdapter.installed
      : !isDeclaredOrchestratorAdapter(selectedAdapter)
  ) {
    return {
      ok: false,
      error:
        `CLI \`${selectedAdapter.id}\` não está instalada. ` +
        "Instale-a ou escolha outro provider em Configurações › Providers.",
      };
  }
  // Intent-first selection is inert: zero panes, zero CLI work, zero tokens.
  // The later dispatch is allowed only when it carries the main-owned native
  // approval callback. This is the single experimental-route acknowledgement.
  const intentFirst =
    profile !== 'pet-studio' &&
    !options.forceLegacyLaunch &&
    !options.existingMissionId &&
    orchDefaults.intentFirstMissionRuntimeV1 !== false;
  const nativeApprovalBoundDispatch = Boolean(
    options.existingMissionId && options.authorizeDispatch,
  );
  const orchestrationEvidence = orchestrationEvidenceOf(selectedAdapter);
  if (!operatorChoice && orchestrationEvidence === 'unsupported') {
    return {
      ok: false,
      error:
        `${selectedAdapter.label} não tem evidência válida para coordenar ` +
        'squads. Escolha outro provider em Configurações › Squads.',
    };
  }
  if (
    !operatorChoice &&
    orchestrationEvidence === 'experimental' &&
    !intentFirst &&
    !nativeApprovalBoundDispatch
  ) {
    return {
      ok: false,
      error:
        `${selectedAdapter.label} declara a rota Nexus, mas a orquestração ` +
        'ainda é experimental. Use o fluxo de missão com aprovação nativa ' +
        'ou escolha um Maestro verificado em Configurações › Squads.',
    };
  }

  // Intent-first: selecting a squad arms a shell only — zero panes, zero tokens.
  // Pet Studio and explicit legacy/dispatch paths keep the full launch.
  if (intentFirst) {
    try {
      useHomeStore.getState().hide();
      const mission = await window.nexus.orch.armMission({
        title: options.missionTitle?.trim() || squad.name,
        squadId: squad.id,
      });
      return {
        ok: true,
        armed: true,
        missionId: mission.id,
      };
    } catch (cause) {
      return {
        ok: false,
        error:
          cause instanceof Error
            ? `A missão não foi armada: ${cause.message}`
            : 'A missão não foi armada.',
      };
    }
  }

  /**
   * Approved intent path: Main already owns provider/model/account selection
   * and seals the physical launch. Renderer account and quota discovery below
   * is only useful to legacy/manual launches; doing it here kept the native
   * approval sheet waiting on two unrelated IPCs.
   */
  if (options.existingMissionId) {
    if (options.authorizeDispatch) {
      try {
        await options.authorizeDispatch();
      } catch (cause) {
        return {
          ok: false,
          error:
            cause instanceof Error
              ? `A missão não foi autorizada: ${cause.message}`
              : 'A missão não foi autorizada.',
        };
      }
    }
    return {
      ok: true,
      missionId: options.existingMissionId,
      starting: true,
    };
  }

  const [accounts, quotaSnap] = await Promise.all([
    window.nexus.accounts.list(),
    window.nexus.quota?.snapshot?.().catch(() => null) ?? Promise.resolve(null),
  ]);

  const cli = selectedAdapter.id;
  // P2: warn when default account for orchestrator CLI is high-usage / cooldown.
  if (quotaSnap) {
    const defaultAcct =
      accounts.find(
        (a) =>
          a.adapterId === cli &&
          (a.id === orchDefaults.defaultAccountId || a.active),
      ) ?? accounts.find((a) => a.adapterId === cli && a.active);
    const entry = quotaSnap.entries.find(
      (e) =>
        e.adapterId === cli &&
        (defaultAcct ? e.accountId === defaultAcct.id : !e.accountId),
    ) ?? quotaSnap.entries.find((e) => e.adapterId === cli);
    if (entry) {
      const worst = entry.onCooldown
        ? 1
        : entry.windows.reduce<number | null>((acc, w) => {
            if (w.usedRatio === null) return acc;
            if (acc === null || w.usedRatio > acc) return w.usedRatio;
            return acc;
          }, null);
      if (
        entry.onCooldown ||
        (worst !== null && worst >= QUOTA_HIGH_USAGE_THRESHOLD)
      ) {
        console.warn(
          '[mission-launcher] high quota pressure on orchestrator account:',
          entry.label,
          worst,
        );
        // Soft signal: still launches, but surfaces toast for the operator.
        try {
          const { useToastStore } = await import('../state/toast-store');
          useToastStore.getState().push(
            'warn',
            'Cota alta no orquestrador',
            entry.onCooldown
              ? `"${entry.label}" em cooldown — squad pode falhar no limite.`
              : `"${entry.label}" com ~${Math.round((worst ?? 0) * 100)}% na pior janela.`,
          );
        } catch {
          /* toast optional */
        }
      }
    }
  }
  const runtime = resolveOrchestratorRuntime({
    adapterId: cli,
    squadModel: rosterAdapterId === cli ? orchestrator.model : undefined,
    defaultModel: orchDefaults.defaultModel,
    defaultAccountId: orchDefaults.defaultAccountId,
    accounts,
  });
  const { model, accountId } = runtime;

  // Squad opens with orchestrator pane. Workers are added via MCP as it
  // delegates. Multi-mission: when the new orch does not share exclusive
  // login (Claude keychain), keep other live panes — no blanket kill.
  const cwd = getActiveWorkspacePath() ?? undefined;
  const launchKey = squadLaunchDedupeKey(
    cwd,
    squad.id,
    options.existingMissionId,
  );
  const existingLaunchPane = squadLaunchesInFlight.get(launchKey);
  if (existingLaunchPane) {
    // Voice/tool retries and a double click can reach this function before
    // the first async mission registration finishes. Treat that retry as the
    // same launch instead of creating an indistinguishable queued mission.
    return { ok: true, paneId: existingLaunchPane };
  }
  const orchPane: PaneModel = {
    ...createPane("cli-agent", cwd, cli, model),
    accountId,
    title: `${squad.name} · orq`,
    missionId: options.existingMissionId,
    role: "orchestrator" as const,
    agentName: orchestrator.agentName,
  };
  const immediateMissionTitle =
    options.missionTitle?.trim() || squad.name;
  const immediateMissionGoal =
    options.missionGoal?.trim() || immediateMissionTitle;
  try {
    const authorized =
      await window.nexus.orch.authorizeImmediateSquadLaunch({
        squadId: squad.id,
        paneId: orchPane.id,
        adapterId: cli,
        model,
        accountId,
        effort: orchestrator.effort,
        missionTitle: immediateMissionTitle,
        missionGoal: immediateMissionGoal,
      });
    orchPane.orchRequestId = authorized.grant;
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error
          ? `O lançamento imediato não foi autorizado: ${cause.message}`
          : "O lançamento imediato não foi autorizado.",
    };
  }
  squadLaunchesInFlight.set(launchKey, orchPane.id);
  const { paneMissions, missions } = useOrchStore.getState();
  const existing = listPanes(useLayoutStore.getState().root);
  if (options.authorizeDispatch) {
    try {
      await options.authorizeDispatch();
    } catch (cause) {
      squadLaunchesInFlight.delete(launchKey);
      return {
        ok: false,
        error:
          cause instanceof Error
            ? `A missão não foi autorizada: ${cause.message}`
            : 'A missão não foi autorizada.',
      };
    }
  }
  const conflicts = conflictingOrchestratorPanes(cli);
  const killedIds = new Set<string>();
  // Only mark missions blocked when we actually tore down their orch.
  const displaced = new Set<string>();
  for (const pane of conflicts) {
    const sessionId = getPaneSessionId(pane.id);
    const mid =
      paneMissions[pane.id] ??
      (sessionId
        ? missions.find((mission) => mission.orchestratorSessionId === sessionId)?.id
        : undefined);
    if (!mid) {
      squadLaunchesInFlight.delete(launchKey);
      return {
        ok: false,
        error:
          'Existe um orquestrador incompatível sem autoridade de missão ' +
          'resolvida. Feche-o explicitamente antes de continuar.',
      };
    }
    displaced.add(mid);
  }

  // Só confirma sucesso depois que PTY e missão existem. Antes este trecho
  // inteiro rodava em background: timeout/IPC falhava silenciosamente, o
  // wizard fechava e sobrava apenas um squad órfão no banco.
  let sessionId: string | null = null;
  let mission: Awaited<ReturnType<typeof window.nexus.orch.createMission>>;
  try {
    for (const missionId of displaced) {
      await window.nexus.orch.updateMission(missionId, {
        status: "blocked",
      });
    }
    for (const pane of conflicts) killedIds.add(pane.id);
    useHomeStore.getState().hide();
    useLayoutStore.getState().setPanes(
      panesAfterSquadLaunch(existing, killedIds, orchPane),
    );
    // `setPanes` preserves ordering and therefore focuses the first retained
    // shell. In Canvas that focus is also the stacking authority (z=1000), so
    // the shell was literally rendered in front of the newly launched mission
    // even though I2 had correctly cleared `maximizedPaneId`.
    useLayoutStore.getState().focus(orchPane.id);
    const materialized = await materializeSquadMission({
      paneId: orchPane.id,
      title: immediateMissionTitle,
      goal: immediateMissionGoal,
      squadId: squad.id,
      existingMissionId: options.existingMissionId,
      orchestratorPane: {
        paneId: orchPane.id,
        adapterId: cli,
        model,
        accountId,
        cwd,
        title: orchPane.title,
        agentName: orchestrator.agentName,
      },
    });
    sessionId = materialized.sessionId;
    mission = materialized.mission;
    useOrchStore.getState().bindPaneMission(orchPane.id, mission.id);
  } catch (cause) {
    if (sessionId) window.nexus.pty.kill(sessionId);
    useLayoutStore.getState().setPanes(
      listPanes(useLayoutStore.getState().root).filter(
        (pane) => pane.id !== orchPane.id,
      ),
    );
    squadLaunchesInFlight.delete(launchKey);
    return {
      ok: false,
      error:
        cause instanceof Error
          ? `A missão não foi iniciada: ${cause.message}`
          : 'A missão não foi iniciada.',
    };
  }

  // O renderer só solicita o submit por identidade. O main reconstrói o prompt
  // canônico do contrato+squad e também possui idle, escrita e prova física.
  void (async () => {
    try {
      const result = await window.nexus.orch.submitMissionKickoff({
        sessionId,
        missionId: mission.id,
      });
      if (!result.accepted && !result.retryScheduled) {
        useToastStore.getState().push('error', 'Kickoff não foi aceito', {
          detail: result.detail,
          action: {
            label: result.cta,
            onClick: () => {
              useLayoutStore.getState().focus(orchPane.id);
              useOrchStore.getState().openPanel('missions');
            },
          },
        });
      }
    } catch (cause) {
      useToastStore.getState().push('error', 'Kickoff não foi enviado', {
        detail: cause instanceof Error ? cause.message : 'Falha de autoridade no main.',
        action: {
          label: 'Retomar missão',
          onClick: () => {
            useLayoutStore.getState().focus(orchPane.id);
            useOrchStore.getState().openPanel('missions');
          },
        },
      });
    } finally {
      squadLaunchesInFlight.delete(launchKey);
    }
  })();

  return { ok: true, paneId: orchPane.id, missionId: mission.id };
}
