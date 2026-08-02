import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toDesignKit,
  type DesignKit,
  type DesignKitSource,
  type DesignKitSummary,
} from './design-kit-source';

/**
 * Local design catalog: a directory of `.md` design contracts on disk
 * (`~/.design-references` by convention, one file per brand/system, as produced
 * by `npx getdesign@latest add <brand>`).
 *
 * This is the offline half of the `DesignKitSource` abstraction. designmd.ai
 * serves search and metadata publicly but gates the DESIGN.md body behind
 * `external:designmd-api-key`; when that secret is absent — or the machine is
 * offline — this source is what keeps a mission from falling back to the
 * model's generic default styling.
 *
 * Everything here is bounded: the content becomes a contract an agent reads, so
 * a runaway file must not become a runaway prompt.
 */

export const LOCAL_DESIGN_CATALOG_DIR_NAME = '.design-references';
/** Real curated references sit at 20–45 KB; this leaves generous headroom. */
export const MAX_LOCAL_KIT_BYTES = 256 * 1024;
export const MAX_LOCAL_CATALOG_BYTES = 4 * 1024 * 1024;
export const MAX_LOCAL_KITS = 128;

const MAX_TITLE_CHARS = 72;
const MAX_TITLE_WORDS = 8;
const MAX_DESCRIPTION_CHARS = 512;

/**
 * A kit title must look like a NAME, not like a sentence.
 *
 * The bytes in this catalog are third-party markdown (`npx getdesign add`
 * writes them), and the title is the one field that leaves the catalog as
 * PROSE: `house-design-contract` renders it into the design contract, which the
 * mechanical reviewer approves and the autopilot commits. Escaping (`safeInline`)
 * stops a title from restructuring the document, but it cannot stop 160
 * characters of imperative instruction addressed to the agent that must obey
 * that document.
 *
 * So the shape is constrained instead of the syntax: letters, digits, spaces
 * and the punctuation real brand names use, bounded in words and characters.
 * Anything else is not sanitized into something plausible — it is dropped, and
 * the caller falls back to the title derived from the (already sanitized) file
 * name.
 */
const KIT_TITLE_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} ._'&()+/–—-]*$/u;

export function sanitizeDesignKitTitle(raw: string): string | null {
  const collapsed = raw.replace(/\s+/gu, ' ').trim();
  if (collapsed === '' || collapsed.length > MAX_TITLE_CHARS) return null;
  if (collapsed.split(' ').length > MAX_TITLE_WORDS) return null;
  return KIT_TITLE_SHAPE.test(collapsed) ? collapsed : null;
}
const MAX_TAGS = 16;
const MAX_FRONTMATTER_CHARS = 8 * 1024;
const MAX_TITLE_SCAN_CHARS = 8 * 1024;
const MAX_KIT_ID_CHARS = 64;

/** Index/readme files describe the catalog; they are not design contracts. */
const INDEX_BASENAMES = new Set([
  'readme',
  'index',
  '_index',
  'contents',
  'toc',
  'changelog',
  'license',
]);

export type LocalDesignCatalogSkipReason =
  | 'index-file'
  | 'not-markdown'
  | 'not-a-regular-file'
  | 'empty'
  | 'too-large'
  | 'unreadable'
  | 'duplicate-id'
  | 'invalid-name'
  | 'catalog-budget-exhausted'
  | 'kit-limit-reached';

export interface LocalDesignCatalogSkip {
  readonly fileName: string;
  readonly reason: LocalDesignCatalogSkipReason;
}

export interface LocalDesignCatalog {
  readonly dir: string;
  readonly exists: boolean;
  readonly kits: readonly DesignKitSummary[];
  /** Never silently dropped: every ignored file is reported with its reason. */
  readonly skipped: readonly LocalDesignCatalogSkip[];
}

export interface LocalDesignCatalogOptions {
  /** Injectable for tests and for the `orch.designLocalCatalogDir` setting. */
  readonly dir?: string;
  readonly maxKitBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxKits?: number;
}

export function defaultLocalDesignCatalogDir(): string {
  return path.join(os.homedir(), LOCAL_DESIGN_CATALOG_DIR_NAME);
}

/** Empty/blank configuration means "use the conventional home directory". */
export function resolveLocalDesignCatalogDir(configured?: string | null): string {
  const trimmed = (configured ?? '').trim();
  return trimmed === '' ? defaultLocalDesignCatalogDir() : trimmed;
}

function frontmatterBlock(content: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return null;
  return normalized.slice(4, end).slice(0, MAX_FRONTMATTER_CHARS);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const isQuoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return isQuoted ? trimmed.slice(1, -1).trim() : trimmed;
}

function frontmatterField(block: string | null, field: string): string | null {
  if (!block) return null;
  for (const line of block.split('\n')) {
    // Only top-level keys: nested YAML (`colors:` → `  primary:`) is data.
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):[ \t]*(.*)$/);
    if (match && match[1] === field) {
      const value = unquote(match[2]);
      return value === '' ? null : value;
    }
  }
  return null;
}

function frontmatterTags(block: string | null): readonly string[] {
  const raw = frontmatterField(block, 'tags');
  if (!raw) return [];
  const inline = raw.match(/^\[(.*)\]$/);
  if (!inline) return [];
  return inline[1]
    .split(',')
    .map((tag) => unquote(tag))
    .filter((tag) => tag !== '')
    .slice(0, MAX_TAGS);
}

function firstHeading(content: string): string | null {
  for (const line of content.slice(0, MAX_TITLE_SCAN_CHARS).split('\n')) {
    const match = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  return null;
}

function titleFromFileName(kitId: string): string {
  return kitId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function deriveKitId(fileName: string): string {
  return path
    .basename(fileName, path.extname(fileName))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_KIT_ID_CHARS);
}

function isMarkdown(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.md' || extension === '.markdown';
}

function isIndexFile(fileName: string): boolean {
  return INDEX_BASENAMES.has(
    path.basename(fileName, path.extname(fileName)).trim().toLowerCase(),
  );
}

function summaryFor(
  fileName: string,
  kitId: string,
  content: string,
): DesignKitSummary {
  const block = frontmatterBlock(content);
  // Declared name, then first heading, then the file name — but only a value
  // that still looks like a name after `sanitizeDesignKitTitle`. The file-name
  // fallback is derived from `kitId`, which is already reduced to
  // `[a-z0-9._-]`, so the last resort is always safe.
  const title =
    sanitizeDesignKitTitle(frontmatterField(block, 'name') ?? '') ??
    sanitizeDesignKitTitle(firstHeading(content) ?? '') ??
    titleFromFileName(kitId).slice(0, MAX_TITLE_CHARS);
  const description = frontmatterField(block, 'description') ?? '';
  return {
    sourceId: 'local-catalog',
    kitId,
    title,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    tags: frontmatterTags(block),
    license: 'unknown',
    locator: fileName,
  };
}

interface ScanLimits {
  readonly maxKitBytes: number;
  readonly maxTotalBytes: number;
  readonly maxKits: number;
}

function limitsFor(options: LocalDesignCatalogOptions): ScanLimits {
  return {
    maxKitBytes: Math.min(options.maxKitBytes ?? MAX_LOCAL_KIT_BYTES, MAX_LOCAL_KIT_BYTES),
    maxTotalBytes: Math.min(
      options.maxTotalBytes ?? MAX_LOCAL_CATALOG_BYTES,
      MAX_LOCAL_CATALOG_BYTES,
    ),
    maxKits: Math.min(options.maxKits ?? MAX_LOCAL_KITS, MAX_LOCAL_KITS),
  };
}

function readCandidate(
  dir: string,
  fileName: string,
  maxKitBytes: number,
): { content: string; bytes: number } | LocalDesignCatalogSkipReason {
  const absolute = path.join(dir, fileName);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return 'unreadable';
  }
  // A symlink could point anywhere; the catalog is a flat directory of files.
  if (stat.isSymbolicLink() || !stat.isFile()) return 'not-a-regular-file';
  if (stat.size > maxKitBytes) return 'too-large';
  let content: string;
  try {
    content = fs.readFileSync(absolute, 'utf8');
  } catch {
    return 'unreadable';
  }
  if (content.trim() === '') return 'empty';
  return { content, bytes: stat.size };
}

function listDirectory(dir: string): readonly string[] | null {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith('.'))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return null;
  }
}

/**
 * Enumerate the catalog. Reads each candidate once so the summary reflects the
 * bytes that are actually on disk, and reports every rejection instead of
 * silently shrinking the list.
 */
export function listLocalDesignCatalog(
  options: LocalDesignCatalogOptions = {},
): LocalDesignCatalog {
  const dir = resolveLocalDesignCatalogDir(options.dir);
  const limits = limitsFor(options);
  const entries = listDirectory(dir);
  if (!entries) {
    return { dir, exists: false, kits: [], skipped: [] };
  }

  const kits: DesignKitSummary[] = [];
  const skipped: LocalDesignCatalogSkip[] = [];
  const seenIds = new Set<string>();
  let totalBytes = 0;

  for (const fileName of entries) {
    if (!isMarkdown(fileName)) {
      skipped.push({ fileName, reason: 'not-markdown' });
      continue;
    }
    if (isIndexFile(fileName)) {
      skipped.push({ fileName, reason: 'index-file' });
      continue;
    }
    if (kits.length >= limits.maxKits) {
      skipped.push({ fileName, reason: 'kit-limit-reached' });
      continue;
    }
    const kitId = deriveKitId(fileName);
    if (kitId === '') {
      skipped.push({ fileName, reason: 'invalid-name' });
      continue;
    }
    if (seenIds.has(kitId)) {
      skipped.push({ fileName, reason: 'duplicate-id' });
      continue;
    }
    const candidate = readCandidate(dir, fileName, limits.maxKitBytes);
    if (typeof candidate === 'string') {
      skipped.push({ fileName, reason: candidate });
      continue;
    }
    if (totalBytes + candidate.bytes > limits.maxTotalBytes) {
      skipped.push({ fileName, reason: 'catalog-budget-exhausted' });
      continue;
    }
    totalBytes += candidate.bytes;
    seenIds.add(kitId);
    kits.push(summaryFor(fileName, kitId, candidate.content));
  }

  return { dir, exists: true, kits, skipped };
}

/**
 * The local implementation of `DesignKitSource`. `getKit` resolves through the
 * listing rather than joining the caller's id onto a path, so a traversal id
 * can only ever miss.
 */
export function createLocalDesignKitSource(
  options: LocalDesignCatalogOptions = {},
): DesignKitSource {
  const limits = limitsFor(options);
  return {
    sourceId: 'local-catalog',
    isAlwaysAvailable: true,
    async listKits(): Promise<readonly DesignKitSummary[]> {
      return listLocalDesignCatalog(options).kits;
    },
    async getKit(kitId: string): Promise<DesignKit> {
      const catalog = listLocalDesignCatalog(options);
      const summary = catalog.kits.find((kit) => kit.kitId === kitId);
      if (!summary) {
        const safeId = kitId.slice(0, MAX_KIT_ID_CHARS);
        // A file that exists but was rejected must say why, instead of
        // pretending the operator asked for something that never existed.
        const rejected = catalog.skipped.find(
          (skip) => deriveKitId(skip.fileName) === safeId,
        );
        throw new Error(
          rejected
            ? `local design kit ${safeId} was rejected by the catalog (${rejected.reason})`
            : `local design kit not found: ${safeId}`,
        );
      }
      const candidate = readCandidate(
        catalog.dir,
        summary.locator,
        limits.maxKitBytes,
      );
      if (candidate === 'too-large') {
        throw new Error(
          `local design kit ${summary.kitId} exceeds the ${limits.maxKitBytes}-byte cap`,
        );
      }
      if (typeof candidate === 'string') {
        throw new Error(
          `local design kit ${summary.kitId} is not readable (${candidate})`,
        );
      }
      return toDesignKit(summary, candidate.content);
    },
  };
}
