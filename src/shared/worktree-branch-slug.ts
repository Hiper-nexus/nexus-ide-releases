/**
 * Git branch slug generation and validation for isolated worktrees.
 *
 * Distilled from getpaseo/paseo packages/protocol/src/branch-slug.ts (Apache-2.0).
 * Safe against illegal git refs, path traversal characters, and shell metacharacters.
 *
 * NOT WIRED: the only importer is mission-worktree-orchestrator.ts, which has
 * no production call sites. Production worktree branches are hash-derived
 * (`refs/heads/nexus/<projectKey>/<taskKey>`) and do not use these slugs.
 * See docs/qa/items/F-404.md.
 */

export const MAX_SLUG_LENGTH = 50;
export const MAX_BRANCH_NAME_LENGTH = 100;

export interface BranchSlugValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Validate that a string is a safe and canonical git branch ref name.
 * Must be lowercase alphanumeric with hyphens and forward slashes only.
 */
export function validateBranchSlug(slug: string): BranchSlugValidationResult {
  if (!slug || slug.trim().length === 0) {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  const trimmed = slug.trim();

  if (trimmed.length > MAX_BRANCH_NAME_LENGTH) {
    return {
      valid: false,
      error: `Branch name too long (max ${MAX_BRANCH_NAME_LENGTH} characters)`,
    };
  }

  // Ref safety: git ref restrictions (no control characters, spaces, ~ ^ : ? * [ \ .. @{)
  const validPattern = /^[a-z0-9]+([a-z0-9-/]*[a-z0-9]+)?$/;
  if (!validPattern.test(trimmed)) {
    return {
      valid: false,
      error:
        'Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes, and cannot start or end with a symbol',
    };
  }

  if (trimmed.includes('--')) {
    return { valid: false, error: 'Branch name cannot have consecutive hyphens' };
  }

  if (trimmed.includes('//')) {
    return { valid: false, error: 'Branch name cannot have consecutive slashes' };
  }

  if (trimmed.includes('/-') || trimmed.includes('-/')) {
    return { valid: false, error: 'Branch segments cannot start or end with hyphens' };
  }

  if (trimmed === 'head' || trimmed.endsWith('/head')) {
    return { valid: false, error: 'Branch name cannot be HEAD' };
  }

  return { valid: true };
}

/**
 * Convert an arbitrary user or task title into a clean kebab-case slug.
 * Removes diacritics and special characters, preserving word boundaries.
 */
export function slugify(input: string, maxLength: number = MAX_SLUG_LENGTH): string {
  // Normalize unicode (NFKD) to strip accents: e.g. "Missão" -> "Missao"
  const normalized = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    return 'unnamed-task';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const truncated = normalized.slice(0, maxLength);
  const lastHyphen = truncated.lastIndexOf('-');
  if (lastHyphen > maxLength / 2) {
    return truncated.slice(0, lastHyphen);
  }
  return truncated.replace(/-+$/, '');
}

export interface TaskBranchNameOptions {
  readonly prefix?: 'task' | 'mission' | 'agent' | string;
  readonly identifier?: string;
  readonly title: string;
}

/**
 * Compose a canonical isolated worktree branch name:
 * e.g. `task/F-102-refactor-login-tests` or `mission/review-timeline-display`
 */
export function generateTaskBranchName(options: TaskBranchNameOptions): string {
  const prefix = options.prefix ? slugify(options.prefix, 20) : 'task';
  const idPart = options.identifier ? slugify(options.identifier, 20) : null;
  const titlePart = slugify(options.title, 40);

  const body = idPart ? `${idPart}-${titlePart}` : titlePart;
  const rawBranch = `${prefix}/${body}`.replace(/-+/g, '-').replace(/-$/, '');

  const validation = validateBranchSlug(rawBranch);
  if (!validation.valid) {
    // Fallback guaranteed to be valid
    return `${prefix}/t-${Date.now().toString(36)}`;
  }

  return rawBranch;
}
