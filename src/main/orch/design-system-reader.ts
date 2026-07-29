import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Workspace DESIGN.md reader (VISUAL-EDIT-001).
 *
 * DESIGN.md is a convention introduced by Google Stitch: a plain-text design
 * system document (the visual counterpart to AGENTS.md) that lives at the
 * project root and tells design/coding agents how the UI should look. This
 * reader makes Nexus design mode compatible with that convention and with the
 * curated collection at https://github.com/VoltAgent/awesome-design-md (MIT):
 * drop any site's DESIGN.md into the project root and the design-mode agent
 * prompt automatically picks it up as trusted design-system context.
 *
 * Also reads `.context/docs/design-system.md` (Dembrandt extract / designmd.ai
 * import apply target) when the root DESIGN.md is absent.
 *
 * Returns null when no usable file exists — design mode degrades gracefully
 * to page-derived context only.
 */
export const MAX_DESIGN_SYSTEM_CHARS = 10_000;

const DESIGN_SYSTEM_CANDIDATES = [
  'DESIGN.md',
  '.context/docs/design-system.md',
] as const;

function readCandidate(rootDir: string, relativePath: string): string | null {
  const filePath = join(rootDir, relativePath);
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  if (!content.trim()) return null;
  if (content.length <= MAX_DESIGN_SYSTEM_CHARS) return content;
  return (
    content.slice(0, MAX_DESIGN_SYSTEM_CHARS) +
    '\n\n[truncated]'
  );
}

export function readWorkspaceDesignSystem(rootDir?: string): string | null {
  if (!rootDir) return null;
  for (const relativePath of DESIGN_SYSTEM_CANDIDATES) {
    const content = readCandidate(rootDir, relativePath);
    if (content) return content;
  }
  return null;
}
