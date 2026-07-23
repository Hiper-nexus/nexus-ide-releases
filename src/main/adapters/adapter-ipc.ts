import { ipcMain } from 'electron';
import { ADAPTER_CHANNELS } from '../../shared/channels';
import { listAdapterInfos, rescanAdapterBinaries } from './adapter-registry';

/**
 * Registers the adapter IPC surface.
 *  - adapter:list   (invoke) → AdapterInfo[] for the renderer's adapter picker
 *  - adapter:rescan (invoke) → re-fold PATH + re-probe CLIs (post external install)
 */
export function registerAdapterIpc(): void {
  ipcMain.handle(ADAPTER_CHANNELS.list, () => listAdapterInfos());
  ipcMain.handle(ADAPTER_CHANNELS.rescan, () => rescanAdapterBinaries());
}
