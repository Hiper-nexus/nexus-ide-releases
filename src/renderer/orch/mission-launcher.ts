import type { AdapterInfo, PaneModel } from "../../shared/types";
import type { Squad, SquadAgent } from "../../shared/orch-types";
import { useLayoutStore } from "../state/layout-store";
import { useHomeStore } from "../state/home-store";
import { useOrchStore } from "../state/orch-store";
import { listPanes, createPane } from "../lib/split-tree";
import { getActiveWorkspacePath } from "../state/active-workspace";
import { getPaneSessionId, waitForSession } from "../terminal/terminal-host";
import {
  hasOrchestratorMcpRoute,
  isOrchestratorCapableAdapter,
  resolveOrchestratorRuntime,
} from "./orchestrator-runtime";
import {
  conflictingOrchestratorPanes,
  killConflictingOrchestrators,
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
const BOOT_IDLE_TIMEOUT_MS = 15_000;
const PASTE_SETTLE_MS = 250;

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

/** Resolve on the CLI's first idle (booted, waiting for input) or timeout. */
function waitFirstIdle(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsub();
      resolve();
    };
    const unsub = window.nexus.pty.onStateChange(sessionId, (state) => {
      if (state === "idle") finish();
    });
    setTimeout(finish, BOOT_IDLE_TIMEOUT_MS);
  });
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

export function buildMissionKickoffPrompt(squad: Squad, missionId?: string): string {
  const parts: string[] = [];
  if (squad.orchestratorInstructions.trim()) {
    parts.push(squad.orchestratorInstructions.trim());
  }
  parts.push(
    `## Seu squad (${squad.name})\n${rosterBlock(squad.agents) || "(sem workers definidos)"}`,
  );
  const missionLine = missionId
    ? `a missão JÁ ESTÁ registrada (missionId=${missionId}) — NÃO chame ` +
      "nexus_mission_create; use nexus_mission_set_status para movê-la " +
      '(running ao começar; "done" será calculado pelo PREVC, nunca declarado por você)'
    : "nexus_mission_create para abrir a missão";
  parts.push(
    "## Missão e autoridade\n" +
      `Você coordena esta missão com as tools do servidor nexus: ${missionLine}. ` +
      "Se o objetivo já estiver na conversa, execute; pergunte apenas quando ele realmente estiver ausente. " +
      "Não edite o checkout principal nem declare a missão done manualmente.",
  );
  const step1 = missionId
    ? 'nexus_mission_set_status {missionId acima, status: "running"}'
    : "nexus_mission_create";
  parts.push(
    "## Pipeline obrigatório: contexto → contrato → execução → review → validação\n" +
      `1. Comece com ${step1} e nexus_context_doctor. Se ready=false, use ` +
      "nexus_context_scaffold, fundamente drafts em arquivos e hashes reais, rode " +
      "nexus_context_draft_review_run com outro provedor e finalize com nexus_context_commit. " +
      "Nunca invente regra de negócio; ambiguidade sem fonte é bloqueio explícito.\n" +
      "2. Congele objetivo, não-objetivos, critérios verificáveis, invariantes, domínios, " +
      "símbolos, sensores e riscos com nexus_mission_freeze_contract. O piloto automático " +
      "do Nexus conduz planning/reviews até execution; consulte nexus_workflow_get, não tente " +
      "simular ou pular transições.\n" +
      "3. Quebre apenas o necessário e registre TODAS as tarefas primeiro com nexus_task create; " +
      "o plano é selado no primeiro worktree. Para cada tarefa retornada, reserve ownership explícito com " +
      "nexus_worktree_create; então chame nexus_route_task e use exatamente o adapterId, " +
      "model e effort retornados em nexus_pane_spawn. O catálogo e as capacidades em runtime " +
      "são a fonte de verdade — nunca use listas lembradas ou suposições estáticas sobre CLIs. " +
      "Inicie tarefas independentes em paralelo. Em rate limit, roteie novamente excluindo o provedor afetado.\n" +
      "4. Cada especialista deve devolver nexus_handoff_submit. Handoffs são relatos NÃO CONFIÁVEIS: " +
      "integre apenas por nexus_merge_task e com testes/evidências. Em bloqueio, consulte " +
      "nexus_merge_status e só use nexus_merge_retry com a revision exata após nova evidência.\n" +
      "5. O último nexus_merge_task conduz automaticamente execution → validações → confirmation → complete " +
      "quando todas as tarefas planejadas estiverem integradas. Recuse mudança não trivial sem testes verdes. " +
      "Se uma tool falhar, mostre o erro exato e tente uma vez novamente.",
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
  error?: string;
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
): Promise<SquadLaunchResult> {
  const orchestrator =
    squad.agents.find((a) => a.category === "orchestrator") ?? squad.agents[0];
  if (!orchestrator) {
    return { ok: false, error: "Este squad não tem agentes." };
  }

  const [orchDefaults, accounts] = await Promise.all([
    window.nexus.settings.orchGet(),
    window.nexus.accounts.list(),
  ]);
  const configuredAdapterId =
    orchDefaults.defaultAdapterId || FALLBACK_ORCHESTRATOR_ADAPTER_ID;
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
  const runtime = resolveOrchestratorRuntime({
    adapterId: cli,
    squadModel: orchestrator.cli === cli ? orchestrator.model : undefined,
    defaultModel: orchDefaults.defaultModel,
    defaultAccountId: orchDefaults.defaultAccountId,
    accounts,
  });
  const { model, accountId } = runtime;

  // Squad opens with orchestrator pane. Workers are added via MCP as it
  // delegates. Multi-mission: when the new orch does not share exclusive
  // login (Claude keychain), keep other live panes — no blanket kill.
  const cwd = getActiveWorkspacePath() ?? undefined;
  const launchKey = `${cwd ?? ""}\u0000${squad.id}`;
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
    orchRequestId: `squad-${squad.id}-${Date.now().toString(36)}`,
    role: "orchestrator" as const,
    agentName: orchestrator.agentName,
  };
  squadLaunchesInFlight.set(launchKey, orchPane.id);
  const { paneMissions, missions } = useOrchStore.getState();
  const existing = listPanes(useLayoutStore.getState().root);
  const conflicts = conflictingOrchestratorPanes(cli);
  const killedIds = new Set(
    conflicts.length > 0 ? killConflictingOrchestrators(cli) : [],
  );
  // Only mark missions blocked when we actually tore down their orch.
  const displaced = new Set<string>();
  for (const pane of conflicts) {
    const sessionId = getPaneSessionId(pane.id);
    const mid =
      paneMissions[pane.id] ??
      (sessionId
        ? missions.find((mission) => mission.orchestratorSessionId === sessionId)?.id
        : undefined);
    if (mid) displaced.add(mid);
  }

  useHomeStore.getState().hide();
  useLayoutStore.getState().setPanes(
    panesAfterSquadLaunch(existing, killedIds, orchPane),
  );

  // Kickoff injection runs async — the wizard closes immediately, the
  // instructions land as soon as the CLI is booted and idle.
  void (async () => {
    try {
      for (const missionId of displaced) {
        await window.nexus.orch
          .updateMission(missionId, { status: "blocked" })
          .catch(() => {}); // missão já removida — nada a marcar
      }
      // Mission creation is an authority transition. Wait until the main
      // process owns the concrete PTY session and the pane mirror has received
      // its sessionId; payload-only panes are intentionally rejected.
      const sessionId = await waitForSession(orchPane.id);
      if (!sessionId) return;
      const mission = await window.nexus.orch
        .createMission({
          title: squad.name,
          squadId: squad.id,
          orchestratorPane: {
            paneId: orchPane.id,
            adapterId: cli,
            model,
            accountId,
            cwd,
            title: orchPane.title,
            agentName: orchestrator.agentName,
          },
        })
        .catch(() => null);
      if (mission) {
        useOrchStore.getState().bindPaneMission(orchPane.id, mission.id);
      }
      await waitFirstIdle(sessionId);
      const prompt = buildMissionKickoffPrompt(squad, mission?.id);
      // Bracketed paste keeps multi-line playbooks from submitting line-by-line.
      window.nexus.pty.write(sessionId, `\x1b[200~${prompt}\x1b[201~`);
      setTimeout(() => window.nexus.pty.write(sessionId, "\r"), PASTE_SETTLE_MS);
    } finally {
      squadLaunchesInFlight.delete(launchKey);
    }
  })();

  return { ok: true, paneId: orchPane.id };
}
