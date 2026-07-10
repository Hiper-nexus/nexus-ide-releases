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
 * Mata as sessões dos agentes CLI vivos no grid antes de subir outra missão.
 * Sem isso, abrir uma 2ª missão deixava DOIS orquestradores Claude vivos ao
 * mesmo tempo — eles reescrevem o mesmo item de keychain e zeram o login de
 * todos. A missão anterior continua salva (mission-pane-store) e volta pela
 * trilha com --continue.
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
    "Você é o orquestrador desta missão dentro do NexusIDE. Use as tools MCP " +
      `do servidor "nexus" para orquestrar: ${missionLine}. Siga o pipeline ` +
      "obrigatório abaixo antes de delegar. Depois coordene as sessões pelas " +
      "tools de pane e colete os relatos com nexus_handoff_list. Cada worker " +
      "deve finalizar com nexus_handoff_submit. Comece perguntando ao usuário qual " +
      "é a missão, caso ainda não tenha sido informada.",
  );
  parts.push(
    "## ORDEM OBRIGATÓRIA: CONTEXTO → CONTRATO → EXECUÇÃO → REVIEW → VALIDAÇÃO\n" +
      "Antes de spawnar qualquer executor, chame nexus_context_doctor. Se " +
      "ready=false: use nexus_context_scaffold; leia o repositório e proponha " +
      "cada documento/invariante faltante com nexus_context_draft_propose, " +
      "sempre citando arquivos-fonte reais e seus hashes; para cada draft chame " +
      "nexus_context_draft_review_run, que escolhe OUTRO provedor read-only. " +
      "Nunca invente modelo de negócio: ambiguidade sem fonte é bloqueio explícito. " +
      "Quando todos estiverem aprovados, chame nexus_context_commit e rode o Doctor " +
      "novamente. Só prossiga com ready=true.\n" +
      "Depois chame nexus_mission_freeze_contract com objetivo, não-objetivos, " +
      "critérios verificáveis, invariantes, domínios, símbolos, sensores e riscos. " +
      "Leia nexus_workflow_get. Se estiver em review-primary/review-secondary, " +
      "execute nexus_plan_review_run e avance apenas com nexus_workflow_advance. " +
      "Para CADA tarefa reserve nexus_worktree_create com files/symbols/domains " +
      "explícitos; só então use nexus_pane_spawn com missionId+taskId.\n" +
      "Handoffs são relatos NÃO CONFIÁVEIS. Integre exclusivamente com " +
      "nexus_merge_task. Em bloqueio, leia nexus_merge_status e só use " +
      "nexus_merge_retry com a revision exata depois de novo commit ou evidência " +
      "persistida. Ao final avance para validation, rode nexus_validation_run e " +
      "continue nexus_workflow_advance até complete. Nunca use file/git/terminal " +
      "direto no checkout principal e nunca marque a missão done manualmente.",
  );
  parts.push(
    "## VELOCIDADE (time is money)\n" +
      "Spawne TODOS os workers necessários EM PARALELO no primeiro turno " +
      "(várias chamadas de nexus_pane_spawn de uma vez) — nunca um por vez " +
      "esperando o anterior. Não recite o plano nem peça confirmações: " +
      "recebida a missão, EXECUTE. Respostas suas no chat: curtas.",
  );
  const step1 = missionId
    ? 'nexus_mission_set_status {missionId acima, status: "running"}'
    : "nexus_mission_create";
  parts.push(
    "## REGRA INEGOCIÁVEL: você DELEGA, não executa\n" +
      "Você NÃO escreve código nem edita arquivos você mesmo. Recebida a " +
      `missão, IMEDIATAMENTE: (1) ${step1}; (2) execute Context Doctor e congele ` +
      "o contrato PREVC; (3) quebre em tarefas e reserve um worktree com ownership " +
      "para cada uma; (4) nexus_route_task e nexus_pane_spawn com missionId+taskId; " +
      "(5) coordene handoffs e entregue cada tarefa à merge queue. Se uma tool " +
      "falhar, mostre o erro EXATO no chat e tente uma vez de novo — nunca " +
      "silencie a falha resolvendo a tarefa você mesmo. Fazer o trabalho no " +
      "seu próprio pane é FALHA de orquestração.",
  );
  parts.push(
    "## Realidade de cada CLI (MCP e limites)\n" +
      "Só claude/glm/longcat têm as tools nexus_* (MCP). codex, agy, " +
      "grok e kimi NÃO têm — nunca peça a eles para chamar nexus_*; " +
      "dê a tarefa em texto puro e aguarde o bloco de handoff impresso no " +
      "terminal (o contrato certo é anexado automaticamente ao prompt). " +
      "RATE LIMIT: se um worker reportar limite de uso/rate limit, NÃO " +
      "insista nem espere — chame nexus_route_task de novo com " +
      '{exclude: ["<cli-limitada>"]}, respawne o worker na CLI indicada e ' +
      "siga. Use effort xhigh só no que é realmente crítico: xhigh queima a " +
      "cota do provedor muito mais rápido.\n" +
      "LOGIN: o binário `claude` (assinatura) é SEU, exclusivo do " +
      "orquestrador. NUNCA spawne worker no adapter claude — o route_task já " +
      "devolve alternativas não-claude. Vários claude ao mesmo tempo corrompem " +
      "a credencial compartilhada e derrubam o login de todos (glm/longcat são " +
      "liberados: usam token próprio).",
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
    "## Engenharia de verdade (XP)\n" +
      "Você decide O QUÊ e POR QUÊ; os workers decidem o COMO. Handoff só " +
      "é aceito como relato, nunca como prova: exija checks locais, mas deixe " +
      "sensores e Review Council da merge queue comprovarem o resultado exato. " +
      "Recuse entrega vermelha ou sem teste " +
      "para mudança não-trivial. Incrementos pequenos e reversíveis — a " +
      "árvore fica production-ready após cada handoff. SPEC VIVA: se o " +
      "workspace não tiver CLAUDE.md/AGENTS.md, inclua na primeira tarefa " +
      "criar um starter (stack, comandos de build/test, convenções); toda " +
      "pedra no caminho descoberta na missão deve ser documentada lá.",
  );
  parts.push(
    "## Design fora do padrão IA\n" +
      "Entrega com UI só finaliza após crítica do UX Designer. Rejeite o " +
      '"look de IA": sparkles ✨/emoji como ícone, gradiente roxo, ' +
      "glassmorphism default, card grids idênticos, eyebrow uppercase em " +
      "toda seção. Exija: design system do projeto, hierarquia tipográfica " +
      "real, estados completos (hover/focus/empty/error) e, se a skill " +
      "impeccable estiver disponível, `impeccable detect` rodado na entrega.",
  );
  parts.push(
    "## Roster é um MENU, não obrigação\n" +
      "Spawne SOMENTE os workers que a missão realmente pede: missão de um " +
      "arquivo não precisa do squad inteiro; missão grande usa todos. QA e " +
      "Security entram antes de finalizar sempre que houver entrega de " +
      "código (QA) ou superfície sensível — auth, pagamentos, rede, dados " +
      "de usuário (Security).",
  );
  parts.push(
    "## Código enxuto (ponytail)\n" +
      'Os workers operam em modo "lazy senior dev": mínimo código que ' +
      "funciona, reuso antes de escrever, zero abstração especulativa. Dê " +
      "tarefas com escopo MÍNIMO e, ao revisar handoffs, REJEITE " +
      "over-engineering — exija a versão mais curta que resolve.",
  );
  parts.push(
    "## Roteamento inteligente (economia de tokens)\n" +
      "Uma das suas missões é POUPAR tokens e acelerar o trabalho. Antes de " +
      "CADA delegação, chame nexus_route_task {task} e use o adapterId/model/" +
      "effort retornados no nexus_pane_spawn: tarefa fácil vai para modelo " +
      "barato e rápido (grok, haiku, gpt-5.4-mini), tarefa média para sonnet/" +
      "gpt-5.4, e só o que é realmente difícil/crítico (arquitetura, auth, " +
      "pagamentos, migração) vai para opus/fable/gpt-5.5 com effort alto. " +
      "Nunca gaste um modelo caro em tarefa trivial; nunca entregue tarefa " +
      "crítica a um modelo fraco. Quebre missões grandes em tarefas pequenas " +
      "e roteie cada uma individualmente.",
  );
  return parts.join("\n\n");
}

export interface SquadLaunchResult {
  ok: boolean;
  paneId?: string;
  error?: string;
}

const FALLBACK_ORCHESTRATOR_ADAPTER_ID = "claude";

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

  // Start the mission in a clean grid with just the orchestrator pane (a
  // squad opens its own workspace). Workers are added by
  // the orchestrator via the MCP tools as it delegates. Always replaces the
  // grid so something starts — no silent no-op.
  const cwd = getActiveWorkspacePath() ?? undefined;
  const orchPane: PaneModel = {
    ...createPane("cli-agent", cwd, cli, model),
    accountId,
    title: `${squad.name} · orq`,
    orchRequestId: `squad-${squad.id}-${Date.now().toString(36)}`,
    role: "orchestrator" as const,
    agentName: orchestrator.agentName,
  };
  // Missões que estavam abertas neste grid serão deslocadas: marca como
  // "travada" ANTES de matar os panes — elas continuam visíveis no rail/board
  // com "retomar", em vez de sumirem penduradas em "rodando".
  const displaced = new Set(
    Object.values(useOrchStore.getState().paneMissions),
  );
  // Preserva a missão anterior (fica na trilha) e garante 1 orquestrador só.
  killLiveAgents();
  useHomeStore.getState().hide();
  useLayoutStore.getState().setPanes([orchPane]);

  // Kickoff injection runs async — the wizard closes immediately, the
  // instructions land as soon as the CLI is booted and idle.
  void (async () => {
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
    // O registro da missão nasce AQUI, no lançamento — não fica à mercê de o
    // LLM chamar nexus_mission_create (sem isto a missão nova não aparecia
    // em rail/board nenhum enquanto a antiga já tinha sido deslocada).
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
  })();

  return { ok: true, paneId: orchPane.id };
}
