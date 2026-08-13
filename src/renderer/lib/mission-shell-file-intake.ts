import type { ProductDestination } from '../state/product-navigation-store';
import { normalizeProjectContextPath } from '../state/mission-setup-store';
import {
  classifyMissionAttachment,
  stageMissionAttachment,
} from './mission-attachments';

/**
 * Shell-wide file drop is only for starting or filling the setup wizard.
 * An open pane/mission keeps the event; navigating back to Express was a
 * hijack ("Arquivo fora do projeto" after a live paste/drop).
 */
export function shellClaimsMissionFileDrop(
  destinationKind: ProductDestination['kind'],
): boolean {
  return destinationKind === 'launcher' || destinationKind === 'mission-setup';
}

export function droppedProjectContextPath(
  workspacePath: string,
  file: File,
): string | null {
  const absolutePath = window.nexus.files.pathForFile(file);
  if (!absolutePath) return null;

  const root = workspacePath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const candidate = absolutePath.replaceAll('\\', '/');
  const caseInsensitive = /^[A-Za-z]:\//u.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableCandidate = caseInsensitive
    ? candidate.toLowerCase()
    : candidate;
  const prefix = `${comparableRoot}/`;
  if (!comparableCandidate.startsWith(prefix)) return null;
  return normalizeProjectContextPath(candidate.slice(root.length + 1));
}

export function partitionDroppedMissionFiles(
  workspacePath: string,
  files: readonly File[],
): {
  readonly inProject: string[];
  readonly toImport: File[];
  readonly rejected: File[];
} {
  const inProject: string[] = [];
  const toImport: File[] = [];
  const rejected: File[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const relative = droppedProjectContextPath(workspacePath, file);
    if (relative) {
      if (!seen.has(relative)) {
        seen.add(relative);
        inProject.push(relative);
      }
      continue;
    }
    if (classifyMissionAttachment(file)) {
      toImport.push(file);
      continue;
    }
    rejected.push(file);
  }

  return { inProject, toImport, rejected };
}

/**
 * In-project files stay as relative context. External audio/image/text is
 * copied into `.nexus/attachments/mission-context/` so agents can read it
 * without a sandbox grant on `~/.nexus/dropped`.
 */
export async function resolveDroppedMissionContextPath(
  workspacePath: string | null,
  file: File,
): Promise<string | null> {
  if (workspacePath && workspacePath.length > 0) {
    const relative = droppedProjectContextPath(workspacePath, file);
    if (relative) return relative;
  }
  if (!classifyMissionAttachment(file)) return null;
  try {
    return (await stageMissionAttachment(file)).path;
  } catch {
    return null;
  }
}
