import type { Squad } from "./orch-types";

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
export const REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION = 7;

export const REAL_MISSION_E2E_CHANNELS = Object.freeze({
  run: "real-mission-e2e:run",
  prepareProductWizard: "real-mission-e2e:prepare-product-wizard",
  prepareFixture: "real-mission-e2e:prepare-fixture",
  observe: "real-mission-e2e:observe",
});
export const REAL_MISSION_E2E_PRODUCT_WIZARD_READY_EVENT =
  "nexus:real-mission-product-wizard-ready";
export const REAL_MISSION_E2E_PRODUCT_WIZARD_READY_STORAGE_KEY =
  "nexus.real-mission.product-wizard-ready";

/**
 * The `agentic-` prefix is product authority, not decoration: it makes the
 * fixture enter the same deterministic Guided Planner used by beginner
 * missions. A harness-only plan is deliberately impossible in schema v7.
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
]);

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
  "O plano de produção já contém três ondas sequenciais: e2e-executor, e2e-reviewer e e2e-qa. NÃO replaneje.",
  "Não spawne workers manualmente: o scheduler durável do main reserva cada rota e abre cada PTY.",
  "O executor precisa criar e commitar o artefato e enviar o primeiro handoff pela tool Nexus.",
  "O revisor precisa validar o HEAD já integrado e enviar o segundo handoff sem mudança artificial.",
  "O QA precisa consumir o handoff do revisor e enviar o terceiro handoff sem mudança artificial.",
  "Se os handoffs chegarem na UI, apenas acompanhe — não force done via nexus_mission_update.",
  "Integração, receipts e status done pertencem ao motor Nexus.",
].join("\n");

export function createRealMissionE2ESquadFixture(): Squad {
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
        cli: "codex",
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
    ],
  };
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
 * but before approval can synchronously start the main-owned bootstrap.
 */
export function isRealMissionE2EPreApprovalMission(
  mission: RealMissionE2EObservationMission | null | undefined,
): mission is RealMissionE2EObservationMission {
  const contract = mission?.intentContract;
  const criteria = contract?.acceptanceCriteria;
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
    criteria.length === REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.length &&
    criteria.every(
      (criterion, index) =>
        criterion === REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[index],
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
