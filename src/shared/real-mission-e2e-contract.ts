import type { Squad } from "./orch-types";
import { isAdvisoryUnconfinedCli } from "./mission-advisory";
import { defaultSquadModelForAdapter } from "./squad-model-defaults";

/**
 * Both release-gate modes are command-line-only. The private flag drives the
 * engine diagnostic; the UI flag prepares only an isolated workspace and then
 * waits for the operator/Computer Use to cross the real MissionWizard.
 */
export const REAL_MISSION_E2E_FLAG = "--nexus-real-mission-e2e";
export const REAL_MISSION_E2E_PRODUCT_WIZARD_FLAG =
  "--nexus-real-mission-product-wizard-e2e";
// Must cover executor work + merge-council wait (20 min in real-mission).
// The outer release-candidate harness allows 32 min; keep headroom below that.
export const REAL_MISSION_E2E_TIMEOUT_MS = 30 * 60_000;
export const REAL_MISSION_E2E_EVIDENCE_FILE = "real-mission-evidence.json";
export const REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_EVIDENCE_FILE =
  "real-mission-evidence-claude-orchestrator.json";
export const REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION = 9;
export const REAL_MISSION_E2E_BUNDLE_ID = "com.nexuside.app";

export const REAL_MISSION_E2E_CHANNELS = Object.freeze({
  run: "real-mission-e2e:run",
  prepareProductWizard: "real-mission-e2e:prepare-product-wizard",
  prepareFixture: "real-mission-e2e:prepare-fixture",
  observe: "real-mission-e2e:observe",
  beginProductWizardGesture:
    "real-mission-e2e:begin-product-wizard-gesture",
  recordProductWizardStep: "real-mission-e2e:record-product-wizard-step",
});
export const REAL_MISSION_E2E_PRODUCT_WIZARD_READY_EVENT =
  "nexus:real-mission-product-wizard-ready";
export const REAL_MISSION_E2E_PRODUCT_WIZARD_READY_STORAGE_KEY =
  "nexus.real-mission.product-wizard-ready";
export const REAL_MISSION_E2E_PRODUCT_WIZARD_ACTIVE_STORAGE_KEY =
  "nexus.real-mission.product-wizard-active";
export const REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_MESSAGE =
  "nexus:real-mission-product-wizard-step";
export const REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_RESULT_MESSAGE =
  "nexus:real-mission-product-wizard-step-result";

/**
 * The `agentic-` prefix is product authority, not decoration: it makes the
 * fixture enter the same deterministic Guided Planner used by beginner
 * missions. A harness-only plan is deliberately impossible in schema v9.
 */
export const REAL_MISSION_E2E_SQUAD_ID = "agentic-nexus-real-mission-e2e";
export const REAL_MISSION_E2E_ORCHESTRATOR_ID = "e2e-orchestrator";
export const REAL_MISSION_E2E_ORCHESTRATOR_NAME = "E2E Orquestrador";
export const REAL_MISSION_E2E_EXECUTOR_ID = "e2e-executor";
export const REAL_MISSION_E2E_EXECUTOR_NAME = "E2E Executor";
export const REAL_MISSION_E2E_REVIEWER_ID = "e2e-reviewer";
export const REAL_MISSION_E2E_REVIEWER_NAME = "E2E Revisor";
export const REAL_MISSION_E2E_QA_ID = "e2e-qa";
export const REAL_MISSION_E2E_QA_NAME = "E2E QA";
export const REAL_MISSION_E2E_RESULT_FILE = "resultado.txt";
export const REAL_MISSION_E2E_RESULT_CONTENT = "nexus-real-mission-e2e-ok\n";
export const REAL_MISSION_E2E_CTA =
  "Abra o relatório de evidências, corrija o estado bloqueado e execute novamente antes da release.";

/**
 * Multi-CLI advisory lane do harness (Fase 2): toda CLI advisor entra SOMENTE
 * em tarefa read_only independente do fan-out consultivo — nunca como writer
 * nem como reviewer PREVC. O pipeline executor → revisor → QA continua
 * codex-only. A ordem canônica abaixo também ordena o DAG e a evidência.
 */
export type RealMissionE2EAdvisorCli =
  | "grok"
  | "kimi"
  | "agy"
  | "opencode"
  | "claude"
  | "glm";

export interface RealMissionE2EAdvisorSpec {
  readonly id: string;
  readonly name: string;
  readonly cli: RealMissionE2EAdvisorCli;
  readonly category: "scout";
}

export const REAL_MISSION_E2E_ADVISORS: readonly RealMissionE2EAdvisorSpec[] =
  Object.freeze([
    {
      id: "e2e-advisor-grok",
      name: "E2E Advisor Grok",
      cli: "grok",
      category: "scout",
    },
    {
      id: "e2e-advisor-kimi",
      name: "E2E Advisor Kimi",
      cli: "kimi",
      category: "scout",
    },
    {
      id: "e2e-advisor-agy",
      name: "E2E Advisor Agy",
      cli: "agy",
      category: "scout",
    },
    {
      id: "e2e-advisor-opencode",
      name: "E2E Advisor OpenCode",
      cli: "opencode",
      category: "scout",
    },
    {
      id: "e2e-advisor-claude",
      name: "E2E Advisor Claude",
      cli: "claude",
      category: "scout",
    },
    // GLM reuses the Claude Code binary pointed at z.ai (ANTHROPIC_* env).
    // Distinct adapter id + API key — not Claude OAuth — so reserveClaude
    // does not apply; advisory-unconfined + Nexus Seatbelt.
    {
      id: "e2e-advisor-glm",
      name: "E2E Advisor GLM",
      cli: "glm",
      category: "scout",
    },
  ]);

export type RealMissionE2EAdvisorTier =
  | "mechanically-confined"
  | "advisory-unconfined";

/**
 * Tier de confinamento registrado na evidência. grok tem Seatbelt
 * `--sandbox read-only` enforceável (MECHANICALLY_READ_ONLY_CLIS em
 * mission-scheduler-plan.ts) e claude é confinado nativamente pelo argv
 * governado (requiresReadOnlyNativeAuthority em autonomous-cli-policy.ts);
 * kimi/agy/opencode/glm têm apenas a fronteira MCP + Seatbelt Nexus.
 */
export function realMissionE2EAdvisorTier(
  cli: RealMissionE2EAdvisorCli,
): RealMissionE2EAdvisorTier {
  return isAdvisoryUnconfinedCli(cli)
    ? "advisory-unconfined"
    : "mechanically-confined";
}

/**
 * Advisors sem credencial materializável são excluídos do roster pelo launcher
 * via esta env (lista de clis separada por vírgula). O main lê a mesma env ao
 * persistir o fixture e ao observar, então fixture, plano e evidência sempre
 * concordam sobre o conjunto esperado.
 */
export const REAL_MISSION_E2E_ADVISOR_SKIP_ENV =
  "NEXUS_REAL_MISSION_ADVISOR_SKIP";

export function realMissionE2EAdvisorSkipClis(
  environment: Readonly<Record<string, string | undefined>> = typeof process !==
  "undefined"
    ? process.env
    : {},
): RealMissionE2EAdvisorCli[] {
  const raw = environment[REAL_MISSION_E2E_ADVISOR_SKIP_ENV];
  if (!raw) return [];
  const requested = new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  return REAL_MISSION_E2E_ADVISORS.filter((advisor) =>
    requested.has(advisor.cli),
  ).map((advisor) => advisor.cli);
}

/**
 * Variante de orquestrador do harness: codex (default) ou claude. Claude é
 * orquestrador-capaz (VERIFIED_ORCHESTRATOR_BUILTINS) e o gate prova as duas
 * variantes contra o mesmo ZIP/commit. Qualquer valor fora do estrito cai no
 * default codex — o launcher valida com regex própria antes de propagar.
 */
export type RealMissionE2EOrchestratorCli = "codex" | "claude";

export const REAL_MISSION_E2E_ORCHESTRATOR_ENV =
  "NEXUS_REAL_MISSION_ORCHESTRATOR";

export function realMissionE2EOrchestratorCli(
  environment: Readonly<Record<string, string | undefined>> = typeof process !==
  "undefined"
    ? process.env
    : {},
): RealMissionE2EOrchestratorCli {
  return environment[REAL_MISSION_E2E_ORCHESTRATOR_ENV] === "claude"
    ? "claude"
    : "codex";
}
export const REAL_MISSION_E2E_GOAL =
  'Entregue resultado.txt com o conteúdo exato "nexus-real-mission-e2e-ok\\n". ' +
  "Na cadeia de entrega executor → revisor → QA, o executor deve implementar e " +
  "enviar seu handoff; depois o revisor independente valida o HEAD integrado e " +
  "envia seu próprio handoff; por fim o QA consome essa revisão, valida o HEAD e " +
  "envia seu próprio handoff. Handoffs da lane advisor são independentes dessa " +
  "cadeia. O QA não deve editar, alterar ou escrever arquivos nem criar mudança artificial. " +
  "O orquestrador não pode editar nem commitar o arquivo.";

const REAL_MISSION_E2E_DELIVERY_ACCEPTANCE_CRITERIA = Object.freeze([
  "O executor Codex do roster cria resultado.txt no próprio workspace (caminho simples, sem worktree isolada) — nunca o orquestrador nem o processo main.",
  "resultado.txt contém exatamente nexus-real-mission-e2e-ok seguido de newline.",
  "O próprio executor faz o commit local e chama nexus_handoff_submit; sessão e encarnação conferem com o dispatch do executor.",
  "O motor Nexus integra o commit antes de liberar a tarefa dependente do revisor.",
  "O revisor Codex da cadeia de entrega abre seu próprio PTY físico, valida o HEAD integrado e chama nexus_handoff_submit sem commit vazio nem alteração cosmética.",
  "O motor Nexus emite para o revisor um receipt Main-owned de validação sem mudança — read_only_validated, same_checkout_validated ou worktree_validated_no_change conforme a rota — antes de liberar a tarefa dependente de QA; o QA consome o handoff predecessor sem precisar reconstruir esse receipt.",
  "O QA Codex da cadeia de entrega abre seu próprio PTY físico, consome o handoff do revisor e valida o HEAD integrado; o QA não deve editar, alterar ou escrever arquivos e chama nexus_handoff_submit sem mudança artificial.",
  "Depois do handoff do QA, o motor Nexus emite o receipt final Main-owned de validação sem mudança — read_only_validated, same_checkout_validated ou worktree_validated_no_change conforme a rota — e marca a missão done sem atalho manual; esta é prova Main-owned futura e sua ausência antes do handoff não bloqueia o QA.",
]);

function normalizedAdmittedAdvisorClis(
  orchestratorCli: RealMissionE2EOrchestratorCli,
  admittedAdvisorClis: readonly string[],
): RealMissionE2EAdvisorCli[] {
  const admitted = new Set(admittedAdvisorClis);
  return REAL_MISSION_E2E_ADVISORS.filter(
    (advisor) =>
      admitted.has(advisor.cli) &&
      !(orchestratorCli === "claude" && advisor.cli === "claude"),
  ).map((advisor) => advisor.cli);
}

function defaultAdmittedAdvisorClis(
  orchestratorCli: RealMissionE2EOrchestratorCli,
): RealMissionE2EAdvisorCli[] {
  const skipped = new Set(realMissionE2EAdvisorSkipClis());
  return normalizedAdmittedAdvisorClis(
    orchestratorCli,
    REAL_MISSION_E2E_ADVISORS.filter(
      (advisor) => !skipped.has(advisor.cli),
    ).map((advisor) => advisor.cli),
  );
}

function advisorAcceptanceCriterion(
  admittedAdvisorClis: readonly RealMissionE2EAdvisorCli[],
): string {
  if (admittedAdvisorClis.length === 0) {
    return "Nenhuma CLI advisor foi admitida no roster desta missão; nenhuma tarefa, pane ou handoff da lane guided-advisory é exigida.";
  }
  return (
    "As CLIs realmente admitidas no roster desta missão e na lane guided-advisory " +
    `são exatamente: ${admittedAdvisorClis.join(", ")}. Cada uma abre PTY físico, ` +
    "chama ao menos uma tool nexus_* e conclui sua própria tarefa com " +
    "nexus_handoff_submit; esses handoffs advisor são independentes da cadeia de " +
    "entrega executor → revisor → QA. A evidência Main-owned registra participação " +
    "e tier somente dessas CLIs."
  );
}

const REAL_MISSION_E2E_PREVC_REVIEW_CRITERION =
  "Cada reviewer PREVC automático usa um processo separado das tarefas advisor e nexus_merge_review_submit como sinal exclusivo de conclusão; sua submissão não ocupa posição na cadeia de entrega executor → revisor → QA.";

function buildRealMissionE2EAcceptanceCriteria(
  orchestratorCli: RealMissionE2EOrchestratorCli,
  admittedAdvisorClis: readonly string[],
): readonly string[] {
  const criteria = [
    ...REAL_MISSION_E2E_DELIVERY_ACCEPTANCE_CRITERIA,
    advisorAcceptanceCriterion(
      normalizedAdmittedAdvisorClis(orchestratorCli, admittedAdvisorClis),
    ),
    REAL_MISSION_E2E_PREVC_REVIEW_CRITERION,
  ];
  if (orchestratorCli === "claude") {
    criteria.push(REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_CRITERION);
  }
  return Object.freeze(criteria);
}

const ALL_ADVISOR_CLIS = REAL_MISSION_E2E_ADVISORS.map(
  (advisor) => advisor.cli,
);
export const REAL_MISSION_E2E_ACCEPTANCE_CRITERIA =
  buildRealMissionE2EAcceptanceCriteria("codex", ALL_ADVISOR_CLIS);

/**
 * Critério extra da variante orquestrador Claude: a missão inteira corre sob
 * UM único processo Claude (o orquestrador — reserveClaude), com o pipeline
 * executor→revisor→QA codex e as advisors não-Claude.
 */
export const REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_CRITERION =
  "A variante orquestrador Claude executa o ciclo completo (kickoff→dispatch→handoffs→integração→done) com o pipeline codex e advisors não-Claude, sem segundo processo Claude.";

export const REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA =
  buildRealMissionE2EAcceptanceCriteria("claude", ALL_ADVISOR_CLIS);

export function realMissionE2EAcceptanceCriteria(
  orchestratorCli: RealMissionE2EOrchestratorCli,
  admittedAdvisorClis: readonly string[] = defaultAdmittedAdvisorClis(
    orchestratorCli,
  ),
): readonly string[] {
  const normalized = normalizedAdmittedAdvisorClis(
    orchestratorCli,
    admittedAdvisorClis,
  );
  const canonical =
    orchestratorCli === "claude"
      ? ALL_ADVISOR_CLIS.filter((cli) => cli !== "claude")
      : ALL_ADVISOR_CLIS;
  if (
    normalized.length === canonical.length &&
    normalized.every((cli, index) => cli === canonical[index])
  ) {
    return orchestratorCli === "claude"
      ? REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA
      : REAL_MISSION_E2E_ACCEPTANCE_CRITERIA;
  }
  return buildRealMissionE2EAcceptanceCriteria(
    orchestratorCli,
    normalized,
  );
}

/**
 * The real beginner wizard intentionally submits only the operator-authored
 * objective. Its ordinary synchronous compiler derives this single criterion;
 * unlike the private diagnostic, the UI route must not inject hidden criteria.
 */
export const REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA =
  Object.freeze([
    `Objetivo concluído conforme: ${REAL_MISSION_E2E_GOAL}`,
  ]);

export const REAL_MISSION_E2E_ORCHESTRATOR_INSTRUCTIONS = [
  "# Release gate E2E real",
  "Você é somente o orquestrador de UI. É PROIBIDO criar, editar, adicionar ou commitar resultado.txt.",
  "No Nexus, o Guided Planner, dispatch e integração pertencem ao main; a CLI acompanha e recebe os handoffs.",
  "O plano de produção já contém a lane guided-advisory read_only e independente para cada advisor admitido, além da cadeia sequencial codex e2e-executor → e2e-reviewer → e2e-qa. NÃO replaneje.",
  "Não spawne workers manualmente: o scheduler durável do main reserva cada rota e abre cada PTY.",
  "Cada advisor admitido conclui sua tarefa independente com nexus_handoff_submit depois de chamar ao menos uma tool Nexus.",
  "Reviewers PREVC automáticos são processos separados e concluem exclusivamente com nexus_merge_review_submit.",
  "O executor precisa criar e commitar o artefato e enviar seu handoff de entrega pela tool Nexus.",
  "O revisor da cadeia de entrega precisa validar o HEAD já integrado e enviar seu próprio handoff sem mudança artificial.",
  "O QA precisa consumir o handoff do revisor e enviar seu próprio handoff sem mudança artificial.",
  "Se os handoffs chegarem na UI, apenas acompanhe — não force done via nexus_mission_update.",
  "É PROIBIDO usar nexus_mission_set_status com blocked ou failed neste gate: o motor Nexus conduz a missão até done; demover status aborta a prova de release.",
  "Integração, receipts e status done pertencem ao motor Nexus.",
].join("\n");

/**
 * Build a roster agent whose JSON key order matches production
 * `squadSchema.parse` + `withAllowlists` (model defaults applied, model field
 * immediately after `cli`). Hash equality is byte-exact on JSON.stringify.
 */
function fixtureAgent(input: {
  id: string;
  agentName: string;
  category: "orchestrator" | "executor" | "reviewer" | "scout";
  cli: string;
  effort?: string;
  allowedSkills?: string[];
  allowedTools?: string[] | null;
  model?: string;
}): {
  id: string;
  agentName: string;
  category: "orchestrator" | "executor" | "reviewer" | "scout";
  cli: string;
  model?: string;
  effort?: string;
  allowedSkills?: string[];
  allowedTools?: string[] | null;
} {
  const model =
    input.model?.trim() || defaultSquadModelForAdapter(input.cli) || undefined;
  return {
    id: input.id,
    agentName: input.agentName,
    category: input.category,
    cli: input.cli,
    ...(model ? { model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.allowedSkills !== undefined
      ? { allowedSkills: input.allowedSkills }
      : {}),
    ...(input.allowedTools !== undefined
      ? { allowedTools: input.allowedTools }
      : {}),
  };
}

export function createRealMissionE2ESquadFixture(
  skipAdvisorClis: readonly string[] = [],
  orchestratorCli: RealMissionE2EOrchestratorCli = "codex",
): Squad {
  const skipped = new Set(skipAdvisorClis);
  // reserveClaude: na variante orquestrador Claude ele é o ÚNICO processo
  // Claude da missão — a advisor claude nunca entra no roster.
  if (orchestratorCli === "claude") skipped.add("claude");
  return {
    id: REAL_MISSION_E2E_SQUAD_ID,
    name: "Nexus real mission release gate",
    createdAt: "real-mission-e2e-v1",
    builtin: false,
    orchestratorInstructions: REAL_MISSION_E2E_ORCHESTRATOR_INSTRUCTIONS,
    agents: [
      fixtureAgent({
        id: REAL_MISSION_E2E_ORCHESTRATOR_ID,
        agentName: REAL_MISSION_E2E_ORCHESTRATOR_NAME,
        category: "orchestrator",
        cli: orchestratorCli,
        // Medium keeps the physical observer responsive. The production
        // Guided Planner seals the task graph before this CLI is spawned.
        effort: "medium",
        allowedSkills: [],
        allowedTools: null,
      }),
      fixtureAgent({
        id: REAL_MISSION_E2E_EXECUTOR_ID,
        agentName: REAL_MISSION_E2E_EXECUTOR_NAME,
        category: "executor",
        cli: "codex",
        effort: "medium",
        allowedSkills: [],
        allowedTools: [],
      }),
      fixtureAgent({
        id: REAL_MISSION_E2E_REVIEWER_ID,
        agentName: REAL_MISSION_E2E_REVIEWER_NAME,
        category: "reviewer",
        cli: "codex",
        effort: "medium",
        allowedSkills: [],
        allowedTools: [],
      }),
      fixtureAgent({
        id: REAL_MISSION_E2E_QA_ID,
        agentName: REAL_MISSION_E2E_QA_NAME,
        category: "reviewer",
        cli: "codex",
        effort: "medium",
        allowedSkills: [],
        allowedTools: [],
      }),
      // Advisors multi-CLI: o Guided Planner os leva para tarefas read_only
      // independentes do fan-out consultivo.
      // O model default (grok/agy/codex) fica explícito porque a persistência
      // de produção o injetaria — o fixture precisa fechar o hash no round-trip.
      ...REAL_MISSION_E2E_ADVISORS.filter(
        (advisor) => !skipped.has(advisor.cli),
      ).map((advisor) =>
        fixtureAgent({
          id: advisor.id,
          agentName: advisor.name,
          category: advisor.category,
          cli: advisor.cli,
          effort: "medium",
          allowedSkills: [],
          allowedTools: [],
        }),
      ),
    ],
  };
}

/**
 * Um membro do DAG selado pelo Guided Planner para o roster do harness:
 * advisors e executor são raízes do primeiro fan-out; a cadeia de entrega
 * codex começa no executor, passa pelo revisor e termina no QA.
 */
export interface RealMissionE2EChainMember {
  readonly agentRef: string;
  readonly agentName: string;
  readonly cli: string;
  readonly agentCategory: "executor" | "reviewer" | "scout";
  readonly plannerId: string;
  readonly executionMode: "isolated_worktree" | "read_only" | "same_checkout";
  readonly kind: "advisory" | "execution" | "review" | "quality-gate";
  /** Planner ids exatos que precisam ter o handoff consumido antes do spawn. */
  readonly dependsOnPlannerIds: readonly string[];
}

/**
 * DAG exato de tarefas para o conjunto de advisors presentes (não-skipped).
 * Os plannerIds reproduzem guidedFanoutPlannerId: advisors e executor não têm
 * dependências e ficam elegíveis juntos; o revisor codex depende do executor
 * e o QA depende desse revisor.
 */
export function realMissionE2EExpectedTaskChain(
  presentAdvisorClis: readonly string[],
): RealMissionE2EChainMember[] {
  const present = new Set(presentAdvisorClis);
  const advisors = REAL_MISSION_E2E_ADVISORS.filter((advisor) =>
    present.has(advisor.cli),
  );
  const reviewers: readonly {
    readonly id: string;
    readonly name: string;
    readonly cli: string;
  }[] = [
    {
      id: REAL_MISSION_E2E_REVIEWER_ID,
      name: REAL_MISSION_E2E_REVIEWER_NAME,
      cli: "codex",
    },
  ];
  const advisoryMembers: RealMissionE2EChainMember[] = advisors.map(
    (advisor, index) => ({
      agentRef: advisor.id,
      agentName: advisor.name,
      cli: advisor.cli,
      agentCategory: "scout" as const,
      plannerId: `guided-advisory-${index + 1}-${advisor.id}`,
      executionMode: "read_only" as const,
      kind: "advisory" as const,
      dependsOnPlannerIds: [],
    }),
  );
  const executionMember: RealMissionE2EChainMember = {
    agentRef: REAL_MISSION_E2E_EXECUTOR_ID,
    agentName: REAL_MISSION_E2E_EXECUTOR_NAME,
    cli: "codex",
    agentCategory: "executor",
    plannerId: "guided-execution",
    // 0.27.0: a entrega comum roda no PRÓPRIO checkout (caminho simples).
    // O gate prova a nova garantia, não a antiga.
    executionMode: "same_checkout",
    kind: "execution",
    dependsOnPlannerIds: [],
  };
  const reviewMembers: RealMissionE2EChainMember[] = reviewers.map(
    (reviewer, index) => ({
      agentRef: reviewer.id,
      agentName: reviewer.name,
      cli: reviewer.cli,
      agentCategory: "reviewer" as const,
      plannerId: `guided-review-${index + 1}-${reviewer.id}`,
      executionMode: "read_only" as const,
      kind: "review" as const,
      dependsOnPlannerIds: [
        index === 0
          ? executionMember.plannerId
          : `guided-review-${index}-${reviewers[index - 1]!.id}`,
      ],
    }),
  );
  const qualityDependency =
    reviewMembers.at(-1)?.plannerId ?? executionMember.plannerId;
  return [
    ...advisoryMembers,
    executionMember,
    ...reviewMembers,
    {
      agentRef: REAL_MISSION_E2E_QA_ID,
      agentName: REAL_MISSION_E2E_QA_NAME,
      cli: "codex",
      agentCategory: "reviewer" as const,
      plannerId: "guided-quality-gate",
      executionMode: "read_only" as const,
      kind: "quality-gate" as const,
      dependsOnPlannerIds: [qualityDependency],
    },
  ];
}

interface RealMissionE2EObservationMission {
  readonly status?: string;
  readonly intentState?: string;
  readonly intentVersion?: number;
  readonly squadId?: string;
  readonly orchestratorSessionId?: string | null;
  readonly intentContract?: {
    readonly version?: number;
    readonly source?: string;
    readonly goal?: string;
    readonly acceptanceCriteria?: readonly string[];
    readonly executionMode?: string;
    readonly lane?: string;
    readonly contextPolicy?: string;
    readonly approvedAt?: number;
    readonly dispatchedAt?: number;
    readonly intentVersion?: number;
    readonly squadRevisionHash?: string;
    readonly orchestratorRuntime?: unknown;
  } | null;
}

/**
 * The observer must be installed after the exact fixture intent is compiled
 * but before approval can synchronously start the main-owned bootstrap. A
 * variante de orquestrador vem da env do processo (default codex).
 */
export function isRealMissionE2EPreApprovalMission(
  mission: RealMissionE2EObservationMission | null | undefined,
  orchestratorCli: RealMissionE2EOrchestratorCli = realMissionE2EOrchestratorCli(),
): mission is RealMissionE2EObservationMission {
  const contract = mission?.intentContract;
  const criteria = contract?.acceptanceCriteria;
  const acceptanceCriteria = realMissionE2EAcceptanceCriteria(orchestratorCli);
  return (
    mission?.status === "pending" &&
    // 0.27.0: zero fricção — nenhuma missão estaciona em awaiting_approval.
    mission.intentState === "ready_to_start" &&
    Number.isInteger(mission.intentVersion) &&
    (mission.intentVersion ?? 0) > 0 &&
    mission.squadId === REAL_MISSION_E2E_SQUAD_ID &&
    mission.orchestratorSessionId == null &&
    contract?.version === 1 &&
    contract.source === "typed" &&
    contract.goal === REAL_MISSION_E2E_GOAL &&
    contract.executionMode === "autopilot" &&
    contract.lane === "standard" &&
    contract.contextPolicy === "minimal" &&
    contract.intentVersion === mission.intentVersion &&
    contract.approvedAt === undefined &&
    contract.dispatchedAt === undefined &&
    contract.squadRevisionHash === undefined &&
    contract.orchestratorRuntime === undefined &&
    Array.isArray(criteria) &&
    criteria.length === acceptanceCriteria.length &&
    criteria.every(
      (criterion, index) => criterion === acceptanceCriteria[index],
    )
  );
}

export type RealMissionE2ELaunchSurface =
  | "private-runner"
  | "product-wizard";

export function realMissionE2ELaunchSurface(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): RealMissionE2ELaunchSurface | null {
  const privateRequested =
    argv.includes(REAL_MISSION_E2E_FLAG) ||
    environment.NEXUS_REAL_MISSION_E2E === "1";
  const productWizardRequested =
    argv.includes(REAL_MISSION_E2E_PRODUCT_WIZARD_FLAG) ||
    environment.NEXUS_REAL_MISSION_PRODUCT_WIZARD_E2E === "1";
  if (privateRequested === productWizardRequested) return null;
  return productWizardRequested ? "product-wizard" : "private-runner";
}

export function isRealMissionE2E(argv: readonly string[]): boolean {
  return realMissionE2ELaunchSurface(argv) !== null;
}

export function isExclusiveRealMissionE2E(
  argv: readonly string[],
  incompatibleArguments: readonly string[] = [
    "--smoke-test",
    "nexus-smoke-test",
  ],
): boolean {
  const flagCount = argv.filter(
    (value) =>
      value === REAL_MISSION_E2E_FLAG ||
      value === REAL_MISSION_E2E_PRODUCT_WIZARD_FLAG,
  ).length;
  return (
    flagCount === 1 &&
    incompatibleArguments.every((value) => !argv.includes(value))
  );
}

/**
 * Live process check — do not freeze at module load. Packaged Electron may
 * reorder argv around `--`, and the release gate also sets an env marker.
 */
export function isCurrentProcessRealMissionE2E(): boolean {
  return realMissionE2ELaunchSurface(process.argv, process.env) !== null;
}

export function isCurrentProcessRealMissionProductWizardE2E(): boolean {
  return (
    realMissionE2ELaunchSurface(process.argv, process.env) ===
    "product-wizard"
  );
}
