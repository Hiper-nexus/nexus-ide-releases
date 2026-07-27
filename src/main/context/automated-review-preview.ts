import fs from 'node:fs';
import path from 'node:path';

const STATIC_OUTPUT_DIR_NAMES = new Set(['dist', 'build', 'out']);
const WALK_EXCLUSIONS = new Set([
  '.claude',
  '.codex',
  '.context',
  '.git',
  '.nexus',
  'coverage',
  'node_modules',
  'third_party',
  'vendor',
]);
const MAX_WALK_ENTRIES = 20_000;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const SOURCE_ENTRY_RE =
  /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["'][^"']+\.(?:[cm]?tsx?|jsx|vue|svelte)(?:[?#][^"']*)?["']/i;

export interface AutomatedReviewPreviewRoot {
  readonly root: string;
  readonly indexPath: string;
  readonly relativeRoot: string;
  readonly kind: 'built-output' | 'static-root';
}

export interface AutomatedReviewPreviewScanLimits {
  /**
   * Tests and stricter callers may lower the production ceiling. Values above
   * the production bound never expand the amount of filesystem work.
   */
  readonly maxWalkEntries?: number;
}

interface OutputRootScan {
  readonly roots: readonly string[];
  readonly complete: boolean;
  readonly visitedEntries: number;
  readonly incompleteReason: string | null;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Canonicalize a preview server's configured directory without trusting its
 * lexical path. Callers may reuse that server only when this physical path is
 * exactly the artifact selected by resolveAutomatedReviewPreviewRoot.
 */
export function realpathAutomatedReviewPreviewDirectory(
  previewDirectory: string,
): string | null {
  try {
    const root = fs.realpathSync.native(path.resolve(previewDirectory));
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

function inspectStaticRoot(
  checkoutRoot: string,
  candidatePath: string,
  kind: AutomatedReviewPreviewRoot['kind'],
): AutomatedReviewPreviewRoot | null {
  try {
    const root = fs.realpathSync.native(candidatePath);
    if (!isInside(checkoutRoot, root) || !fs.statSync(root).isDirectory()) {
      return null;
    }
    const indexPath = fs.realpathSync.native(path.join(root, 'index.html'));
    if (!isInside(root, indexPath)) return null;
    const stat = fs.statSync(indexPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INDEX_BYTES) {
      return null;
    }
    const html = fs.readFileSync(indexPath, 'utf8');
    if (!/<(?:!doctype\s+html|html)\b/i.test(html)) return null;
    // A source entry such as /src/main.tsx needs a framework dev server or
    // compiler. Serving it as static bytes would produce a deceptively blank
    // review surface, so only built JavaScript or genuinely static HTML pass.
    if (SOURCE_ENTRY_RE.test(html)) return null;
    return Object.freeze({
      root,
      indexPath,
      relativeRoot: path.relative(checkoutRoot, root) || '.',
      kind,
    });
  } catch {
    return null;
  }
}

function collectOutputRoots(
  checkoutRoot: string,
  maxWalkEntries: number,
): OutputRootScan {
  const roots: string[] = [];
  let visitedEntries = 0;
  let complete = true;
  let incompleteReason: string | null = null;

  const markIncomplete = (reason: string): void => {
    complete = false;
    incompleteReason ??= reason;
  };

  const consumeEntryBudget = (relativeDirectory: string): boolean => {
    if (visitedEntries >= maxWalkEntries) {
      markIncomplete(
        `entry limit ${maxWalkEntries} reached before ` +
          `${relativeDirectory || '.'} was fully inspected`,
      );
      return false;
    }
    visitedEntries += 1;
    return true;
  };

  const walk = (dir: string): void => {
    if (!complete) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      markIncomplete(
        `could not inspect ${path.relative(checkoutRoot, dir) || '.'}`,
      );
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        !consumeEntryBudget(path.relative(checkoutRoot, dir) || '.')
      ) {
        return;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (WALK_EXCLUSIONS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (STATIC_OUTPUT_DIR_NAMES.has(entry.name)) {
        roots.push(child);
        continue;
      }
      if (entry.name === '.vite') {
        const rendererRoot = path.join(child, 'renderer');
        let renderers: fs.Dirent[] = [];
        try {
          const rendererStat = fs.lstatSync(rendererRoot);
          if (
            !rendererStat.isDirectory() ||
            rendererStat.isSymbolicLink()
          ) {
            continue;
          }
          renderers = fs.readdirSync(rendererRoot, { withFileTypes: true });
        } catch (error) {
          // A Vite cache without a renderer build is not a review artifact.
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
          ) {
            markIncomplete(
              `could not inspect ` +
                `${path.relative(checkoutRoot, rendererRoot)}`,
            );
          }
        }
        renderers.sort((left, right) =>
          left.name.localeCompare(right.name),
        );
        for (const renderer of renderers) {
          if (
            !consumeEntryBudget(
              path.relative(checkoutRoot, rendererRoot),
            )
          ) {
            return;
          }
          if (renderer.isDirectory() && !renderer.isSymbolicLink()) {
            roots.push(path.join(rendererRoot, renderer.name));
          }
        }
        continue;
      }
      walk(child);
    }
  };

  walk(checkoutRoot);
  return Object.freeze({
    roots: Object.freeze([...roots]),
    complete,
    visitedEntries,
    incompleteReason,
  });
}

/**
 * Resolve one physical, already-built UI artifact inside the exact candidate
 * checkout. Main never executes package scripts here: the worker must leave a
 * reviewable artifact, and ambiguity fails closed instead of showing the
 * reviewer an arbitrary/stale application.
 */
export function resolveAutomatedReviewPreviewRoot(
  checkoutPath: string,
  limits: AutomatedReviewPreviewScanLimits = {},
): AutomatedReviewPreviewRoot {
  const checkoutRoot = fs.realpathSync.native(path.resolve(checkoutPath));
  if (!fs.statSync(checkoutRoot).isDirectory()) {
    throw new Error('automated design-review checkout is not a directory');
  }
  const requestedEntryLimit =
    limits.maxWalkEntries ?? MAX_WALK_ENTRIES;
  if (
    !Number.isSafeInteger(requestedEntryLimit) ||
    requestedEntryLimit <= 0
  ) {
    throw new Error(
      'automated design-review scan entry limit must be a positive integer',
    );
  }
  const maxWalkEntries = Math.min(
    requestedEntryLimit,
    MAX_WALK_ENTRIES,
  );

  const scan = collectOutputRoots(checkoutRoot, maxWalkEntries);
  if (!scan.complete) {
    throw new Error(
      `rendered design review artifact scan was incomplete after ` +
        `${scan.visitedEntries} entries: ` +
        `${scan.incompleteReason ?? 'bounded scan stopped'}. ` +
        `No preview candidate can be accepted safely.`,
    );
  }

  const built = scan.roots
    .map((candidate) =>
      inspectStaticRoot(checkoutRoot, candidate, 'built-output'),
    )
    .filter(
      (candidate): candidate is AutomatedReviewPreviewRoot =>
        candidate !== null,
    );
  const uniqueBuilt = [
    ...new Map(built.map((candidate) => [candidate.root, candidate])).values(),
  ];
  const staticRoot = inspectStaticRoot(
    checkoutRoot,
    checkoutRoot,
    'static-root',
  );
  const candidates = staticRoot
    ? [...uniqueBuilt, staticRoot]
    : uniqueBuilt;
  const uniqueCandidates = [
    ...new Map(
      candidates.map((candidate) => [candidate.root, candidate]),
    ).values(),
  ];
  if (uniqueCandidates.length > 1) {
    throw new Error(
      `rendered design review found multiple UI artifacts: ` +
        uniqueCandidates
          .map((candidate) => candidate.relativeRoot)
          .join(', ') +
        '. Keep exactly one candidate preview output.',
    );
  }
  if (uniqueCandidates.length === 1) return uniqueCandidates[0]!;

  throw new Error(
    'rendered design review needs one built static UI inside the candidate ' +
      'checkout (dist/, build/, out/ or .vite/renderer/* with index.html). ' +
      'Run the project build in the task worktree and retry.',
  );
}
