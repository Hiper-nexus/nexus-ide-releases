import path from 'node:path';
import { ensurePrivateDirectory } from './cli-mcp-session-artifacts';
import { ensureSkillsForCli } from './skill-mirror';

export function mirrorGovernedSkills(
  adapterId: string,
  home: string,
  targetDirs: readonly string[],
  allowedSkills: readonly string[],
): void {
  for (const targetDir of targetDirs) ensurePrivateDirectory(targetDir);
  ensureSkillsForCli(adapterId, {
    home,
    allowedSkills: [...allowedSkills],
    targetDirs: [...targetDirs],
    includeCliTarget: false,
  });
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
