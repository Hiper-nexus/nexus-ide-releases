import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  MEDIA_CHANNELS,
  MEDIA_NO_PROJECT_ERROR,
  MEDIA_PROVIDER_IDS,
  type MediaArtifactInfo,
  type MediaPromptWriteResponse,
  type MediaStudioResponse,
  type MediaUsageTotals,
} from '../../shared/media-types';
import {
  listMediaProviders,
  MediaProviderUnavailableError,
} from './media-providers';
import { MediaProviderHttpError } from './media-errors';
import { hasMediaKey, maskedMediaKey, setMediaKey } from './media-keys';
import {
  generateImage,
  generateVideo,
  MediaAbortError,
  MediaJobTimeoutError,
} from './media-generation';
import { resolveMediaOutputPath } from './media-path-policy';
import { handleTrusted } from '../security/trusted-ipc';
import {
  MEDIA_PROMPT_WRITER_MAX_INPUT,
  writeMediaPrompt,
} from './media-prompt-writer';
import { estimateMediaToolUsd, reserveMediaSpend } from './media-budget';
import { createScopedMediaUsageStore } from '../usage/media-usage-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  getRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import { sameProjectScope } from '../orch/project-scoped-broadcast';

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
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- ver o docblock: media-usage-recorder arrasta usage-service e Electron
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
  referenceImagePaths: z.array(z.string().min(1).max(4096)).max(30).optional(),
  referenceVideoPaths: z.array(z.string().min(1).max(4096)).max(10).optional(),
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

const writePromptSchema = z.object({
  text: z.string().max(MEDIA_PROMPT_WRITER_MAX_INPUT),
  task: z.enum(['scene', 'product']),
  kind: z.enum(['video', 'image']).optional(),
  style: z.string().max(2_000).optional(),
  durationSec: z.number().int().min(1).max(600).optional(),
  format: z.string().max(200).optional(),
});

export function registerMediaIpc(runtimeManager: ProjectRuntimeManager): void {
  ipcMain.handle(MEDIA_CHANNELS.listProviders, () =>
    listMediaProviders(hasMediaKey, maskedMediaKey),
  );

  ipcMain.handle(MEDIA_CHANNELS.setKey, (_e, raw) => {
    const parsed = setKeySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    return setMediaKey(parsed.data.providerId, parsed.data.key);
  });

  // F-1589: chaves e provedores são globais; só totais, galeria e geração
  // pertencem ao projeto. Sem projeto aberto a resposta diz isso (null), em
  // vez de lançar e derrubar a tela inteira de Serviços de mídia.
  ipcMain.handle(MEDIA_CHANNELS.usageTotals, (event): MediaUsageTotals | null => {
    const scope = getRendererWorkspaceScope(event.sender);
    return scope ? createScopedMediaUsageStore(runtimeManager, scope).totals() : null;
  });

  ipcMain.handle(
    MEDIA_CHANNELS.generate,
    async (event, raw): Promise<MediaStudioResponse> => {
      const parsed = studioRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'payload inválido' };
      const req = parsed.data;
      const scope = getRendererWorkspaceScope(event.sender);
      if (!scope) return { ok: false, error: MEDIA_NO_PROJECT_ERROR };
      // F-1606: the media spend cap also holds for the Estúdio's own Gerar.
      const spend = reserveMediaSpend(
        estimateMediaToolUsd(
          req.kind === 'image' ? 'image_generate' : 'video_generate',
          {
            provider: req.providerId,
            model: req.model,
            durationSeconds: req.durationSeconds,
            resolution: req.resolution,
            recoverJobId: req.recoverJobId,
          },
          hasMediaKey,
        ),
        null,
        'media-studio',
      );
      if (!spend.ok) return { ok: false, error: spend.error };
      const controller = new AbortController();
      const jobKey = studioJobKey(event.sender.id, req.clientJobId);
      studioJobs.set(jobKey, controller);
      const assertStudioAuthority = (): void => {
        if (controller.signal.aborted) throw new MediaAbortError();
        try {
          const current = requireRendererWorkspaceScope(event.sender);
          if (!sameProjectScope(current, scope)) {
            controller.abort();
            throw new MediaAbortError();
          }
        } catch (error) {
          controller.abort();
          if (error instanceof MediaAbortError) throw error;
          throw new MediaAbortError();
        }
      };
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
                referenceImagePaths: req.referenceImagePaths,
                baseDir,
                signal: controller.signal,
                assertCurrentAuthority: assertStudioAuthority,
              })
            : await generateVideo({
                prompt: req.prompt,
                provider: req.providerId,
                model: req.model,
                aspectRatio: req.aspectRatio,
                durationSeconds: req.durationSeconds,
                resolution: req.resolution,
                imagePath: req.imagePath,
                referenceImagePaths: req.referenceImagePaths,
                referenceVideoPaths: req.referenceVideoPaths,
                recoverJobId: req.recoverJobId,
                baseDir,
                signal: controller.signal,
                assertCurrentAuthority: assertStudioAuthority,
              });
        spend.settle(result.estimatedCostUsd);
        assertStudioAuthority();
        const artifactId = await recordStudioUsage(
          result,
          {
            agentName: 'media-studio',
            label: 'Estúdio de Mídia',
            scope,
          },
          {
            signal: controller.signal,
            assertCurrentAuthority: assertStudioAuthority,
          },
        );
        assertStudioAuthority();
        return { ...result, artifactId };
      } catch (err) {
        // A timed-out job keeps running at the provider: its cost stays reserved.
        if (err instanceof MediaJobTimeoutError) spend.settle();
        else spend.release();
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
          ...(err instanceof MediaProviderHttpError
            ? { errorKind: err.kind }
            : err instanceof MediaProviderUnavailableError
              ? { errorKind: 'key' as const }
              : {}),
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

  ipcMain.handle(MEDIA_CHANNELS.listArtifacts, (event): MediaArtifactInfo[] | null => {
    const scope = getRendererWorkspaceScope(event.sender);
    return scope ? createScopedMediaUsageStore(runtimeManager, scope).listRecent(60) : null;
  });

  ipcMain.handle(MEDIA_CHANNELS.revealArtifact, (event, raw) => {
    const parsed = storageKeyPayload.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    const scope = getRendererWorkspaceScope(event.sender);
    if (!scope) return { ok: false, error: MEDIA_NO_PROJECT_ERROR };
    const abs = resolveMediaOutputPath(
      parsed.data.storageKey,
      scope.rootRealPath,
    );
    shell.showItemInFolder(abs);
    return { ok: true };
  });

  /**
   * "Escrever meu pedido" (21/10/2026). Fail-open por contrato: qualquer
   * problema — payload inválido, sem chave, timeout, JSON ruim — devolve o
   * texto que chegou, com o motivo. O Estúdio nunca perde o que a pessoa
   * escreveu ou ditou. Não toca em arquivo nem precisa de projeto aberto:
   * é só texto entrando e saindo. Canal novo, então `handleTrusted`:
   * só a janela principal registrada chega aqui.
   */
  handleTrusted(MEDIA_CHANNELS.writePrompt, async (_event, raw): Promise<MediaPromptWriteResponse> => {
    const parsed = writePromptSchema.safeParse(raw);
    if (!parsed.success) {
      const text = typeof (raw as { text?: unknown })?.text === 'string' ? (raw as { text: string }).text : '';
      return { text, written: false, reason: 'payload inválido' };
    }
    const { text, task, ...context } = parsed.data;
    return writeMediaPrompt(text, task, context);
  });

  ipcMain.handle(MEDIA_CHANNELS.readArtifactDataUrl, async (event, raw) => {
    const parsed = storageKeyPayload.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    const scope = getRendererWorkspaceScope(event.sender);
    if (!scope) return { ok: false, error: MEDIA_NO_PROJECT_ERROR };
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
