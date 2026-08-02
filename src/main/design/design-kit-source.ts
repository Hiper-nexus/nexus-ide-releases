import { createHash } from 'node:crypto';

/**
 * One abstraction over every place a design contract ("DESIGN.md") can come
 * from, so the mission flow never depends on a single provider being reachable.
 *
 * Three implementations exist today, in preference order:
 *
 * 1. `local-catalog` (src/main/design/local-design-catalog.ts): plain `.md`
 *    files on disk. No network, no credential, no subprocess — instant and
 *    always available.
 * 2. `getdesign` (src/main/design/getdesign-cli-source.ts): the open
 *    `getdesign` CLI catalog. No credential at all; costs one sandboxed npx
 *    run. This is what keeps the requirement from depending on a key.
 * 3. `designmd.ai` (src/main/design/designmd-api-client.ts): search and
 *    metadata are public, but the DESIGN.md body comes from the authenticated
 *    `/raw` endpoint, which answers 401 without
 *    `external:designmd-api-key` — even for MIT-licensed kits. A missing key
 *    must degrade to (1)/(2), never block the mission.
 *
 * Every materialized contract records WHICH source produced it (see
 * `renderDesignContract`), because that is what makes the result auditable
 * later: a local file hash is reproducible offline, a remote kit is not.
 */

export const DESIGN_KIT_SOURCES = [
  'local-catalog',
  'getdesign',
  'designmd.ai',
] as const;
export type DesignKitSourceId = (typeof DESIGN_KIT_SOURCES)[number];

export interface DesignKitSummary {
  readonly sourceId: DesignKitSourceId;
  /** Stable identifier of the kit inside its own source. */
  readonly kitId: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly license: string;
  /** Auditable origin: a file name for local kits, a URL for remote ones. */
  readonly locator: string;
}

export interface DesignKit extends DesignKitSummary {
  readonly content: string;
  readonly contentBytes: number;
  readonly contentHash: string;
}

export interface DesignKitSource {
  readonly sourceId: DesignKitSourceId;
  /** True when content is served with no network call and no credential. */
  readonly isAlwaysAvailable: boolean;
  listKits(): Promise<readonly DesignKitSummary[]>;
  getKit(kitId: string): Promise<DesignKit>;
}

export function designKitContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function toDesignKit(
  summary: DesignKitSummary,
  content: string,
): DesignKit {
  return {
    ...summary,
    content,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    contentHash: designKitContentHash(content),
  };
}

const MAX_COMMENT_VALUE_CHARS = 512;

/**
 * Keep an untrusted value from terminating (or forging) the HTML comment that
 * carries provenance. Shared by every source so one escape rule governs all
 * markers.
 */
export function sanitizeDesignCommentValue(value: string): string {
  return value
    .replace(/-->/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_COMMENT_VALUE_CHARS);
}

/**
 * The dembrandt skill's hard rule, restated inside every contract Nexus
 * materializes: measured tokens are a starting point to adapt, never a brand
 * to copy.
 */
export const DESIGN_ADAPTATION_NOTICE =
  'Tokens (color, type scale, spacing, radius, motion) are ADAPTED to this ' +
  "project's own identity. Never copy a third-party brand, logo, or wordmark.";

export const DESIGN_DRAFT_NOTICE =
  'This file is a PROPOSED context draft. Do not apply without review.';

export interface DesignContractProvenance {
  /** Headline marker line, e.g. "DESIGN.md imported from designmd.ai". */
  readonly marker: string;
  readonly sourceId: DesignKitSourceId;
  readonly kitId: string;
  /** Extra `key: value` provenance lines, rendered in order. */
  readonly details?: readonly string[];
  readonly content: string;
}

function commentLine(value: string): string {
  return `<!-- ${sanitizeDesignCommentValue(value)} -->`;
}

/**
 * Single rendering path for a materialized design contract. Both the local
 * catalog and the designmd.ai import go through here so provenance always
 * names the source and the kit, in one format instead of two.
 */
export function renderDesignContract(input: DesignContractProvenance): string {
  const details = input.details ?? [];
  return [
    commentLine(input.marker),
    commentLine(`kit-source: ${input.sourceId} | kit: ${input.kitId}`),
    ...details.map(commentLine),
    commentLine(DESIGN_ADAPTATION_NOTICE),
    commentLine(DESIGN_DRAFT_NOTICE),
    '',
    input.content,
  ].join('\n');
}
