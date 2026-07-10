import { ipcMain } from 'electron';
import { z } from 'zod';
import { MEDIA_CHANNELS, type MediaUsageTotals } from '../../shared/media-types';
import { listMediaProviders } from './media-providers';
import { hasMediaKey, maskedMediaKey, setMediaKey } from './media-keys';
import { createScopedMediaUsageStore } from '../usage/media-usage-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';

/**
 * Renderer-facing IPC for media generation providers: list (with masked key
 * previews), key management and accumulated generation cost. The raw key
 * never travels to the renderer.
 */

const setKeySchema = z.object({
  providerId: z.enum([
    'google-image',
    'openai-image',
    'replicate-video',
    'elevenlabs',
  ]),
  /** Empty string clears the stored key. */
  key: z.string().max(512),
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

  ipcMain.handle(
    MEDIA_CHANNELS.usageTotals,
    (event): MediaUsageTotals =>
      createScopedMediaUsageStore(
        runtimeManager,
        requireRendererWorkspaceScope(event.sender),
      ).totals(),
  );
}
