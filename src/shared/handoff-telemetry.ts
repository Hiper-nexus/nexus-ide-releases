/**
 * Telemetria autorrelatada por handoff (herança do board do overclick,
 * 19/08): o agente conhece o próprio transcript — duração e tokens do turno —
 * e o Nexus não tem como medir isso de fora. O worker PODE anexar
 * `telemetry: {durationMs, tokensTotal, tokensByModel?, estimated?}` ao
 * nexus_handoff_submit; o dado viaja DENTRO de `artifacts` (metadado
 * untrusted que já persiste hoje), então nenhuma coluna nova entra no
 * schema e nada disso vira evidência de conclusão.
 *
 * Regras de honestidade (doutrina do dossiê):
 * - estimativa é MARCADA (`estimated: true`), nunca vendida como medida;
 * - ausência é DECLARADA no agregado (reportados/total), nunca zero
 *   confiante;
 * - números são saneados com tetos físicos — telemetria não é canal de
 *   injeção nem de payload gigante.
 */

export interface HandoffTelemetry {
  readonly durationMs?: number;
  readonly tokensTotal?: number;
  readonly tokensByModel?: Readonly<Record<string, number>>;
  readonly estimated?: boolean;
}

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_TOKENS = 10_000_000_000;
const MAX_MODELS = 12;
const MAX_MODEL_NAME_CHARS = 64;

const TELEMETRY_ARTIFACT_KEY = 'nexusTelemetry';

function sanePositiveInt(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded <= 0 || rounded > max) return undefined;
  return rounded;
}

/** Saneia o payload cru do agente. Null quando nada é aproveitável. */
export function sanitizeHandoffTelemetry(raw: unknown): HandoffTelemetry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const durationMs = sanePositiveInt(candidate.durationMs, MAX_DURATION_MS);
  let tokensTotal = sanePositiveInt(candidate.tokensTotal, MAX_TOKENS);
  let tokensByModel: Record<string, number> | undefined;
  if (
    candidate.tokensByModel &&
    typeof candidate.tokensByModel === 'object' &&
    !Array.isArray(candidate.tokensByModel)
  ) {
    const entries = Object.entries(candidate.tokensByModel as Record<string, unknown>)
      .slice(0, MAX_MODELS)
      .map(([model, tokens]) => [
        model.trim().slice(0, MAX_MODEL_NAME_CHARS),
        sanePositiveInt(tokens, MAX_TOKENS),
      ] as const)
      .filter(([model, tokens]) => model.length > 0 && tokens !== undefined);
    if (entries.length > 0) {
      tokensByModel = Object.fromEntries(entries) as Record<string, number>;
      if (tokensTotal === undefined) {
        tokensTotal = Math.min(
          MAX_TOKENS,
          Object.values(tokensByModel).reduce((sum, n) => sum + n, 0),
        );
      }
    }
  }
  if (durationMs === undefined && tokensTotal === undefined) return null;
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokensTotal !== undefined ? { tokensTotal } : {}),
    ...(tokensByModel ? { tokensByModel } : {}),
    ...(candidate.estimated === true ? { estimated: true } : {}),
  };
}

/** Artefato-envelope que viaja em `artifacts` (metadado untrusted). */
export function embedTelemetryArtifact(
  telemetry: HandoffTelemetry,
): Record<string, unknown> {
  return { [TELEMETRY_ARTIFACT_KEY]: telemetry };
}

/** Extrai a telemetria de um handoff persistido (ou null se não reportada). */
export function extractHandoffTelemetry(handoff: {
  readonly artifacts: readonly unknown[];
}): HandoffTelemetry | null {
  for (const artifact of handoff.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      continue;
    }
    const envelope = (artifact as Record<string, unknown>)[TELEMETRY_ARTIFACT_KEY];
    const sane = sanitizeHandoffTelemetry(envelope);
    if (sane) return sane;
  }
  return null;
}

export interface MissionTelemetryAggregate {
  readonly totalDurationMs: number;
  readonly totalTokens: number;
  /** Handoffs que reportaram alguma telemetria. */
  readonly reported: number;
  /** Total de handoffs considerados — ausência declarada, nunca zero mudo. */
  readonly total: number;
  /** true quando qualquer parcela é estimativa autorrelatada. */
  readonly estimated: boolean;
}

export function aggregateMissionTelemetry(
  handoffs: readonly { readonly artifacts: readonly unknown[] }[],
): MissionTelemetryAggregate | null {
  let totalDurationMs = 0;
  let totalTokens = 0;
  let reported = 0;
  let estimated = false;
  for (const handoff of handoffs) {
    const telemetry = extractHandoffTelemetry(handoff);
    if (!telemetry) continue;
    reported += 1;
    totalDurationMs += telemetry.durationMs ?? 0;
    totalTokens += telemetry.tokensTotal ?? 0;
    if (telemetry.estimated) estimated = true;
  }
  if (reported === 0) return null;
  return {
    totalDurationMs,
    totalTokens,
    reported,
    total: handoffs.length,
    estimated,
  };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** "34 min · 1.2M tokens · autorrelato 5/7" — honesto sobre a cobertura. */
export function formatMissionTelemetry(
  aggregate: MissionTelemetryAggregate,
): string {
  const parts: string[] = [];
  if (aggregate.totalDurationMs > 0) {
    const minutes = Math.max(1, Math.round(aggregate.totalDurationMs / 60_000));
    parts.push(`${minutes} min`);
  }
  if (aggregate.totalTokens > 0) {
    parts.push(`${formatTokens(aggregate.totalTokens)} tokens`);
  }
  const prefix = aggregate.estimated ? '~' : '';
  const coverage = `autorrelato ${aggregate.reported}/${aggregate.total}`;
  return parts.length > 0
    ? `${prefix}${parts.join(' · ')} · ${coverage}`
    : coverage;
}
