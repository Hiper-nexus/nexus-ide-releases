import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory } from './cli-mcp-session-artifacts';
import { isHardenedSpawnPolicy } from './gate';
import {
  ensureSkillsForCli,
  linkSkillsDirToCache,
  sharedSkillCacheDir,
  type SkillMirrorResult,
} from './skill-mirror';

/**
 * Mirror skills into a session's PRIVATE overlay directories. F-1157 (doutrina
 * do dono): sem filtro de skill — the overlay receives every installed skill,
 * whatever `allowedSkills` the token recorded. The real provider profile is a
 * different path (`deliverGrantedSkillsToProviderHome`) and stays grant-only.
 *
 * Unsandboxed overlays (Autopilot) link to the shared per-adapter cache
 * instead of copying ~100 skill trees per spawn. A kernel-sandboxed overlay
 * (Hardened, or the private Codex profile even for Pet Studio) only reads
 * inside itself, so it keeps real copies (`linkToSharedCache: false`).
 */
export function mirrorGovernedSkills(
  adapterId: string,
  home: string,
  targetDirs: readonly string[],
  _allowedSkills: readonly string[],
  allowedTools: readonly string[] | null = [],
  options: { readonly linkToSharedCache?: boolean } = {},
): void {
  const linkToSharedCache = options.linkToSharedCache ?? !isHardenedSpawnPolicy();
  let copyTargets = targetDirs;
  if (linkToSharedCache) {
    const cacheDir = sharedSkillCacheDir(adapterId, home);
    copyTargets = targetDirs.filter((targetDir) => {
      ensurePrivateDirectory(path.dirname(targetDir));
      return !linkSkillsDirToCache(targetDir, cacheDir);
    });
    if (copyTargets.length === 0) return;
  }
  for (const targetDir of copyTargets) ensurePrivateDirectory(targetDir);
  ensureSkillsForCli(adapterId, {
    home,
    allowedSkills: null,
    allowedTools: allowedTools === null ? null : [...allowedTools],
    targetDirs: [...copyTargets],
    includeCliTarget: false,
  });
}

/**
 * Deliver the skills a session was GRANTED into the provider profile the
 * process actually reads, for the lanes that take no private overlay (the
 * default operator-choice mode never builds Codex's private CODEX_HOME, so
 * `mirrorGovernedSkills` never runs and the grant reaches nothing).
 *
 * This closes a delivery gap; it never widens authority:
 *  - only the explicitly granted names are materialized — the logical
 *    `null = open` gate resolves to an empty list here, exactly like
 *    `resolveGovernedCliProfile`, so an open gate never means "inherit every
 *    executable extension";
 *  - copies are non-destructive: a skill already present in the profile wins,
 *    so the user's own version is never overwritten;
 *  - the target directory keeps its ordinary permissions — this is the user's
 *    real profile, not a private artifact dir;
 *  - every copy is MARKED (see below), so what Nexus put there can always be
 *    told apart from what the user installed, and removed.
 */
export function deliverGrantedSkillsToProviderHome(
  adapterId: string,
  home: string,
  providerSkillsDir: string,
  allowedSkills: readonly string[],
  allowedTools: readonly string[] | null = [],
): SkillMirrorResult {
  if (allowedSkills.length === 0) {
    return {
      mirrored: 0,
      targetDirs: [],
      copied: [],
      pluginReductions: [],
      pluginFailures: [],
    };
  }
  const result = ensureSkillsForCli(adapterId, {
    home,
    allowedSkills: [...allowedSkills],
    allowedTools: allowedTools === null ? null : [...allowedTools],
    targetDirs: [providerSkillsDir],
    includeCliTarget: false,
  });
  for (const skill of result.copied) {
    markNexusDeliveredSkill(adapterId, skill.targetDir, skill.name);
  }
  return result;
}

/**
 * Marker written INSIDE each skill directory Nexus materialized in a real
 * provider profile (`~/.codex/skills/<skill>/`).
 *
 * Why it has to exist: this delivery is permanent and lands in the profile the
 * user's own, non-Nexus sessions read. Without a marker there is no way to tell
 * a Nexus copy from a skill the user installed himself, so the copies could
 * never be safely removed — and this repository's history already includes one
 * provider profile corrupting another. The marker is per skill, never
 * repository-wide, and is only written for directories THIS call created:
 * `copySkill` is non-destructive, so an existing skill is never touched and
 * never claimed.
 */
export const NEXUS_DELIVERED_SKILL_MARKER = '.nexus-delivered.json';

function markNexusDeliveredSkill(
  adapterId: string,
  targetDir: string,
  skill: string,
): void {
  const marker = path.join(targetDir, skill, NEXUS_DELIVERED_SKILL_MARKER);
  fs.writeFileSync(
    marker,
    `${JSON.stringify(
      {
        deliveredBy: 'nexus',
        adapterId,
        skill,
        deliveredAt: new Date().toISOString(),
        note:
          'Materialized by Nexus for a governed session. Safe to delete ' +
          'together with this skill directory; Nexus will re-deliver it when ' +
          'a session is granted the skill again.',
      },
      null,
      2,
    )}\n`,
  );
}

/** Skills in `dir` that Nexus materialized — the reverse of the delivery. */
export function listNexusDeliveredSkills(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(
          path.join(dir, entry.name, NEXUS_DELIVERED_SKILL_MARKER),
        ),
    )
    .map((entry) => entry.name)
    .sort();
}

export function governedWorkspaceTiers(
  cwd: string | undefined,
  workspaceRoot: string | undefined,
): string[] {
  if (!cwd) return [];
  const current = path.resolve(cwd);
  const root = path.resolve(workspaceRoot ?? current);
  const relative = path.relative(root, current);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [];
  const tiers: string[] = [];
  let cursor = current;
  for (;;) {
    tiers.push(cursor);
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) return [];
    cursor = parent;
  }
  return tiers;
}
