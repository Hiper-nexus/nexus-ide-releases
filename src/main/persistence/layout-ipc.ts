import { ipcMain } from 'electron';
import { z } from 'zod';
import { LAYOUT_CHANNELS } from '../../shared/channels';
import { workspaceLayoutSchema } from '../../shared/ipc';
import { saveLayout, loadLayout } from './layout-store';

const workspacePathSchema = z.string().min(1).max(4096);

const saveRequestSchema = z.object({
  workspacePath: workspacePathSchema,
  layout: workspaceLayoutSchema,
});

const loadRequestSchema = z.object({ workspacePath: workspacePathSchema });

/** Registers the layout persistence IPC surface (validated at the boundary). */
export function registerLayoutIpc(): void {
  ipcMain.handle(LAYOUT_CHANNELS.save, (_event, raw) => {
    const parsed = saveRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false };
    }
    return saveLayout(parsed.data.workspacePath, parsed.data.layout);
  });

  ipcMain.handle(LAYOUT_CHANNELS.load, (_event, raw) => {
    const parsed = loadRequestSchema.safeParse(raw);
    if (!parsed.success) return null;
    return loadLayout(parsed.data.workspacePath);
  });
}
