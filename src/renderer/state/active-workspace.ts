/**
 * Tiny shared holder for the active workspace root. Kept separate from the
 * workspace store to avoid an import cycle: the layout store reads it when
 * creating panes (so new sessions default their cwd to the workspace), while
 * the workspace store writes it.
 */

let activeWorkspacePath: string | null = null;

export function setActiveWorkspacePath(path: string | null): void {
  activeWorkspacePath = path;
}

export function getActiveWorkspacePath(): string | null {
  return activeWorkspacePath;
}
