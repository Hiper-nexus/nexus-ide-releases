import type { VideoExportPresetId, PublishChecklistItem } from './video-export-presets';

/**
 * Estúdio de Mídia → "Vídeos do projeto" (F-1596). Main ↔ renderer contracts.
 * Every channel is registered with `handleTrusted`; paths travel as
 * workspace-relative POSIX strings and Main resolves them inside the open
 * workspace again on every call.
 */

export const VIDEO_STUDIO_CHANNELS = {
  listProjects: 'videoStudio:listProjects',
  doctor: 'videoStudio:doctor',
  render: 'videoStudio:render',
  cancel: 'videoStudio:cancel',
  exportVideo: 'videoStudio:export',
  mediaUrl: 'videoStudio:mediaUrl',
  reveal: 'videoStudio:reveal',
  progress: 'videoStudio:progress',
  previewStart: 'videoStudio:previewStart',
  previewStop: 'videoStudio:previewStop',
  alignRecording: 'videoStudio:alignRecording',
} as const;

export interface VideoFileInfo {
  /** Workspace-relative POSIX path. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
}

export interface VideoProjectInfo {
  readonly name: string;
  /** Workspace-relative POSIX path of the project folder ('.' for the root). */
  readonly path: string;
  readonly engine: 'hyperframes' | 'remotion';
  readonly renders: readonly VideoFileInfo[];
  readonly exports: readonly VideoFileInfo[];
  readonly hasNarration: boolean;
  readonly hasMusic: boolean;
  /** Live HyperFrames Studio of this project, when one is open (F-1603). */
  readonly preview?: { readonly id: string; readonly url: string };
}

export type VideoStudioListResult =
  | { readonly ok: true; readonly projects: readonly VideoProjectInfo[] }
  | { readonly ok: false; readonly error: string };

export interface VideoDoctorCheckView {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly fix?: string;
}

export type VideoDoctorView =
  | { readonly ok: boolean; readonly engineVersion: string; readonly checks: readonly VideoDoctorCheckView[] }
  | { readonly ok: false; readonly error: string };

export interface VideoRenderStart {
  readonly projectPath: string;
  readonly quality: 'draft' | 'final';
  /** Renderer-generated id so cancel/progress can address this job. */
  readonly jobId: string;
}

export interface VideoRenderProgressEvent {
  readonly jobId: string;
  readonly pct: number;
  readonly stage: string | null;
}

export type VideoRenderView =
  | {
      readonly ok: true;
      readonly path: string;
      readonly durationSec: number | null;
      readonly width: number;
      readonly height: number;
      readonly renderMs: number;
      readonly networkAccess: readonly string[];
    }
  | { readonly ok: false; readonly error: string; readonly canceled?: boolean; readonly log?: readonly string[] };

export interface VideoExportStart {
  readonly inputPath: string;
  readonly preset: VideoExportPresetId;
  readonly label: 'auto' | 'on' | 'off';
  readonly jobId: string;
}

export type VideoExportView =
  | {
      readonly ok: true;
      readonly files: Readonly<Record<string, string>>;
      readonly loudness: { readonly integratedLufs: number; readonly truePeakDb: number | null; readonly withinTarget: boolean } | null;
      readonly label: { readonly burned: boolean; readonly reason: string };
      readonly aspectMismatch: boolean;
      readonly publishChecklist: readonly PublishChecklistItem[];
    }
  | { readonly ok: false; readonly error: string; readonly canceled?: boolean; readonly log?: readonly string[] };

export interface VideoStudioApi {
  listProjects(): Promise<VideoStudioListResult>;
  doctor(): Promise<VideoDoctorView>;
  render(request: VideoRenderStart): Promise<VideoRenderView>;
  cancel(jobId: string): Promise<{ ok: true }>;
  exportVideo(request: VideoExportStart): Promise<VideoExportView>;
  /** Short-lived `nexus-media://` URL for the player (Range-capable, workspace only). */
  mediaUrl(path: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  reveal(path: string): Promise<{ ok: boolean; error?: string }>;
  onProgress(callback: (event: VideoRenderProgressEvent) => void): () => void;
  /** Live Studio (F-1603); the url is a trusted Nexus preview for the browser pane. */
  previewStart(projectPath: string): Promise<VideoPreviewView>;
  previewStop(id: string): Promise<{ ok: boolean }>;
  /** F-1602: saves the recorded narration in <project>/assets and aligns the script to it. */
  alignRecording(request: NarrationAlignRequest): Promise<NarrationAlignView>;
}

export interface NarrationAlignRequest {
  readonly projectPath: string;
  readonly script: string;
  /** Fresh recording (mono PCM16 WAV) … */
  readonly wav?: Uint8Array;
  /** … or the recording a previous call already saved (retry after the model OK). */
  readonly audioPath?: string;
  readonly engine: 'elevenlabs' | 'local';
  readonly allowModelDownload?: boolean;
}

export type NarrationAlignView =
  | {
      readonly ok: true;
      readonly audioPath: string;
      readonly words: number;
      readonly matchedRatio: number;
      readonly costUsd: number;
      readonly warnings: readonly string[];
      readonly files: readonly string[];
    }
  | { readonly ok: false; readonly error: string; readonly audioPath?: string; readonly needsModelDownload?: boolean };

export type VideoPreviewView =
  | { readonly ok: true; readonly id: string; readonly url: string; readonly reused: boolean }
  | { readonly ok: false; readonly error: string; readonly log?: readonly string[] };
