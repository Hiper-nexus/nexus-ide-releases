import { ipcMain } from 'electron';
import { ADAPTER_CHANNELS } from '../../shared/channels';
import { listAdapterInfos } from './adapter-registry';

/**
 * Registers the adapter IPC surface.
 *  - adapter:list  (invoke)  → AdapterInfo[] for the renderer's adapter picker
 */
export function registerAdapterIpc(): void {
  ipcMain.handle(ADAPTER_CHANNELS.list, () => listAdapterInfos());
}
