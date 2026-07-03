import { ipcMain } from 'electron';
import { LAYOUT_CHANNELS } from '../../shared/channels';
import { workspaceLayoutSchema } from '../../shared/ipc';
import { saveLayout, loadLayout } from './layout-store';

/** Registers the layout persistence IPC surface (validated at the boundary). */
export function registerLayoutIpc(): void {
  ipcMain.handle(LAYOUT_CHANNELS.save, (_event, raw) => {
    const parsed = workspaceLayoutSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false };
    }
    return saveLayout(parsed.data);
  });

  ipcMain.handle(LAYOUT_CHANNELS.load, () => loadLayout());
}
