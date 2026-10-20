/**
 * Preload bridge das referências do Estúdio de Mídia (F-1611).
 */
import type { IpcRenderer } from 'electron';
import {
  MEDIA_REFERENCE_CHANNELS,
  type MediaReferencesApi,
} from '../shared/media-reference-types';

export function createMediaReferencesBridge(ipcRenderer: IpcRenderer): MediaReferencesApi {
  return {
    list: () => ipcRenderer.invoke(MEDIA_REFERENCE_CHANNELS.list),
    save: (name: string, data: ArrayBuffer) =>
      ipcRenderer.invoke(MEDIA_REFERENCE_CHANNELS.save, { name, data }),
    remove: (storageKey: string) =>
      ipcRenderer.invoke(MEDIA_REFERENCE_CHANNELS.remove, { storageKey }),
    readDataUrl: (storageKey: string) =>
      ipcRenderer.invoke(MEDIA_REFERENCE_CHANNELS.readDataUrl, { storageKey }),
  };
}
