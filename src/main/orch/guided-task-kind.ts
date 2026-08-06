import type { AgentCategory } from "../../shared/orch-types";

export const GUIDED_MISSION_PLANNER_TASK_ID = "guided-execution";
export const GUIDED_MISSION_QA_TASK_ID = "guided-quality-gate";
/** Canonical identities of the bug-shaped stages (at most one of each). */
export const GUIDED_MISSION_REPRODUCTION_TASK_ID = "guided-reproduction";
export const GUIDED_MISSION_REGRESSION_TASK_ID = "guided-regression";

export const GUIDED_TASK_DOMAINS = Object.freeze({
  advisory: "guided-advisory",
  independentReview: "guided-independent-review",
  isolatedAdvisory: "guided-isolated-advisory",
  implementation: "guided-implementation",
  /**
   * Implementação do CAMINHO SIMPLES: escreve no próprio checkout
   * (`same_checkout`), sem worktree isolada.
   *
   * Kind PRÓPRIO de propósito, e não um `implementation` com condicional. Um
   * receipt `implementation` afirma isolamento por worktree; reusá-lo para
   * same_checkout mudaria retroativamente o que os receipts ANTIGOS
   * significam — corromperia proveniência. Aqui a taxonomia diz a verdade: um
   * auditor distingue "worktree isolada, diff contra o próprio branch" de
   * "mesmo checkout, atribuído por ownership" sem adivinhar.
   */
  simpleImplementation: "guided-simple-implementation",
  qualityGate: "guided-quality-gate",
  /**
   * Work-kind shaped stages (see guided-mission-work-graph). They exist only
   * on a `bug` graph and are deliberately read_only: a defect repair is
   * single-writer by nature, so proving the defect and proving the regression
   * never open a second mutation surface.
   */
  reproduction: "guided-reproduction",
  regression: "guided-regression",
  /**
   * Read-only reviewer/QA warm-up: prepares its checklist while the executor
   * implements wave 1. Roots by construction (dependsOn empty, no consumers,
   * empty ownership), so they never open a second mutation surface.
   */
  warmup: "guided-warmup",
} as const);

export type GuidedTaskKind =
  | "advisory"
  | "independent-review"
  | "isolated-advisory"
  | "implementation"
  | "simple-implementation"
  | "quality-gate"
  | "reproduction"
  | "regression"
  | "warmup";

type GuidedWorkerCategory = Exclude<AgentCategory, "orchestrator">;

export interface GuidedTaskKindInput {
  /**
   * The immutable planner identity is present at seal/receipt boundaries.
   * Schedule-only callers may omit it only when they use the result to add a
   * safety fence (for example, requiring PREVC), never to grant completion.
   */
  readonly plannerId?: string;
  readonly agentCategory?: GuidedWorkerCategory;
  readonly executionMode?:
    | "isolated_worktree"
    | "read_only"
    | "same_checkout";
  readonly domains: readonly string[];
  readonly label?: string;
}

const GUIDED_DOMAIN_SET = new Set<string>(Object.values(GUIDED_TASK_DOMAINS));

function invalidGuidedTask(input: GuidedTaskKindInput, detail: string): never {
  const label = input.label?.trim();
  throw new Error(
    `guided_task_kind_invalid${label ? ` (${label})` : ""}: ${detail}`,
  );
}

export function hasGuidedTaskDomain(domains: readonly string[]): boolean {
  return domains.some((domain) => GUIDED_DOMAIN_SET.has(domain));
}

/**
 * Canonical, fail-closed interpretation of the authority-bearing Guided
 * schedule strings. A non-Guided schedule returns null. Once any Guided
 * marker is present, the full category/mode/sequential contract must match.
 */
export function parseGuidedTaskKind(
  input: GuidedTaskKindInput,
): GuidedTaskKind | null {
  const guidedDomains = input.domains.filter((domain) =>
    GUIDED_DOMAIN_SET.has(domain),
  );
  if (guidedDomains.length === 0) {
    if (
      input.plannerId === GUIDED_MISSION_PLANNER_TASK_ID ||
      input.plannerId === GUIDED_MISSION_QA_TASK_ID ||
      input.plannerId === GUIDED_MISSION_REPRODUCTION_TASK_ID ||
      input.plannerId === GUIDED_MISSION_REGRESSION_TASK_ID
    ) {
      invalidGuidedTask(
        input,
        "identidade canônica sem o domínio Guided correspondente",
      );
    }
    return null;
  }
  if (guidedDomains.length !== 1) {
    invalidGuidedTask(input, "a tarefa deve possuir um único domínio Guided");
  }
  // sequential-only is an optional exclusivity fence (glue / empty / isolated
  // advisory), not a required marker on every Guided kind.
  if (!input.agentCategory || !input.executionMode) {
    invalidGuidedTask(
      input,
      "categoria e modo de execução selados são obrigatórios",
    );
  }

  const domain = guidedDomains[0]!;
  let kind: GuidedTaskKind;
  switch (domain) {
    case GUIDED_TASK_DOMAINS.advisory:
      if (
        input.executionMode !== "read_only" ||
        input.agentCategory === "reviewer"
      ) {
        invalidGuidedTask(
          input,
          "advisory exige executor/scout/architect em read_only",
        );
      }
      kind = "advisory";
      break;
    case GUIDED_TASK_DOMAINS.independentReview:
      if (
        input.executionMode !== "read_only" ||
        input.agentCategory !== "reviewer"
      ) {
        invalidGuidedTask(
          input,
          "revisão independente exige reviewer em read_only",
        );
      }
      kind = "independent-review";
      break;
    case GUIDED_TASK_DOMAINS.isolatedAdvisory:
      if (input.executionMode !== "isolated_worktree") {
        invalidGuidedTask(
          input,
          "advisory isolado exige isolated_worktree",
        );
      }
      kind = "isolated-advisory";
      break;
    case GUIDED_TASK_DOMAINS.reproduction:
      if (input.executionMode !== "read_only") {
        invalidGuidedTask(
          input,
          "reprodução exige read_only (a correção de bug é single-writer)",
        );
      }
      kind = "reproduction";
      break;
    case GUIDED_TASK_DOMAINS.regression:
      if (input.executionMode !== "read_only") {
        invalidGuidedTask(
          input,
          "regressão exige read_only (a correção de bug é single-writer)",
        );
      }
      kind = "regression";
      break;
    case GUIDED_TASK_DOMAINS.warmup:
      if (
        input.executionMode !== "read_only" ||
        input.agentCategory !== "reviewer"
      ) {
        invalidGuidedTask(
          input,
          "warm-up exige reviewer/QA em read_only",
        );
      }
      kind = "warmup";
      break;
    case GUIDED_TASK_DOMAINS.simpleImplementation:
      if (
        input.executionMode !== "same_checkout" ||
        input.agentCategory !== "executor"
      ) {
        invalidGuidedTask(
          input,
          "implementação simples exige executor em same_checkout",
        );
      }
      kind = "simple-implementation";
      break;
    case GUIDED_TASK_DOMAINS.implementation:
      if (
        input.executionMode !== "isolated_worktree" ||
        input.agentCategory !== "executor"
      ) {
        invalidGuidedTask(
          input,
          "implementação exige executor em isolated_worktree",
        );
      }
      kind = "implementation";
      break;
    case GUIDED_TASK_DOMAINS.qualityGate:
      if (
        (input.executionMode !== "isolated_worktree" &&
          input.executionMode !== "read_only") ||
        input.agentCategory !== "reviewer"
      ) {
        invalidGuidedTask(
          input,
          "quality gate exige reviewer em isolated_worktree ou read_only",
        );
      }
      kind = "quality-gate";
      break;
    default:
      return invalidGuidedTask(input, `domínio Guided desconhecido: ${domain}`);
  }

  const canonicalIdentities: readonly (readonly [string, GuidedTaskKind])[] = [
    [GUIDED_MISSION_PLANNER_TASK_ID, "implementation"],
    [GUIDED_MISSION_QA_TASK_ID, "quality-gate"],
    [GUIDED_MISSION_REPRODUCTION_TASK_ID, "reproduction"],
    [GUIDED_MISSION_REGRESSION_TASK_ID, "regression"],
  ];
  // Wave Pack seals N implementation roots (`wave-pack-story-*`) plus an
  // optional `wave-pack-quality-gate`. Those planner ids are Pack topology
  // authority, not the single Guided v2 canonical pair.
  const isWavePackPlannerId =
    typeof input.plannerId === "string" &&
    input.plannerId.startsWith("wave-pack-");
  if (
    !isWavePackPlannerId &&
    canonicalIdentities.some(
      ([plannerId, canonicalKind]) =>
        (input.plannerId === plannerId && kind !== canonicalKind) ||
        (kind === canonicalKind &&
          input.plannerId !== undefined &&
          input.plannerId !== plannerId),
    )
  ) {
    invalidGuidedTask(
      input,
      "plannerId e identidade Guided canônica não correspondem",
    );
  }
  return kind;
}

export function isGuidedDeliveryTaskKind(
  kind: GuidedTaskKind | null,
): boolean {
  return (
    kind === "isolated-advisory" ||
    kind === "implementation" ||
    kind === "quality-gate"
  );
}

export function hasGuidedDeliveryTaskDomain(
  domains: readonly string[],
): boolean {
  return domains.some(
    (domain) =>
      domain === GUIDED_TASK_DOMAINS.isolatedAdvisory ||
      domain === GUIDED_TASK_DOMAINS.implementation ||
      domain === GUIDED_TASK_DOMAINS.qualityGate,
  );
}
