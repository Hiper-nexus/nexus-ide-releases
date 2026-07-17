import fs from 'node:fs';
import { dialog, ipcMain, type WebContents } from 'electron';
import { z } from 'zod';
import { GAMIFICATION_CHANNELS } from '../../shared/gamification-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  broadcastToProject,
  sameProjectScope,
} from '../orch/project-scoped-broadcast';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import type { ProjectGamificationService } from './gamification-service';

const selectSkinSchema = z
  .object({
    /** null = default skin. */
    skin: z.string().min(1).max(64).nullable(),
  })
  .strict();

const recordJarvisActionSchema = z
  .object({
    actionType: z.string().min(1).max(64),
    ok: z.boolean(),
  })
  .strict();

const MAX_PROFILE_FILE_BYTES = 50 * 1024 * 1024;
const listeners = new Set<WebContents>();

export function registerGamificationListener(webContents: WebContents): void {
  listeners.add(webContents);
}

export function unregisterGamificationListener(webContents: WebContents): void {
  listeners.delete(webContents);
}

export function broadcastGamificationToProject(
  scope: ProjectExecutionScope,
  channel: string,
  payload?: unknown,
): void {
  broadcastToProject(listeners, scope, channel, payload);
}

function isRendererStillScoped(
  sender: WebContents,
  capturedScope: ProjectExecutionScope,
): boolean {
  return sameProjectScope(
    requireRendererWorkspaceScope(sender),
    capturedScope,
  );
}

const snapshotOptionsSchema = z
  .object({
    rescan: z.boolean().optional(),
  })
  .strict()
  .optional();

/** Every handler derives storage exclusively from its main-owned sender scope. */
export function registerGamificationIpc(
  service: ProjectGamificationService,
): void {
  ipcMain.handle(GAMIFICATION_CHANNELS.snapshot, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = snapshotOptionsSchema.safeParse(raw);
    return service.snapshot(scope, {
      rescan: parsed.success ? parsed.data?.rescan === true : false,
    });
  });

  ipcMain.handle(GAMIFICATION_CHANNELS.selectSkin, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = selectSkinSchema.safeParse(raw);
    if (!parsed.success) return service.snapshot(scope);
    const snapshot = service.snapshot(scope);
    if (
      parsed.data.skin !== null &&
      !snapshot.skins.includes(parsed.data.skin)
    ) {
      return snapshot;
    }
    return service.selectSkin(scope, parsed.data.skin);
  });

  ipcMain.handle(GAMIFICATION_CHANNELS.prestige, (event) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    return service.prestige(scope);
  });

  ipcMain.handle(
    GAMIFICATION_CHANNELS.recordJarvisAction,
    (event, raw) => {
      const scope = requireRendererWorkspaceScope(event.sender);
      const parsed = recordJarvisActionSchema.safeParse(raw);
      if (!parsed.success) return service.snapshot(scope);
      return service.recordJarvisAction(
        scope,
        parsed.data.actionType,
        parsed.data.ok,
      );
    },
  );

  ipcMain.handle(GAMIFICATION_CHANNELS.exportProfile, async (event) => {
    const sender = event.sender;
    const scope = requireRendererWorkspaceScope(sender);
    const data = service.exportProfile(scope);
    const result = await dialog.showSaveDialog({
      title: 'Exportar perfil de Operador',
      defaultPath: 'nexus-operator-profile.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    if (!isRendererStillScoped(sender, scope)) {
      return { ok: false, error: 'O projeto mudou durante a exportação.' };
    }
    try {
      fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2));
      return { ok: true, path: result.filePath };
    } catch {
      return { ok: false, error: 'Falha ao gravar o arquivo.' };
    }
  });

  ipcMain.handle(GAMIFICATION_CHANNELS.importProfile, async (event) => {
    const sender = event.sender;
    const scope = requireRendererWorkspaceScope(sender);
    const result = await dialog.showOpenDialog({
      title: 'Importar perfil de Operador',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    if (!isRendererStillScoped(sender, scope)) {
      return { ok: false, error: 'O projeto mudou durante a importação.' };
    }
    const file = result.filePaths[0];
    try {
      if (fs.statSync(file).size > MAX_PROFILE_FILE_BYTES) {
        return { ok: false, error: 'Arquivo grande demais para um perfil.' };
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return service.importProfile(scope, raw);
    } catch {
      return { ok: false, error: 'Arquivo ilegível ou JSON inválido.' };
    }
  });
}
