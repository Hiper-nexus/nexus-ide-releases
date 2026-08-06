import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory } from './cli-mcp-session-artifacts';
import { ensureSkillsForCli, type SkillMirrorResult } from './skill-mirror';

export function mirrorGovernedSkills(
  adapterId: string,
  home: string,
  targetDirs: readonly string[],
  allowedSkills: readonly string[],
  allowedTools: readonly string[] | null = [],
): void {
  for (const targetDir of targetDirs) ensurePrivateDirectory(targetDir);
  ensureSkillsForCli(adapterId, {
    home,
    allowedSkills: [...allowedSkills],
    allowedTools: allowedTools === null ? null : [...allowedTools],
    targetDirs: [...targetDirs],
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
