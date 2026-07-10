import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Per-project opt-in for deterministic write-back (VISUAL-EDIT-001, F3).
 * Lives in `.nexus/design.json` so the choice travels with the repo across
 * machines (requisito multi-PC, spec §5.1.4). Disabled is the hard default:
 * L3 instrumentation writes ephemeral attributes into the user's files during
 * the session, so it must never turn itself on.
 */

export interface DesignWritebackConfig {
  enabled: boolean;
  styleMode: 'tailwind' | 'inline';
}

const DEFAULTS: DesignWritebackConfig = { enabled: false, styleMode: 'tailwind' };
const MAX_CONFIG_BYTES = 64 * 1024;

const configSchema = z.object({
  writeBack: z
    .object({
      enabled: z.boolean().optional(),
      styleMode: z.enum(['tailwind', 'inline']).optional(),
    })
    .loose()
    .optional(),
});

export function loadDesignWritebackConfig(rootDir: string): DesignWritebackConfig {
  let descriptor: number | undefined;
  let raw: string;
  try {
    const canonicalRoot = fs.realpathSync(rootDir);
    const nexusDir = path.join(canonicalRoot, '.nexus');
    const nexusMetadata = fs.lstatSync(nexusDir);
    if (nexusMetadata.isSymbolicLink() || !nexusMetadata.isDirectory()) {
      return { ...DEFAULTS };
    }
    const configPath = path.join(nexusDir, 'design.json');
    const before = fs.lstatSync(configPath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size > MAX_CONFIG_BYTES
    ) {
      return { ...DEFAULTS };
    }
    descriptor = fs.openSync(
      configPath,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    const realConfig = fs.realpathSync(configPath);
    const relative = path.relative(canonicalRoot, realConfig);
    if (
      !opened.isFile() ||
      opened.size > MAX_CONFIG_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return { ...DEFAULTS };
    }
    raw = fs.readFileSync(descriptor, 'utf8');
  } catch {
    return { ...DEFAULTS };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { ...DEFAULTS };
    return {
      enabled: parsed.data.writeBack?.enabled === true,
      styleMode: parsed.data.writeBack?.styleMode ?? DEFAULTS.styleMode,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
