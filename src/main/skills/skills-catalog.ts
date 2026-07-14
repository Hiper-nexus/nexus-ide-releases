import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';

/**
 * Skills catalog + project lockfile (BridgeSkills-inspired, clean-room).
 */

export const skillEntrySchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    description: z.string().max(1024).default(''),
    category: z.string().max(64).default('general'),
    phases: z.number().int().min(0).max(64).default(1),
    origin: z.enum(['builtin', 'custom', 'claude', 'codex', 'cursor', 'other']),
    author: z.string().max(128).optional(),
    version: z.string().max(64).default('0.0.0'),
    digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    agents: z.array(z.string().max(64)).max(32).default([]),
    status: z
      .enum(['importable', 'synced', 'drifted', 'builtin'])
      .default('importable'),
    contentPreview: z.string().max(4096).default(''),
    path: z.string().max(4096).optional(),
  })
  .strict();

export type SkillEntry = z.infer<typeof skillEntrySchema>;

export const skillsLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            origin: z.string().min(1).max(64),
            version: z.string().max(64),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();

export type SkillsLock = z.infer<typeof skillsLockSchema>;

export function digestSkillContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Scan a skills directory. Never follows symlinks for skill folders or
 * SKILL.md (avoids reading outside the intended catalog root).
 */
export function scanSkillsDirectory(dir: string): SkillEntry[] {
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.skillsCatalog)) {
    return [];
  }
  if (!fs.existsSync(dir)) return [];
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(dir);
  } catch {
    return [];
  }
  const entries: SkillEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    // Reject path components that could escape when joined.
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      continue;
    }
    const skillDir = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(skillDir);
    } catch {
      continue;
    }
    // Only real directories — skip symlinks (even to directories).
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const md = path.join(skillDir, 'SKILL.md');
    let mdStat: fs.Stats;
    try {
      mdStat = fs.lstatSync(md);
    } catch {
      continue;
    }
    if (mdStat.isSymbolicLink() || !mdStat.isFile()) continue;
    // realpath must stay under the catalog root.
    let mdReal: string;
    try {
      mdReal = fs.realpathSync(md);
    } catch {
      continue;
    }
    const rel = path.relative(rootReal, mdReal);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;

    let content = '';
    try {
      content = fs.readFileSync(mdReal, 'utf8').slice(0, 16_384);
    } catch {
      continue;
    }
    const digest = digestSkillContent(content);
    entries.push(
      skillEntrySchema.parse({
        id: name.toLowerCase(),
        name,
        description: extractDescription(content),
        category: 'custom',
        phases: countPhases(content),
        origin: 'custom',
        version: '0.0.0',
        digest,
        status: 'importable',
        contentPreview: content.slice(0, 512),
        path: mdReal,
      }),
    );
  }
  return entries;
}

function extractDescription(md: string): string {
  const m = /^description:\s*(.+)$/im.exec(md);
  if (m) return m[1].trim().slice(0, 1024);
  const line = md.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  return (line ?? '').trim().slice(0, 1024);
}

function countPhases(md: string): number {
  const matches = md.match(/^##\s+/gm);
  return Math.max(1, Math.min(64, matches?.length ?? 1));
}

export function writeSkillsLock(filePath: string, lock: SkillsLock): void {
  const parsed = skillsLockSchema.parse(lock);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
}

export function readSkillsLock(filePath: string): SkillsLock | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return skillsLockSchema.parse(
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
    );
  } catch {
    return null;
  }
}

export function detectSkillDrift(
  lock: SkillsLock,
  catalog: readonly SkillEntry[],
): string[] {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const drifted: string[] = [];
  for (const row of lock.skills) {
    const cur = byId.get(row.id);
    if (!cur?.digest || cur.digest !== row.digest) drifted.push(row.id);
  }
  return drifted;
}

export function buildLockFromCatalog(
  catalog: readonly SkillEntry[],
): SkillsLock {
  return skillsLockSchema.parse({
    schemaVersion: 1,
    skills: catalog
      .filter((s) => s.digest)
      .map((s) => ({
        id: s.id,
        origin: s.origin,
        version: s.version,
        digest: s.digest!,
      })),
  });
}

/** Uninstall-all with backup of lockfile. */
export function uninstallAllSkillsLock(
  lockPath: string,
): { backupPath: string | null } {
  if (!fs.existsSync(lockPath)) return { backupPath: null };
  const backupPath = `${lockPath}.${Date.now()}.bak`;
  fs.copyFileSync(lockPath, backupPath);
  fs.unlinkSync(lockPath);
  return { backupPath };
}
