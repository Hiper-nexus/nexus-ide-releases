/**
 * Upgrade-only compatibility policy for provider ids removed from the live
 * adapter catalog. Keeping the ids here lets persisted settings and immutable
 * mission receipts fail forward without restoring either provider runtime.
 */
export const RETIRED_ADAPTER_IDS = ["omp", "omp-rpc"] as const;
export type RetiredAdapterId = (typeof RETIRED_ADAPTER_IDS)[number];

const RETIRED_ADAPTER_ID_SET = new Set<string>(RETIRED_ADAPTER_IDS);

export const RETIRED_ROSTER_ROUTE_MARKER =
  "[NEXUS_RETIRED_ROSTER_ROUTE]";

export function isRetiredAdapterId(
  adapterId: string | null | undefined,
): adapterId is RetiredAdapterId {
  return RETIRED_ADAPTER_ID_SET.has(adapterId?.trim() ?? "");
}

export class RetiredRosterRouteError extends Error {
  readonly adapterId: RetiredAdapterId;
  readonly agentRef: string;

  constructor(adapterId: RetiredAdapterId, agentRef: string) {
    super(
      `${RETIRED_ROSTER_ROUTE_MARKER} roster_route_retired: a CLI ` +
        `\`${adapterId}\` do agente \`${agentRef}\` foi removida do runtime. ` +
        "O seal histórico foi preservado; revise o squad, escolha uma CLI " +
        "disponível e reaprove a nova revisão.",
    );
    this.name = "RetiredRosterRouteError";
    this.adapterId = adapterId;
    this.agentRef = agentRef;
  }
}

export function hasRetiredRosterRouteMarker(value: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = value;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (typeof current === "string") {
      return current.includes(RETIRED_ROSTER_ROUTE_MARKER);
    }
    if (!(current instanceof Error)) return false;
    if (current.message.includes(RETIRED_ROSTER_ROUTE_MARKER)) return true;
    current = current.cause;
  }
  return false;
}
