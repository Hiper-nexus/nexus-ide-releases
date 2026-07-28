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
export const REAL_MISSION_E2E_TIMEOUT_MS = 15 * 60_000;
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
 * Multi-CLI advisory lane do harness (Fase 2): advisors entram SOMENTE em
 * tarefas read_only do fan-out consultivo do Guided Planner — nunca como
 * writers. O pipeline executor → revisor → QA continua codex-only.
 * A ordem canônica é autoridade: scouts antes do executor, reviewers advisor
 * depois do revisor codex e antes do QA.
 */
export type RealMissionE2EAdvisorCli =
  | "grok"
  | "kimi"
  | "agy"
  | "opencode"
  | "omp"
  | "claude";

export interface RealMissionE2EAdvisorSpec {
  readonly id: string;
  readonly name: string;
  readonly cli: RealMissionE2EAdvisorCli;
  readonly category: "reviewer" | "scout";
}

export const REAL_MISSION_E2E_ADVISORS: readonly RealMissionE2EAdvisorSpec[] =
  Object.freeze([
    {
      id: "e2e-advisor-grok",
      name: "E2E Advisor Grok",
      cli: "grok",
      category: "reviewer",
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
      id: "e2e-advisor-omp",
      name: "E2E Advisor OMP",
      cli: "omp",
      category: "scout",
    },
    {
      id: "e2e-advisor-claude",
      name: "E2E Advisor Claude",
      cli: "claude",
      category: "reviewer",
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
 * kimi/agy/opencode/omp têm apenas a fronteira MCP read-only.
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
  "O executor deve implementar e enviar seu handoff; depois um revisor independente " +
  "deve validar o HEAD integrado e enviar seu handoff; por fim o QA deve validar a " +
  "revisão integrada e enviar o terceiro handoff. O QA não deve editar, alterar ou " +
  "escrever arquivos nem criar mudança artificial. " +
  "O orquestrador não pode editar nem commitar o arquivo.";

export const REAL_MISSION_E2E_ACCEPTANCE_CRITERIA = Object.freeze([
  "O executor Codex do roster cria resultado.txt no próprio worktree — nunca o orquestrador nem o processo main.",
  "resultado.txt contém exatamente nexus-real-mission-e2e-ok seguido de newline.",
  "O próprio executor faz o commit local e chama nexus_handoff_submit; sessão e encarnação conferem com o primeiro dispatch.",
  "O motor Nexus integra o commit antes de liberar a tarefa dependente do revisor.",
  "O revisor Codex abre um segundo PTY físico, valida o HEAD integrado e chama nexus_handoff_submit sem commit vazio nem alteração cosmética.",
  "O motor Nexus emite worktree_validated_no_change para o revisor antes de liberar a tarefa dependente de QA.",
  "O QA Codex abre um terceiro PTY físico, consome o handoff do revisor e valida o HEAD integrado; o QA não deve editar, alterar ou escrever arquivos e chama nexus_handoff_submit sem mudança artificial.",
  "O motor Nexus emite o receipt final worktree_validated_no_change e marca a missão done sem atalho manual.",
  "Cada CLI advisor credenciada (grok, kimi, agy, opencode, omp, claude) abre PTY físico, chama ao menos uma tool nexus_* e submete nexus_handoff_submit; a evidência registra o tier de confinamento de cada uma.",
]);

/**
 * Critério extra da variante orquestrador Claude: a missão inteira corre sob
 * UM único processo Claude (o orquestrador — reserveClaude), com o pipeline
 * executor→revisor→QA codex e as advisors não-Claude.
 */
export const REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_CRITERION =
  "A variante orquestrador Claude executa o ciclo completo (kickoff→dispatch→handoffs→integração→done) com o pipeline codex e advisors não-Claude, sem segundo processo Claude.";

export const REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA =
  Object.freeze([
    ...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
    REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_CRITERION,
  ]);

export function realMissionE2EAcceptanceCriteria(
  orchestratorCli: RealMissionE2EOrchestratorCli,
): readonly string[] {
  return orchestratorCli === "claude"
    ? REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA
    : REAL_MISSION_E2E_ACCEPTANCE_CRITERIA;
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
  "O plano de produção já contém o fan-out consultivo read_only dos advisors e as três ondas sequenciais codex: e2e-executor, e2e-reviewer e e2e-qa. NÃO replaneje.",
  "Não spawne workers manualmente: o scheduler durável do main reserva cada rota e abre cada PTY.",
  "O executor precisa criar e commitar o artefato e enviar o primeiro handoff pela tool Nexus.",
  "O revisor precisa validar o HEAD já integrado e enviar o segundo handoff sem mudança artificial.",
  "O QA precisa consumir o handoff do revisor e enviar o terceiro handoff sem mudança artificial.",
  "Se os handoffs chegarem na UI, apenas acompanhe — não force done via nexus_mission_update.",
  "Integração, receipts e status done pertencem ao motor Nexus.",
].join("\n");

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
      {
        id: REAL_MISSION_E2E_ORCHESTRATOR_ID,
        agentName: REAL_MISSION_E2E_ORCHESTRATOR_NAME,
        category: "orchestrator",
        cli: orchestratorCli,
        // Medium keeps the physical observer responsive. The production
        // Guided Planner seals the task graph before this CLI is spawned.
        effort: "medium",
        allowedSkills: [],
        allowedTools: null,
      },
      {
        id: REAL_MISSION_E2E_EXECUTOR_ID,
        agentName: REAL_MISSION_E2E_EXECUTOR_NAME,
        category: "executor",
        cli: "codex",
        effort: "medium",
        allowedSkills: [],
        allowedTools: [],
      },
      {
        id: REAL_MISSION_E2E_REVIEWER_ID,
        agentName: REAL_MISSION_E2E_REVIEWER_NAME,
        category: "reviewer",
        cli: "codex",
        effort: "medium",
        allowedSkills: [],
        allowedTools: [],
      },
      {
        id: REAL_MISSION_E2E_QA_ID,
        agentName: REAL_MISSION_E2E_QA_NAME,
        category: "reviewer",
        cli: "codex",
        effort: "medium",
        allowedSkills: [],
        allowedTools: [],
      },
      // Advisors multi-CLI: o Guided Planner os leva para tarefas read_only do
      // fan-out consultivo (scouts antes do executor, reviewers antes do QA).
      // O model default (grok/agy) fica explícito porque a persistência de
      // produção o injeteria — o fixture precisa fechar o hash no round-trip.
      ...REAL_MISSION_E2E_ADVISORS.filter(
        (advisor) => !skipped.has(advisor.cli),
      ).map((advisor) => {
        const model = defaultSquadModelForAdapter(advisor.cli);
        return {
          id: advisor.id,
          agentName: advisor.name,
          category: advisor.category,
          cli: advisor.cli,
          ...(model ? { model } : {}),
          effort: "medium",
          allowedSkills: [],
          allowedTools: [],
        };
      }),
    ],
  };
}

/**
 * Um membro da cadeia linear selada pelo Guided Planner para o roster do
 * harness: scouts advisor → executor codex → revisor codex → reviewers
 * advisor → QA codex. Cada membro depende exatamente do anterior.
 */
export interface RealMissionE2EChainMember {
  readonly agentRef: string;
  readonly agentName: string;
  readonly cli: string;
  readonly agentCategory: "executor" | "reviewer" | "scout";
  readonly plannerId: string;
  readonly executionMode: "isolated_worktree" | "read_only";
  readonly kind: "advisory" | "execution" | "review" | "quality-gate";
}

/**
 * Cadeia exata de tarefas para o conjunto de advisors presentes (não-skipped).
 * Os plannerIds reproduzem guidedFanoutPlannerId: os ids do roster já são
 * slugs estáveis e os índices são a posição do membro no seu grupo do fan-out
 * (advisory 1-based entre os scouts presentes; review 1-based começando no
 * revisor codex).
 */
export function realMissionE2EExpectedTaskChain(
  presentAdvisorClis: readonly string[],
): RealMissionE2EChainMember[] {
  const present = new Set(presentAdvisorClis);
  const scouts = REAL_MISSION_E2E_ADVISORS.filter(
    (advisor) => advisor.category === "scout" && present.has(advisor.cli),
  );
  const reviewAdvisors = REAL_MISSION_E2E_ADVISORS.filter(
    (advisor) => advisor.category === "reviewer" && present.has(advisor.cli),
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
    ...reviewAdvisors,
  ];
  return [
    ...scouts.map((advisor, index) => ({
      agentRef: advisor.id,
      agentName: advisor.name,
      cli: advisor.cli,
      agentCategory: "scout" as const,
      plannerId: `guided-advisory-${index + 1}-${advisor.id}`,
      executionMode: "read_only" as const,
      kind: "advisory" as const,
    })),
    {
      agentRef: REAL_MISSION_E2E_EXECUTOR_ID,
      agentName: REAL_MISSION_E2E_EXECUTOR_NAME,
      cli: "codex",
      agentCategory: "executor" as const,
      plannerId: "guided-execution",
      executionMode: "isolated_worktree" as const,
      kind: "execution" as const,
    },
    ...reviewers.map((reviewer, index) => ({
      agentRef: reviewer.id,
      agentName: reviewer.name,
      cli: reviewer.cli,
      agentCategory: "reviewer" as const,
      plannerId: `guided-review-${index + 1}-${reviewer.id}`,
      executionMode: "read_only" as const,
      kind: "review" as const,
    })),
    {
      agentRef: REAL_MISSION_E2E_QA_ID,
      agentName: REAL_MISSION_E2E_QA_NAME,
      cli: "codex",
      agentCategory: "reviewer" as const,
      plannerId: "guided-quality-gate",
      executionMode: "read_only" as const,
      kind: "quality-gate" as const,
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
    (mission.intentState === "ready_to_start" ||
      mission.intentState === "awaiting_approval") &&
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
