import { ipcMain } from 'electron';
import { z } from 'zod';
import { LAYOUT_CHANNELS } from '../../shared/channels';
import { workspaceLayoutSchema } from '../../shared/ipc';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedLayoutStore } from './layout-store';
import { requireRendererWorkspaceScope } from './renderer-workspace-scope';
import { onIpcGuarded } from '../runtime/git-ipc-guard';

const workspacePathSchema = z.string().min(1).max(4_096);

const saveRequestSchema = z
  .object({
    workspacePath: workspacePathSchema,
    layout: workspaceLayoutSchema,
  })
  .strict();

const loadRequestSchema = z
  .object({ workspacePath: workspacePathSchema })
  .strict();

function assertWorkspaceIntent(
  scope: ProjectExecutionScope,
  workspacePath: string,
): void {
  if (workspacePath !== scope.rootRealPath) {
    throw new Error('workspace request does not match renderer scope');
  }
}

/**
 * Registers scope-authorized layout persistence. `workspacePath` is retained
 * only as a validated legacy/display field; sender scope selects the DB.
 */
export function registerLayoutIpc(
  runtimeManager: ProjectRuntimeManager,
): void {
  ipcMain.handle(LAYOUT_CHANNELS.save, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = saveRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    assertWorkspaceIntent(scope, parsed.data.workspacePath);
    createScopedLayoutStore(runtimeManager, scope).save(parsed.data.layout);
    return { ok: true };
  });

  onIpcGuarded(LAYOUT_CHANNELS.saveSync, (event, raw) => {
    try {
      const scope = requireRendererWorkspaceScope(event.sender);
      const parsed = saveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        event.returnValue = false;
        return;
      }
      assertWorkspaceIntent(scope, parsed.data.workspacePath);
      createScopedLayoutStore(runtimeManager, scope).save(parsed.data.layout);
      event.returnValue = true;
    } catch {
      event.returnValue = false;
    }
  });

  ipcMain.handle(LAYOUT_CHANNELS.load, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = loadRequestSchema.safeParse(raw);
    if (!parsed.success) return null;
    assertWorkspaceIntent(scope, parsed.data.workspacePath);
    return createScopedLayoutStore(runtimeManager, scope).load()?.layout ?? null;
  });
}
