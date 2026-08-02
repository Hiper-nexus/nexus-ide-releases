import type { AgentGateContext } from './gate';
import type { DesignKit, DesignKitSourceId } from '../design/design-kit-source';
import type { DesignSystemToolOptions } from './design-system-authority';
import {
  keylessDesignKitSource,
  proposeDesignContractFromKit,
} from './tools-design-system-local';

/**
 * The user-facing "Import" button used to be a single-source path: it called
 * `nexus_design_system_import`, which reads the DESIGN.md body from the
 * authenticated designmd.ai `/raw` endpoint. Without
 * `external:designmd-api-key` that endpoint answers 401, so the button simply
 * failed and the project stayed with no design contract at all.
 *
 * This module turns that one shot into the same ladder the mission kickoff
 * teaches: designmd.ai first (it is what the operator asked for), then the two
 * keyless sources. Two rules keep the fallback honest:
 *
 * - It triggers ONLY on a missing/rejected credential. A network error, a 404,
 *   a license refusal — anything that is a real failure — still surfaces
 *   unchanged, because silently importing a different kit would be worse than
 *   failing.
 * - The result always names WHICH source served, plus every attempt that did
 *   not, so the operator is never told "imported" without knowing from where.
 *
 * Authority is never widened: the caller's fence is re-asserted before each
 * source and again before the draft is proposed, and a fence failure aborts
 * instead of being counted as "this source did not have the kit".
 */

export const REMOTE_DESIGN_SOURCE: DesignKitSourceId = 'designmd.ai';
/** Preference order once the credentialed source is out: offline before npx. */
export const KEYLESS_FALLBACK_SOURCES: readonly DesignKitSourceId[] = [
  'local-catalog',
  'getdesign',
];

const MAX_IDENTIFIER_CHARS = 512;
const MAX_FALLBACK_KIT_ID_CHARS = 64;
const MAX_ATTEMPT_DETAIL_CHARS = 300;
/** Same shape both keyless sources accept as a kit id / brand slug. */
const FALLBACK_KIT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface DesignImportSourceAttempt {
  readonly sourceId: DesignKitSourceId;
  readonly ok: boolean;
  readonly detail: string | null;
}

export interface KeylessFallbackImportResult {
  /** The source that actually produced the draft. */
  readonly servedBy: DesignKitSourceId;
  readonly attempts: readonly DesignImportSourceAttempt[];
  /** Raw import payload (draftId, targetPath, status, evidencePath, …). */
  readonly draft: Record<string, unknown>;
}

export interface KeylessFallbackImportInput {
  readonly ctx: AgentGateContext;
  /** designmd.ai identifier: `author/slug`, a bare slug, or a full URL. */
  readonly identifier: string;
  readonly targetPath: string;
  readonly missionId?: string;
  readonly assertCurrentAuthority: () => void;
  /** The credentialed import, injected so this module never imports it. */
  readonly runRemoteImport: () => Promise<Record<string, unknown>>;
  readonly options?: DesignSystemToolOptions;
}

/**
 * The kit id a keyless source could plausibly answer for a designmd.ai
 * identifier: its last path segment. Returns null rather than guessing when the
 * segment is not a usable id — a wrong guess would import the wrong brand.
 */
export function fallbackKitIdFromIdentifier(identifier: string): string | null {
  const trimmed = identifier.trim().slice(0, MAX_IDENTIFIER_CHARS);
  if (trimmed === '') return null;
  const withoutQuery = trimmed.split(/[?#]/)[0] ?? '';
  const segments = withoutQuery
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  const candidate = last.toLowerCase();
  if (candidate.length > MAX_FALLBACK_KIT_ID_CHARS) return null;
  return FALLBACK_KIT_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * True only for "there is no usable credential" (DesignMdAuthError covers both
 * the absent secret and a 401/403 answer). Matched by name as well as by
 * instance so a mocked or cross-bundle client is still recognized, and never
 * by message text, which would make any 401-mentioning error trigger a
 * fallback.
 */
export function isMissingDesignCredentialError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'DesignMdAuthError'
  );
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, MAX_ATTEMPT_DETAIL_CHARS);
}

function attemptSummary(attempts: readonly DesignImportSourceAttempt[]): string {
  return attempts
    .map((attempt) => `${attempt.sourceId}: ${attempt.detail ?? 'ok'}`)
    .join(' | ');
}

export async function importDesignContractWithKeylessFallback(
  input: KeylessFallbackImportInput,
): Promise<KeylessFallbackImportResult> {
  const attempts: DesignImportSourceAttempt[] = [];

  try {
    const draft = await input.runRemoteImport();
    return {
      servedBy: REMOTE_DESIGN_SOURCE,
      attempts: [{ sourceId: REMOTE_DESIGN_SOURCE, ok: true, detail: null }],
      draft,
    };
  } catch (error) {
    // A real failure is the answer, not a reason to import something else.
    if (!isMissingDesignCredentialError(error)) throw error;
    attempts.push({
      sourceId: REMOTE_DESIGN_SOURCE,
      ok: false,
      detail: describeError(error),
    });
  }

  const kitId = fallbackKitIdFromIdentifier(input.identifier);
  if (kitId === null) {
    throw new Error(
      `${attemptSummary(attempts)}; no keyless fallback: the identifier does ` +
        'not yield a usable kit id — pick a kit with ' +
        'nexus_design_system_local_list instead',
    );
  }

  const options = input.options ?? {};
  let served: { sourceId: DesignKitSourceId; kit: DesignKit } | null = null;
  for (const sourceId of KEYLESS_FALLBACK_SOURCES) {
    // Outside the catch on purpose: a revoked fence must abort the whole
    // import, not be recorded as "this source did not have the kit".
    input.assertCurrentAuthority();
    try {
      const kit = await keylessDesignKitSource(sourceId, options).getKit(kitId);
      served = { sourceId, kit };
      break;
    } catch (error) {
      attempts.push({ sourceId, ok: false, detail: describeError(error) });
    }
  }

  if (!served) {
    throw new Error(
      `design kit "${kitId}" could not be imported from any source. ` +
        attemptSummary(attempts),
    );
  }

  input.assertCurrentAuthority();
  const draft = proposeDesignContractFromKit({
    ctx: input.ctx,
    kit: served.kit,
    targetPath: input.targetPath,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    assertCurrentAuthority: input.assertCurrentAuthority,
  });
  attempts.push({ sourceId: served.sourceId, ok: true, detail: null });

  return {
    servedBy: served.sourceId,
    attempts,
    draft: draft as unknown as Record<string, unknown>,
  };
}
