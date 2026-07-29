import type { GuidedTaskKind } from "./guided-task-kind";
import type { TaskProviderWaiverHitKind } from "./task-dispatch-codec";

/**
 * Política pura de falha de provider sem rota de failover: decide se a task
 * selada pode ser dispensada (waiver), se deve seguir o caminho limitado de
 * retry/failover ou se é estruturalmente inelegível. O Main re-prova a mesma
 * decisão dentro da transação do store e na autoridade de conclusão da missão,
 * então a decisão permanece auditável e testável isoladamente.
 *
 * Regras do product owner:
 * 1. Somente kinds Guided `advisory`/`isolated-advisory` podem ser dispensados.
 * 2. Executor/implementation, independent-review, quality-gate e tasks não
 *    guiadas NUNCA recebem waiver.
 * 5. A task advisory precisa ser RAIZ (sem dependsOn) e sem consumidores no
 *    plano selado — dispensar um produtor quebra o consumidor planejado.
 * Somente hits de janela curta (rate-limit/auth/transient) são elegíveis;
 * `quota` é uma janela de uso longa e segue a espera-pela-irmã.
 */

export type ProviderFailureTaskDecision =
  | { readonly decision: "waive" }
  | {
      readonly decision: "retry-required";
      readonly reason: string;
    }
  | {
      readonly decision: "not-eligible";
      readonly reason: string;
    };

export interface ProviderFailureTaskPolicyInput {
  /** Kind Guided selado (null = task não guiada). */
  readonly guidedTaskKind: GuidedTaskKind | null;
  /** Dependências seladas da própria task (raiz exige lista vazia). */
  readonly dependsOn: readonly string[];
  /** Tasks planejadas cujo dependsOn selado consome esta task. */
  readonly consumers: readonly string[];
  readonly hitKind: TaskProviderWaiverHitKind;
}

const WAIVABLE_HIT_KINDS = new Set<TaskProviderWaiverHitKind>([
  "rate-limit",
  "auth",
  "transient",
]);

export function decideProviderFailureTaskPolicy(
  input: ProviderFailureTaskPolicyInput,
): ProviderFailureTaskDecision {
  const advisory =
    input.guidedTaskKind === "advisory" ||
    input.guidedTaskKind === "isolated-advisory";
  if (!advisory) {
    return {
      decision: "retry-required",
      reason:
        `task ${input.guidedTaskKind ?? "não guiada"} nunca é elegível a ` +
        "waiver de provider; segue o retry/failover limitado",
    };
  }
  if (!WAIVABLE_HIT_KINDS.has(input.hitKind)) {
    return {
      decision: "retry-required",
      reason:
        `hit ${input.hitKind} é janela longa de uso; waiver exige ` +
        "rate-limit/auth/transient",
    };
  }
  if (input.dependsOn.length > 0) {
    return {
      decision: "not-eligible",
      reason:
        "task advisory não é raiz no plano selado (dependsOn não vazio)",
    };
  }
  if (input.consumers.length > 0) {
    return {
      decision: "not-eligible",
      reason:
        `task advisory possui consumidores no plano selado: ` +
        input.consumers.join(", "),
    };
  }
  return { decision: "waive" };
}
