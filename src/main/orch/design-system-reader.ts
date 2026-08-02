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
 * import apply target, and what the context bootstrap autopilot materializes)
 * when the root DESIGN.md is absent.
 *
 * Returns null when no usable file exists — design mode degrades gracefully
 * to page-derived context only.
 *
 * THIS IS THE ONLY PLACE THAT ANSWERS "where is the design contract?".
 * A design contract has two legitimate homes — the hand-authored root
 * convention and the reviewed ContextDraft target — so no consumer may hardcode
 * a filename. A prompt that names one path while the workspace uses the other
 * sends the agent to a file that does not exist, and an agent that cannot read
 * the contract proceeds on its own defaults.
 */
export const MAX_DESIGN_SYSTEM_CHARS = 10_000;

/**
 * Resolution order is authority order: a human-authored root DESIGN.md
 * outranks a materialized/imported contract under `.context/docs`.
 */
export const DESIGN_SYSTEM_CANDIDATE_PATHS = [
  'DESIGN.md',
  '.context/docs/design-system.md',
] as const;

export interface WorkspaceDesignContract {
  /** Workspace-relative path that actually answered — never a guess. */
  readonly path: (typeof DESIGN_SYSTEM_CANDIDATE_PATHS)[number];
  readonly content: string;
}

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

/**
 * Which contract this workspace has, and where. Consumers that must NAME the
 * file to an agent (task prompt, reviewer prompt) need the path, not only the
 * bytes: naming a path that did not answer is the whole defect this closes.
 */
export function resolveWorkspaceDesignContract(
  rootDir?: string,
): WorkspaceDesignContract | null {
  if (!rootDir) return null;
  for (const relativePath of DESIGN_SYSTEM_CANDIDATE_PATHS) {
    const content = readCandidate(rootDir, relativePath);
    if (content) return Object.freeze({ path: relativePath, content });
  }
  return null;
}

export function readWorkspaceDesignSystem(rootDir?: string): string | null {
  return resolveWorkspaceDesignContract(rootDir)?.content ?? null;
}
