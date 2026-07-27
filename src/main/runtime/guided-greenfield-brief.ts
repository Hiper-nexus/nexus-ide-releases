export const GUIDED_GREENFIELD_BRIEF_PATH = "PRODUCT.md";

const GUIDED_GREENFIELD_BRIEF_MARKER =
  "<!-- nexus-guided-greenfield-brief:v1 -->";
const JSON_FENCE_START = "```json\n";
const JSON_FENCE_END = "\n```";
const MAX_BRIEF_BYTES = 256 * 1024;

export interface GuidedGreenfieldApprovedIntent {
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
}

interface GuidedGreenfieldBriefPayload {
  readonly schemaVersion: 1;
  readonly kind: "nexus-guided-greenfield-approved-intent";
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
}

function approvedIntentPayload(
  input: GuidedGreenfieldApprovedIntent,
): GuidedGreenfieldBriefPayload {
  if (
    typeof input.goal !== "string" ||
    input.goal.trim().length === 0 ||
    !Array.isArray(input.acceptanceCriteria) ||
    input.acceptanceCriteria.length === 0 ||
    input.acceptanceCriteria.some(
      (criterion) =>
        typeof criterion !== "string" || criterion.trim().length === 0,
    )
  ) {
    throw new Error(
      "guided_greenfield_brief_invalid_intent: objetivo e critérios aprovados são obrigatórios",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "nexus-guided-greenfield-approved-intent",
    goal: input.goal,
    acceptanceCriteria: Object.freeze([...input.acceptanceCriteria]),
  });
}

function safeInlineJson(payload: GuidedGreenfieldBriefPayload): string {
  // Keep the fenced JSON one physical line and prevent approved user text
  // containing backticks/HTML from terminating the source envelope.
  return JSON.stringify(payload)
    .replaceAll("`", "\\u0060")
    .replaceAll("<", "\\u003c");
}

/**
 * Main-owned, deterministic source projection for a physically empty guided
 * workspace. It records only the approved intent and names every absent
 * product/technical dimension as unknown; it does not select a stack.
 */
export function renderGuidedGreenfieldBrief(
  input: GuidedGreenfieldApprovedIntent,
): string {
  const payload = approvedIntentPayload(input);
  const content = [
    "# Approved product brief",
    "",
    GUIDED_GREENFIELD_BRIEF_MARKER,
    "",
    "Nexus projected this source brief from the exact mission intent approved by the user.",
    "Only the JSON envelope below is product authority.",
    "",
    "## Exact approved intent",
    "",
    JSON_FENCE_START.trimEnd(),
    safeInlineJson(payload),
    JSON_FENCE_END.trimStart(),
    "",
    "## Explicit unknowns",
    "",
    "- Target users, domain vocabulary, business model, pricing, billing, tenancy, legal and regulatory requirements are unknown unless stated in the approved intent.",
    "- Language, runtime, framework, dependencies, architecture, data model, deployment target and verification commands are not selected yet.",
    "- Any product or technical choice not present in the exact approved intent remains undecided and requires governed implementation evidence.",
    "",
  ].join("\n");
  if (Buffer.byteLength(content, "utf8") > MAX_BRIEF_BYTES) {
    throw new Error(
      "guided_greenfield_brief_too_large: a intenção aprovada excede o limite seguro",
    );
  }
  return content;
}

/**
 * Accept only the byte-canonical Main projection. A lookalike PRODUCT.md with
 * extra prose cannot enter the mechanical-review lane.
 */
export function parseGuidedGreenfieldBrief(
  content: string,
): GuidedGreenfieldApprovedIntent | null {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MAX_BRIEF_BYTES ||
    !content.includes(GUIDED_GREENFIELD_BRIEF_MARKER)
  ) {
    return null;
  }
  const start = content.indexOf(JSON_FENCE_START);
  if (start < 0) return null;
  const payloadStart = start + JSON_FENCE_START.length;
  const end = content.indexOf(JSON_FENCE_END, payloadStart);
  if (end < 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(payloadStart, end));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
      ["acceptanceCriteria", "goal", "kind", "schemaVersion"]
        .sort()
        .join("\0") ||
    record.schemaVersion !== 1 ||
    record.kind !== "nexus-guided-greenfield-approved-intent" ||
    typeof record.goal !== "string" ||
    !Array.isArray(record.acceptanceCriteria) ||
    record.acceptanceCriteria.some(
      (criterion) => typeof criterion !== "string",
    )
  ) {
    return null;
  }
  const parsed = {
    goal: record.goal,
    acceptanceCriteria: record.acceptanceCriteria as string[],
  };
  try {
    return renderGuidedGreenfieldBrief(parsed) === content
      ? Object.freeze({
          goal: parsed.goal,
          acceptanceCriteria: Object.freeze([...parsed.acceptanceCriteria]),
        })
      : null;
  } catch {
    return null;
  }
}
