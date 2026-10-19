/**
 * Preload bridges of the video studio: "Minha voz" (F-1593). Main registers
 * every channel with `handleTrusted`; this file only forwards the calls.
 */
import type { IpcRenderer } from 'electron';
import { VOICE_CLONE_CHANNELS, type VoiceCloneApi } from '../shared/voice-clone-types';

export function createVoiceCloneBridge(ipcRenderer: IpcRenderer): VoiceCloneApi {
  return {
    list: () => ipcRenderer.invoke(VOICE_CLONE_CHANNELS.list),
    begin: () => ipcRenderer.invoke(VOICE_CLONE_CHANNELS.begin),
    verifyDeclaration: (input) => ipcRenderer.invoke(VOICE_CLONE_CHANNELS.verifyDeclaration, input),
    create: (input) => ipcRenderer.invoke(VOICE_CLONE_CHANNELS.create, input),
    cancel: (sessionId) => ipcRenderer.invoke(VOICE_CLONE_CHANNELS.cancel, { sessionId }),
    remove: (input) => ipcRenderer.invoke(VOICE_CLONE_CHANNELS.remove, input),
  };
}
