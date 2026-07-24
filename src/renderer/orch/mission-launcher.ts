import type { AdapterInfo, PaneModel } from "../../shared/types";
import type { Squad, SquadAgent } from "../../shared/orch-types";
import {
  buildIntentDispatchKickoffPrompt as buildSharedIntentDispatchKickoffPrompt,
  type IntentDispatchKickoffInput,
} from '../../shared/mission-dispatch-kickoff';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { QUOTA_HIGH_USAGE_THRESHOLD } from "../../shared/quota-types";
import { useLayoutStore } from "../state/layout-store";
import { useHomeStore } from "../state/home-store";
import { useOrchStore } from "../state/orch-store";
import { useToastStore } from "../state/toast-store";
import { listPanes, createPane } from "../lib/split-tree";
import { getActiveWorkspacePath } from "../state/active-workspace";
import {
  getPaneSessionId,
  waitForSession,
} from "../terminal/terminal-host";
import { presentMainOwnedMissionPane } from './mission-pane-presentation';
import {
  hasOrchestratorMcpRoute,
  isOrchestratorCapableAdapter,
  resolveOrchestratorRuntime,
} from "./orchestrator-runtime";
import {
  conflictingOrchestratorPanes,
} from "./mission-auth-conflict";

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

function rosterBlock(agents: SquadAgent[]): string {
  return agents
    .filter((a) => a.category !== "orchestrator")
    .map(
      (a) =>
        `- ${a.agentName} (${a.category}, cli=${a.cli}` +
        `${a.model ? `, model=${a.model}` : ""})`,
    )
    .join("\n");
}

export function buildMissionKickoffPrompt(
  squad: Squad,
  missionId?: string,
  orientationMarkdown?: string | null,
  profile: SquadLaunchProfile = 'standard',
): string {
  if (profile === 'pet-studio') {
    return [
      squad.orchestratorInstructions.trim(),
      '## Execução direta\n' +
        'Esta é uma missão visual dedicada e já está registrada e em execução. ' +
        'Permaneça nesta sessão, não delegue e não envie comandos de continuação. ' +
        'Use a skill hatch-pet diretamente; ela contém o contrato e o QA completos. ' +
        'Depois que o pacote validado existir, chame nexus_handoff_submit uma única vez ' +
        'com status success e artifacts contendo os caminhos absolutos de ' +
        'spritesheet.webp e pet.json. A resposta confirma a conclusão ou informa ' +
        'exatamente o que corrigir.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  const parts: string[] = [];
  if (squad.orchestratorInstructions.trim()) {
    parts.push(squad.orchestratorInstructions.trim());
  }
  if (orientationMarkdown && orientationMarkdown.trim()) {
    parts.push(
      "## Orientação estrutural do repositório (L1 — piloto automático)\n" +
        "O Nexus JÁ leu a codebase e mantém este mapa. Não peça ao usuário " +
        "para explicar a árvore do projeto. Use hubs/imports abaixo; o motor " +
        "também enriquece freeze/worktree com blast radius automaticamente.\n\n" +
        orientationMarkdown.trim(),
    );
  } else {
    parts.push(
      "## Orientação estrutural do repositório (L1 — piloto automático)\n" +
        "Mapa ainda aquecendo. Continue o pipeline: `nexus_context_doctor` " +
        "aquece o mapa, propõe drafts e diz o próximo passo. Não pergunte ao " +
        "usuário o que o repositório contém.",
    );
  }
  parts.push(
    `## Seu squad (${squad.name})\n${rosterBlock(squad.agents) || "(sem workers definidos)"}`,
  );
  const missionLine = missionId
    ? `a missão JÁ ESTÁ registrada e já está em \`running\` (missionId=${missionId}) — ` +
      'NÃO chame nexus_mission_create nem tente alterar o status antes de congelar o contrato; ' +
      '"done" só existe com PREVC completo e receipts imutáveis — NUNCA use nexus_mission_set_status done ' +
      'como atalho (trabalho feito fora do pipeline não é green). Ambiente não pronto / PREVC nunca ' +
      'começou → status=blocked; execução iniciada com erro → status=failed'
    : "nexus_mission_create para abrir a missão";
  parts.push(
    "## Missão e autoridade\n" +
      `Você coordena esta missão com as tools do servidor nexus: ${missionLine}. ` +
      "Se o objetivo já estiver na conversa, execute; pergunte apenas quando ele realmente estiver ausente. " +
      "Não edite o checkout principal. Nunca declare done manualmente sem PREVC completo.",
  );
  const step1 = missionId
    ? '**nexus_context_doctor**'
    : 'nexus_mission_create e **nexus_context_doctor**';
  parts.push(
    "## Pipeline obrigatório (PILOTO AUTOMÁTICO — o usuário NÃO precisa saber as tools)\n" +
      "Você opera o motor Nexus de ponta a ponta. Nunca diga ao usuário para " +
      '"rodar o doctor" ou "mapear o repo" — faça você. Multi-projeto e multi-PC ' +
      "já estão no scope/checkout do token.\n" +
      "### Rota de WIP — não bloqueie em checkout sujo\n" +
      "Se Doctor/freeze informar checkout sujo, NUNCA peça stash/reset/limpeza. " +
      "Registre o plano; o dispatcher main materializa o isolated_worktree declarado " +
      "(ou uma inspeção read_only mecanicamente confinada), preserva o WIP e bloqueia com CTA se não puder " +
      "provar uma execução segura. O coordenador não implementa o trabalho.\n" +
      `1. ${step1}. O doctor É o piloto de bootstrap: ` +
      "aquece o mapa, scaffold, propõe drafts com hashes reais e, se houver quorum " +
      "de outro provider, roda review→apply→commit sozinho (sem auto-aprovação). " +
      "Leia phase/autopilotHint/appliedDraftIds. Se restarem drafts propostos, " +
      "chame nexus_context_doctor novamente; não abra draft_review_run em paralelo. " +
      "Se quorumAvailable=false, peça ao usuário para revisar e aprovar os drafts de contexto na UI " +
      "(a aprovação humana vale como revisão independente) — ou configure outro provider. Nunca invente regra de negócio; ambiguidade sem fonte " +
      "é bloqueio explícito.\n" +
      "2. **nexus_mission_freeze_contract** com objetivo + critérios. Domínios/símbolos " +
      "vazios são preenchidos pelo motor via blast radius do mapa. O piloto PREVC " +
      "avança planning/reviews até execution — use nexus_workflow_get, não simule gates. " +
      "Se qualquer tool reportar `context drifted after freeze`, chame " +
      "**nexus_mission_refreeze_contract** (preserva goal/critérios, re-vincula ao " +
      "contexto atual e o workflow revalida a evidência) e continue — drift não é morte.\n" +
      "3. Proponha o plano inteiro em UMA chamada `nexus_task plan`; cada task exige " +
      "agentRef e category exatos do roster, executionMode (isolated_worktree ou read_only), " +
      "ownership explícito e dependências proporcionais. Depois disso NÃO crie worktree, NÃO chame router, " +
      "NÃO spawne worker e NÃO faça merge: o dispatcher durável do main reivindica a " +
      "task, reserva a rota, materializa o checkout, prova o kickoff e integra o handoff.\n" +
      "4. Acompanhe com `nexus_task list`, `nexus_handoff_list`, workflow e evidências. " +
      "Worker bloqueado vira status blocked + CTA; não abra uma segunda via manual.\n" +
      "5. A integração durável conduz execution → validação → confirmation → complete. " +
      "Recuse mudança não trivial sem sensores verdes. Erro de tool: mostre e tente 1 vez.",
  );
  parts.push(
    "## FALE HUMANO — nunca vaze vocabulário interno\n" +
      "Você conversa com uma pessoa normal, não com um engenheiro do Nexus. " +
      "Os termos abaixo são o SEU encanamento interno — use-os nas tools, " +
      "nunca na conversa. Traduza SEMPRE:\n" +
      '- handoff / nexus_handoff_submit → "o worker me devolveu o resultado" (ou nem mencione)\n' +
      '- spawn / nexus_pane_spawn → "coloquei o especialista para trabalhar"\n' +
      '- pane / sessão → "o terminal dele" (ou nada)\n' +
      '- route_task / adapterId / effort → "escolhi quem faz" (a economia é interna)\n' +
      "- allowlist / gate / token → não mencione — é segurança de bastidor\n" +
      '- worker / orquestrador → "o especialista de X" / "eu"\n' +
      "Fale do RESULTADO e do que falta, em português claro e caloroso, como " +
      "quem explica a um amigo esperto que não programa. Uma mensagem sua com " +
      '"handoff" ou "nexus_pane_write" no meio é uma FALHA de comunicação.',
  );
  parts.push(
    "## Código, contexto vivo e design\n" +
      "Prefira mudanças pequenas, reversíveis e sem abstração especulativa. Se faltarem " +
      "AGENTS.md/CLAUDE.md, inclua um starter baseado no repositório e registre descobertas úteis. " +
      "Em tarefas de UI, leia o DESIGN.md do workspace. Se ele faltar e um sistema externo for " +
      "necessário, use nexus_design_system_search/get/import pelo fluxo de drafts; nunca publique " +
      "com nexus_design_system_publish sem solicitação explícita. Finalize UI com crítica de UX, " +
      "estados hover/focus/empty/error e validação visual. Rejeite o " +
      '"look de IA": sparkles ✨/emoji como ícone, gradiente roxo, ' +
      "glassmorphism default e grids de cards idênticos.",
  );
  parts.push(
    "## Roster é um MENU, não obrigação\n" +
      "Spawne SOMENTE os workers que a missão realmente pede: missão de um " +
      "arquivo não precisa do squad inteiro; missão grande usa todos. QA e " +
      "Security entram antes de finalizar sempre que houver entrega de " +
      "código (QA) ou superfície sensível — auth, pagamentos, rede, dados " +
      "de usuário (Security).",
  );
  return parts.join("\n\n");
}

export interface SquadLaunchResult {
  ok: boolean;
  paneId?: string;
  /** Intent-first: mission armed without an agent pane. */
  armed?: boolean;
  missionId?: string;
  error?: string;
}

export type SquadLaunchProfile = 'standard' | 'pet-studio';

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
   * de outra missão ("Clone Overclock" numa missão de dashboards).
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
    existing.every((pane) => pane.kind === 'shell') ||
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
    squad.agents.find((a) => a.category === "orchestrator") ?? squad.agents[0];
  if (!orchestrator) {
    return { ok: false, error: "Este squad não tem agentes." };
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

  // Intent-first: selecting a squad arms a shell only — zero panes, zero tokens.
  // Pet Studio and explicit legacy/dispatch paths keep the full launch.
  const intentFirst =
    profile !== 'pet-studio' &&
    !options.forceLegacyLaunch &&
    !options.existingMissionId &&
    orchDefaults.intentFirstMissionRuntimeV1 !== false;
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
  const [accounts, quotaSnap] = await Promise.all([
    window.nexus.accounts.list(),
    window.nexus.quota?.snapshot?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  const rosterAdapterId = orchestrator.cli?.trim();
  const configuredAdapterId = options.existingMissionId
    ? rosterAdapterId ||
      (profile === 'pet-studio' ? 'codex' : undefined) ||
      orchDefaults.defaultAdapterId ||
      FALLBACK_ORCHESTRATOR_ADAPTER_ID
    : options.adapterId ||
      (profile === 'pet-studio' ? 'codex' : undefined) ||
      orchDefaults.defaultAdapterId ||
      rosterAdapterId ||
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
  if (!hasOrchestratorMcpRoute(selectedAdapter)) {
    return {
      ok: false,
      error:
        `${selectedAdapter.label} ainda não declara uma rota Nexus MCP verificada ` +
        "para coordenar squads. Escolha um provider compatível nas Configurações.",
    };
  }
  if (!isOrchestratorCapableAdapter(selectedAdapter)) {
    return {
      ok: false,
      error:
        `CLI \`${selectedAdapter.id}\` não está instalada. ` +
        "Instale-a ou escolha outro provider em Configurações › Providers.",
    };
  }

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

  /**
   * Approved intent path: main is the physical launch authority. The renderer
   * sends only missionId, then presents/adopts the sealed pane identity from
   * the response. Provider/model/account/cwd from this function are preflight
   * UX only and never cross the bootstrap IPC boundary.
   */
  if (options.existingMissionId) {
    const { paneMissions, missions } = useOrchStore.getState();
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
    const conflicts = conflictingOrchestratorPanes(cli);
    const killedIds = new Set<string>();
    const displaced = new Set<string>();
    for (const pane of conflicts) {
      const sessionId = getPaneSessionId(pane.id);
      const missionId =
        paneMissions[pane.id] ??
        (sessionId
          ? missions.find(
              (mission) => mission.orchestratorSessionId === sessionId,
            )?.id
          : undefined);
      if (!missionId) {
        return {
          ok: false,
          error:
            'Existe um orquestrador incompatível sem autoridade de missão ' +
            'resolvida. Feche-o explicitamente antes de iniciar outra missão.',
        };
      }
      displaced.add(missionId);
    }
    for (const missionId of displaced) {
      try {
        await window.nexus.orch.updateMission(missionId, {
          status: 'blocked',
        });
      } catch (cause) {
        return {
          ok: false,
          error:
            cause instanceof Error
              ? `O orquestrador anterior não foi encerrado: ${cause.message}`
              : 'O orquestrador anterior não foi encerrado.',
        };
      }
    }
    for (const pane of conflicts) killedIds.add(pane.id);

    let bootstrap: Awaited<
      ReturnType<typeof window.nexus.orch.bootstrapMissionOrchestrator>
    >;
    try {
      bootstrap = await window.nexus.orch.bootstrapMissionOrchestrator({
        missionId: options.existingMissionId,
      });
    } catch (cause) {
      return {
        ok: false,
        error:
          cause instanceof Error
            ? `A missão não foi iniciada: ${cause.message}`
            : 'A missão não foi iniciada pelo processo principal.',
      };
    }
    if (!bootstrap.ok) {
      return {
        ok: false,
        error: `${bootstrap.error} CTA: ${bootstrap.cta}.`,
      };
    }

    const presentation = await presentMainOwnedMissionPane(
      bootstrap.missionId,
      bootstrap.pane,
      { removePaneIds: killedIds },
    );
    if (!presentation.ok) {
      return { ok: false, error: presentation.error };
    }
    const orchPane = presentation.pane;
    if (!bootstrap.kickoff.accepted) {
      useToastStore.getState().push('error', 'Kickoff não foi aceito', {
        detail: bootstrap.kickoff.detail,
        action: {
          label: bootstrap.kickoff.cta,
          onClick: () => {
            useLayoutStore.getState().focus(orchPane.id);
            useOrchStore.getState().openPanel('missions');
          },
        },
      });
    }
    return {
      ok: true,
      paneId: orchPane.id,
      missionId: bootstrap.missionId,
    };
  }

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
      if (!result.accepted) {
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
