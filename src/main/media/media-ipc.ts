import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  MEDIA_CHANNELS,
  MEDIA_PROVIDER_IDS,
  type MediaArtifactInfo,
  type MediaStudioResponse,
  type MediaUsageTotals,
} from '../../shared/media-types';
import { listMediaProviders } from './media-providers';
import { hasMediaKey, maskedMediaKey, setMediaKey } from './media-keys';
import {
  generateImage,
  generateVideo,
  MediaAbortError,
  MediaJobTimeoutError,
} from './media-generation';
import { resolveMediaOutputPath } from './media-path-policy';
import { createScopedMediaUsageStore } from '../usage/media-usage-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';

/**
 * Lazy require: media-usage-recorder pulls in usage-service/gamification
 * (electron-touching). Deferring keeps this module importable in unit tests
 * and matches the defaultMediaDeps pattern in media-generation.ts.
 */
function recordStudioUsage(
  ...args: Parameters<
    (typeof import('../usage/media-usage-recorder'))['recordMediaUsage']
  >
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { recordMediaUsage } =
    require('../usage/media-usage-recorder') as typeof import('../usage/media-usage-recorder');
  return recordMediaUsage(...args);
}

/**
 * Renderer-facing IPC for media generation providers: list (with masked key
 * previews), key management, accumulated generation cost — plus the Estúdio
 * de Mídia channels (generate/cancel/gallery) that let layman users generate
 * without an agent in the loop. The raw key never travels to the renderer.
 */

const setKeySchema = z.object({
  providerId: z.enum(MEDIA_PROVIDER_IDS),
  /** Empty string clears the stored key. */
  key: z.string().max(512),
});

const studioRequestSchema = z.object({
  kind: z.enum(['image', 'video']),
  prompt: z.string().min(1).max(4000),
  providerId: z.enum(MEDIA_PROVIDER_IDS).optional(),
  model: z.string().max(256).optional(),
  aspectRatio: z.string().max(16).optional(),
  size: z.string().max(8).optional(),
  durationSeconds: z.number().int().min(1).max(60).optional(),
  resolution: z.string().max(16).optional(),
  imagePath: z.string().max(4096).optional(),
  recoverJobId: z.string().max(512).optional(),
  clientJobId: z.string().min(1).max(64),
});

const storageKeyPayload = z.object({
  storageKey: z.string().min(1).max(4096),
});

/** Live Estúdio generations, keyed per-renderer so panels cannot cross-abort. */
const studioJobs = new Map<string, AbortController>();

function studioJobKey(webContentsId: number, clientJobId: string): string {
  return `${webContentsId}:${clientJobId}`;
}

/** Preview is inline base64 — cap it so a 200MB mp4 never crosses IPC. */
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;
const PREVIEW_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function registerMediaIpc(runtimeManager: ProjectRuntimeManager): void {
  ipcMain.handle(MEDIA_CHANNELS.listProviders, () =>
    listMediaProviders(hasMediaKey, maskedMediaKey),
  );

  ipcMain.handle(MEDIA_CHANNELS.setKey, (_e, raw) => {
    const parsed = setKeySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    return setMediaKey(parsed.data.providerId, parsed.data.key);
  });

  ipcMain.handle(
    MEDIA_CHANNELS.usageTotals,
    (event): MediaUsageTotals =>
      createScopedMediaUsageStore(
        runtimeManager,
        requireRendererWorkspaceScope(event.sender),
      ).totals(),
  );

  ipcMain.handle(
    MEDIA_CHANNELS.generate,
    async (event, raw): Promise<MediaStudioResponse> => {
      const parsed = studioRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'payload inválido' };
      const req = parsed.data;
      const scope = requireRendererWorkspaceScope(event.sender);
      const controller = new AbortController();
      const jobKey = studioJobKey(event.sender.id, req.clientJobId);
      studioJobs.set(jobKey, controller);
      try {
        const baseDir = scope.rootRealPath;
        const result =
          req.kind === 'image'
            ? await generateImage({
                prompt: req.prompt,
                provider: req.providerId,
                model: req.model,
                aspectRatio: req.aspectRatio,
                size: req.size,
                imagePath: req.imagePath,
                baseDir,
                signal: controller.signal,
              })
            : await generateVideo({
                prompt: req.prompt,
                provider: req.providerId,
                model: req.model,
                aspectRatio: req.aspectRatio,
                durationSeconds: req.durationSeconds,
                resolution: req.resolution,
                imagePath: req.imagePath,
                recoverJobId: req.recoverJobId,
                baseDir,
                signal: controller.signal,
              });
        await recordStudioUsage(result, {
          agentName: 'media-studio',
          label: 'Estúdio de Mídia',
          scope,
        });
        return result;
      } catch (err) {
        if (err instanceof MediaAbortError) {
          return { ok: false, error: 'geração cancelada', canceled: true };
        }
        if (err instanceof MediaJobTimeoutError) {
          return {
            ok: false,
            error: err.message,
            ...(err.recoverable ? { recoverJobId: err.jobId } : {}),
          };
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        studioJobs.delete(jobKey);
      }
    },
  );

  ipcMain.handle(MEDIA_CHANNELS.cancelGenerate, (event, raw) => {
    const parsed = z
      .object({ clientJobId: z.string().min(1).max(64) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false };
    studioJobs
      .get(studioJobKey(event.sender.id, parsed.data.clientJobId))
      ?.abort();
    return { ok: true };
  });

  ipcMain.handle(
    MEDIA_CHANNELS.listArtifacts,
    (event): MediaArtifactInfo[] =>
      createScopedMediaUsageStore(
        runtimeManager,
        requireRendererWorkspaceScope(event.sender),
      ).listRecent(60),
  );

  ipcMain.handle(MEDIA_CHANNELS.revealArtifact, (event, raw) => {
    const parsed = storageKeyPayload.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    const scope = requireRendererWorkspaceScope(event.sender);
    const abs = resolveMediaOutputPath(
      parsed.data.storageKey,
      scope.rootRealPath,
    );
    shell.showItemInFolder(abs);
    return { ok: true };
  });

  ipcMain.handle(MEDIA_CHANNELS.readArtifactDataUrl, async (event, raw) => {
    const parsed = storageKeyPayload.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    const scope = requireRendererWorkspaceScope(event.sender);
    const abs = resolveMediaOutputPath(
      parsed.data.storageKey,
      scope.rootRealPath,
    );
    const mime = PREVIEW_MIME_BY_EXT[path.extname(abs).toLowerCase()];
    if (!mime) {
      return { ok: false, error: 'tipo sem preview — abra no Finder' };
    }
    try {
      const stat = await fs.promises.stat(abs);
      if (stat.size > MAX_PREVIEW_BYTES) {
        return { ok: false, error: 'arquivo grande demais para preview' };
      }
      const data = await fs.promises.readFile(abs);
      return {
        ok: true,
        dataUrl: `data:${mime};base64,${data.toString('base64')}`,
      };
    } catch {
      return { ok: false, error: 'arquivo não encontrado no workspace' };
    }
  });
}
