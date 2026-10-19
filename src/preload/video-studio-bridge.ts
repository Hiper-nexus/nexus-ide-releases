/**
 * Preload bridges of the video studio: "Minha voz" (F-1593) and "Vídeos do
 * projeto" (F-1596). Main registers every channel with `handleTrusted`; this
 * file only forwards the calls.
 */
import type { IpcRenderer } from 'electron';
import { VOICE_CLONE_CHANNELS, type VoiceCloneApi } from '../shared/voice-clone-types';
import { MEDIA_BUDGET_CHANNELS, type MediaBudgetApi } from '../shared/media-budget-types';
import {
  VIDEO_STUDIO_CHANNELS,
  type VideoRenderProgressEvent,
  type VideoStudioApi,
} from '../shared/video-studio-types';

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

/** "Vídeos do projeto" (F-1596). */
export function createVideoStudioBridge(ipcRenderer: IpcRenderer): VideoStudioApi {
  return {
    listProjects: () => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.listProjects),
    doctor: () => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.doctor),
    render: (request) => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.render, request),
    cancel: (jobId) => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.cancel, { jobId }),
    exportVideo: (request) => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.exportVideo, request),
    mediaUrl: (path) => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.mediaUrl, { path }),
    reveal: (path) => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.reveal, { path }),
    previewStart: (projectPath) => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.previewStart, { projectPath }),
    previewStop: (id) => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.previewStop, { id }),
    alignRecording: (request) => ipcRenderer.invoke(VIDEO_STUDIO_CHANNELS.alignRecording, request),
    onProgress: (callback) => {
      const listener = (_event: unknown, payload: VideoRenderProgressEvent) => callback(payload);
      ipcRenderer.on(VIDEO_STUDIO_CHANNELS.progress, listener);
      return () => {
        ipcRenderer.removeListener(VIDEO_STUDIO_CHANNELS.progress, listener);
      };
    },
  };
}

/** Teto de gasto de mídia (F-1606). */
export function createMediaBudgetBridge(ipcRenderer: IpcRenderer): MediaBudgetApi {
  return {
    get: () => ipcRenderer.invoke(MEDIA_BUDGET_CHANNELS.get),
    set: (limits) => ipcRenderer.invoke(MEDIA_BUDGET_CHANNELS.set, limits),
  };
}
