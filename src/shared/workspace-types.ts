import { z } from 'zod';

/**
 * Workspace = the root folder a set of panes/missions operate in (the cwd for
 * new sessions). Mirrors the Overclock onboarding: launch → choose/open a
 * workspace (recent list) → work inside it.
 */

export interface WorkspaceInfo {
  path: string;
  name: string;
  lastOpenedAt: number;
}

export interface WorkspaceState {
  current: WorkspaceInfo | null;
  recents: WorkspaceInfo[];
}

export const openWorkspaceSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const WORKSPACE_CHANNELS = {
  get: 'workspace:get',
  pick: 'workspace:pick',
  open: 'workspace:open',
  close: 'workspace:close',
  remove: 'workspace:remove',
  changed: 'workspace:changed',
} as const;
