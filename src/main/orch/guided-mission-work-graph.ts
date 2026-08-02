import { isDocumentWritablePath } from "../../shared/mission-intent";
import {
  decideDesignAuthority,
  type DesignAuthorityDecision,
  type WorkKind,
  type WorkKindVerdict,
} from "../../shared/mission-work-kind";

/**
 * Work-kind graph policy for the Guided delivery plan.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now every standard-lane mission produced the SAME sealed graph:
 * N advisors (parallel) → 1 implementation (isolated worktree) → N independent
 * reviews (serial) → 1 quality gate. "Corrigir o bug do login" and "criar a
 * tela de billing" were byte-for-byte identical missions. This module is the
 * single place where the goal's work kind is allowed to change the SHAPE of
 * that graph, so the planner stays a mechanical assembler.
 *
 * WHAT MAY AND MAY NOT CHANGE
 * ---------------------------
 * Only role assignment and edges change. Cardinality does not: the sealed
 * receipt still carries exactly one task per approved roster worker, exactly
 * one implementation and exactly one quality gate. A `bug` graph does not add
 * bodies — it RE-ROLES bodies that would otherwise have been a generic advisor
 * or a generic independent review. That is what keeps
 * `assertRosterCompleteGuidedV2Receipt` able to recover the graph from the
 * immutable receipt after a restart, without ever re-reading the goal text.
 *
 * `unknown` is NEVER a guess. It maps to the exact same shape as `feature`:
 * today's generic path. A wrong shape is strictly worse than the generic one.
 */

export type GuidedWorkGraphStage =
  | "reproduction"
  | "advisory"
  | "implementation"
  | "regression"
  | "independent-review"
  | "quality-gate";

/** Minimal identity contract: the module never reads more than the id. */
export interface GuidedWorkGraphAgent {
  readonly id: string;
}

export interface GuidedWorkGraphShape<
  TAgent extends GuidedWorkGraphAgent = GuidedWorkGraphAgent,
> {
  readonly workKind: WorkKind;
  readonly verdict: WorkKindVerdict;
  /**
   * Read-only agent that must prove the defect BEFORE the executor writes.
   * Null when the roster has no spare read-only body — the reproduction
   * obligation then moves into the implementation contract text instead of
   * being silently dropped (see `reproductionInContractOnly`).
   */
  readonly reproduction: TAgent | null;
  /** Read-only agent that verifies the durable regression check after the fix. */
  readonly regression: TAgent | null;
  /** Generic tip advisors (parallel roots), after re-roling. */
  readonly advisors: readonly TAgent[];
  /** Independent reviewers of the integrated HEAD, after re-roling. */
  readonly reviewers: readonly TAgent[];
  /** True when the roster could not supply a body for that stage. */
  readonly reproductionInContractOnly: boolean;
  readonly regressionInContractOnly: boolean;
  readonly reason: string;
}

export interface GuidedWorkGraphInput<
  TAgent extends GuidedWorkGraphAgent = GuidedWorkGraphAgent,
> {
  readonly goal: string;
  /** executor/scout/architect identities that are not the primary executor. */
  readonly advisors: readonly TAgent[];
  /** reviewer identities that are not the corrective quality gate. */
  readonly reviewers: readonly TAgent[];
  /**
   * True when this identity can hold a mechanically read-only lane. The bug
   * stages are read_only by construction, so an agent that would have to run
   * in an isolated worktree can never take one: that would open a second
   * mutation surface on a single-writer repair.
   */
  readonly isReadOnlyCapable: (agent: TAgent) => boolean;
}

/**
 * THE CONFIDENCE CHECK — the other end of the design-contract policy.
 *
 * `workKind` is not a label here: the planner feeds it straight into
 * `buildGuidedMissionTaskDetail`, and `visual` there means the executor is
 * ordered to "send handoff blocked with `design_contract_missing`" whenever no
 * design contract exists. Publishing `visual` therefore CREATES AN OBLIGATION,
 * and an obligation only exists honestly if the pilot that materializes the
 * contract would have acted on the same goal.
 *
 * It did not. `buildDesignContractBootstrap` writes a contract only when
 * `decideDesignAuthority` says yes; this function used to publish `visual` off
 * `verdict.kind` alone, confidence ignored. Measured consequence: `"trocar a
 * cor do botão de aprovar"` → `visual`/`low` → NO contract created and a worker
 * instructed to block for the lack of one. A deadlock on the most trivial task
 * in the product.
 *
 * So both ends now call the SAME predicate. When it refuses, the graph falls
 * back to `unknown` — which this module already documents as the honest
 * generic path ("a wrong shape is strictly worse than the generic one") — and
 * the full verdict travels on `shape.verdict` so nothing about the
 * classification is hidden from the UI or the logs.
 *
 * Only `visual` is gated here, deliberately: `bug` and `doc` clauses are
 * satisfiable by the executor alone (reproduce, regress, write the document),
 * so a weak verdict there costs shape, not liveness. `visual` is the only kind
 * whose clause demands an authority that lives OUTSIDE the mission.
 */
function publishedWorkKind(authority: DesignAuthorityDecision): WorkKind {
  const kind = authority.verdict.kind;
  if (kind === "visual") return authority.required ? "visual" : "unknown";
  // `doc` é a segunda forma cujo veredito fraco custa LIVENESS, não só forma:
  // ele não adiciona uma cláusula que o executor satisfaz — ele aplica a cerca
  // de ownership (`documentOwnershipFence`), que torna o código FISICAMENTE
  // inalcançável. Medido: "criar a feature e escrever o PRD" classifica
  // `doc`/`low` (o PRD vence por precedência), e a metade "criar a feature"
  // fica impossível de entregar dentro da própria missão que a pediu.
  //
  // Restrição irreversível exige veredito forte. Em confiança baixa o grafo
  // publica `unknown` — o caminho genérico, que entrega as duas metades — e o
  // veredito completo continua viajando em `shape.verdict` para quem quiser
  // explicar a decisão.
  if (kind === "doc" && authority.verdict.confidence !== "high") return "unknown";
  return kind;
}

function shape<TAgent extends GuidedWorkGraphAgent>(
  input: Omit<GuidedWorkGraphShape<TAgent>, "workKind" | "verdict"> & {
    readonly verdict: WorkKindVerdict;
    readonly workKind: WorkKind;
  },
): GuidedWorkGraphShape<TAgent> {
  return Object.freeze({
    workKind: input.workKind,
    verdict: input.verdict,
    reproduction: input.reproduction,
    regression: input.regression,
    advisors: Object.freeze([...input.advisors]),
    reviewers: Object.freeze([...input.reviewers]),
    reproductionInContractOnly: input.reproductionInContractOnly,
    regressionInContractOnly: input.regressionInContractOnly,
    reason: input.reason,
  });
}

function genericShape<TAgent extends GuidedWorkGraphAgent>(
  verdict: WorkKindVerdict,
  workKind: WorkKind,
  input: GuidedWorkGraphInput<TAgent>,
  reason: string,
): GuidedWorkGraphShape<TAgent> {
  return shape({
    verdict,
    workKind,
    reproduction: null,
    regression: null,
    advisors: input.advisors,
    reviewers: input.reviewers,
    reproductionInContractOnly: false,
    regressionInContractOnly: false,
    reason,
  });
}

/**
 * Decide the graph shape for one approved goal.
 *
 * bug     — a reproduction root gates the implementation, and a regression
 *           verification runs on the integrated HEAD before the reviews. Both
 *           are read_only: the fix itself stays single-writer.
 * doc     — generic shape; the difference is the ownership fence, not the
 *           graph (see `documentOwnershipFence`).
 * visual  — generic shape; the difference is the delivery contract (design
 *           contract required before the first CSS), not the graph. Published
 *           ONLY when `decideDesignAuthority` also grants the contract; see
 *           `publishedWorkKind`.
 * feature — generic shape, unchanged.
 * ops     — generic shape, unchanged.
 * unknown — generic shape, explicitly and by design.
 */
export function planGuidedWorkGraph<TAgent extends GuidedWorkGraphAgent>(
  input: GuidedWorkGraphInput<TAgent>,
): GuidedWorkGraphShape<TAgent> {
  const authority = decideDesignAuthority(input.goal);
  const verdict = authority.verdict;
  const workKind = publishedWorkKind(authority);
  if (workKind !== "bug") {
    return genericShape(
      verdict,
      workKind,
      input,
      workKind === verdict.kind
        ? `${workKind}: grafo genérico (advisors → implementação → revisões → gate).`
        : `${verdict.kind} sem autoridade de design (${authority.refusal}): ` +
          "grafo genérico e SEM cláusula de contrato de design — a mesma régua " +
          "que impede o piloto de criar o contrato impede a tarefa de exigi-lo. " +
          verdict.reason,
    );
  }

  // Reproduction prefers an advisor body: taking a reviewer for it would cost
  // the graph one independent review of the integrated HEAD, which is the more
  // expensive loss.
  const advisorPool = input.advisors.filter(input.isReadOnlyCapable);
  const reviewerPool = input.reviewers.filter(input.isReadOnlyCapable);
  const takenIds = new Set<string>();
  const take = (
    ...pools: readonly (readonly TAgent[])[]
  ): TAgent | null => {
    for (const pool of pools) {
      const found = pool.find((agent) => !takenIds.has(agent.id));
      if (found) {
        takenIds.add(found.id);
        return found;
      }
    }
    return null;
  };

  const reproduction = take(advisorPool, reviewerPool);
  const regression = take(reviewerPool, advisorPool);
  const remaining = (agents: readonly TAgent[]): readonly TAgent[] =>
    agents.filter((agent) => !takenIds.has(agent.id));

  const reproductionInContractOnly = reproduction === null;
  const regressionInContractOnly = regression === null;
  const stages = [
    reproduction
      ? `reprodução=${reproduction.id}`
      : "reprodução=somente no contrato (roster sem corpo read-only livre)",
    regression
      ? `regressão=${regression.id}`
      : "regressão=somente no contrato (roster sem corpo read-only livre)",
  ].join("; ");
  return shape({
    verdict,
    workKind,
    reproduction,
    regression,
    advisors: remaining(input.advisors),
    reviewers: remaining(input.reviewers),
    reproductionInContractOnly,
    regressionInContractOnly,
    reason: `bug: grafo com reprodução antes e regressão depois da correção (${stages}).`,
  });
}

/**
 * Documentation surface a doc mission always owns, even in a repository that
 * has no docs yet. Without it, "escreva o ADR" in a repo with no `docs/` would
 * seal an empty ownership and die at the worktree contract — the mission would
 * be punished for the very gap it exists to close.
 */
export const GUIDED_DOCUMENT_DEFAULT_SURFACE = ["docs"] as const;

/**
 * Narrow the mutation ownership of a `doc` mission to the documentation
 * surface. A doc mission must not be able to touch code at all — the same
 * guarantee the plan lane gets from PLAN_LANE_WRITABLE_PATHS, generalized to
 * any documentation artifact.
 *
 * The result is always non-empty and always narrower than the input: every
 * surviving entry satisfies `isDocumentWritablePath`, so the ownership diff
 * enforcement in the worktree contract mechanically rejects a code change.
 */
export function documentOwnershipFence(
  ownershipFiles: readonly string[],
): readonly string[] {
  const fenced = new Set(ownershipFiles.filter(isDocumentWritablePath));
  for (const surface of GUIDED_DOCUMENT_DEFAULT_SURFACE) fenced.add(surface);
  return Object.freeze(
    [...fenced].sort((left, right) => left.localeCompare(right)),
  );
}
