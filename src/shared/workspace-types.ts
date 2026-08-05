import { z } from 'zod';

/**
 * Workspace = the root folder a set of panes/missions operate in (the cwd for
 * new sessions). The onboarding flow: launch → choose/open a
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
  pickPath: 'workspace:pickPath',
  open: 'workspace:open',
  close: 'workspace:close',
  remove: 'workspace:remove',
  changed: 'workspace:changed',
} as const;

/**
 * Explicit write-access policy for the workspace.
 *
 * - `default`        read + write inside the workspace root only (current behaviour)
 * - `write_external` read + write inside AND outside the workspace root
 * - `read_only`      reads only — no writes permitted anywhere
 */
export type WorkspacePolicy = 'default' | 'write_external' | 'read_only';

export const WORKSPACE_POLICY_CHANNELS = {
  get: 'workspace:policy:get',
  set: 'workspace:policy:set',
  changed: 'workspace:policy:changed',
} as const;
