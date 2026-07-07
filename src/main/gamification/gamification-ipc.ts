import fs from 'node:fs';
import { dialog, ipcMain } from 'electron';
import { z } from 'zod';
import {
  GAMIFICATION_CHANNELS,
  type GamificationSnapshot,
} from '../../shared/gamification-types';
import {
  buildSnapshot,
  doPrestige,
  exportProfileData,
  importProfileData,
  recordJarvisActionForGamification,
  selectSkin,
} from './gamification-service';

/**
 * IPC da gamificação (padrão media-ipc): snapshot pull + ações validadas com
 * zod. O broadcast `gamification:changed` sai do service (coalescido).
 */

const selectSkinSchema = z.object({
  /** null = skin padrão. */
  skin: z.string().min(1).max(64).nullable(),
});

const recordJarvisActionSchema = z.object({
  actionType: z.string().min(1).max(64),
  ok: z.boolean(),
});

const MAX_PROFILE_FILE_BYTES = 50 * 1024 * 1024;

export function registerGamificationIpc(): void {
  ipcMain.handle(
    GAMIFICATION_CHANNELS.snapshot,
    (): GamificationSnapshot => buildSnapshot(),
  );

  ipcMain.handle(
    GAMIFICATION_CHANNELS.selectSkin,
    (_e, raw): GamificationSnapshot => {
      const parsed = selectSkinSchema.safeParse(raw);
      if (!parsed.success) return buildSnapshot();
      const { skin } = parsed.data;
      // Só skins possuídas (ou o padrão) — cosmético nunca vira exploit.
      if (skin !== null && !buildSnapshot().skins.includes(skin)) {
        return buildSnapshot();
      }
      return selectSkin(skin);
    },
  );

  ipcMain.handle(
    GAMIFICATION_CHANNELS.prestige,
    (): GamificationSnapshot => doPrestige(),
  );

  ipcMain.handle(
    GAMIFICATION_CHANNELS.recordJarvisAction,
    (_e, raw): GamificationSnapshot => {
      const parsed = recordJarvisActionSchema.safeParse(raw);
      if (!parsed.success) return buildSnapshot();
      recordJarvisActionForGamification(parsed.data.actionType, parsed.data.ok);
      return buildSnapshot();
    },
  );

  ipcMain.handle(GAMIFICATION_CHANNELS.exportProfile, async () => {
    const data = exportProfileData();
    if (!data) return { ok: false, error: 'Banco de dados indisponível.' };
    const res = await dialog.showSaveDialog({
      title: 'Exportar perfil de Operador',
      defaultPath: 'nexus-operator-profile.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    try {
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
      return { ok: true, path: res.filePath };
    } catch {
      return { ok: false, error: 'Falha ao gravar o arquivo.' };
    }
  });

  ipcMain.handle(GAMIFICATION_CHANNELS.importProfile, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Importar perfil de Operador',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false };
    const file = res.filePaths[0];
    try {
      if (fs.statSync(file).size > MAX_PROFILE_FILE_BYTES) {
        return { ok: false, error: 'Arquivo grande demais para um perfil.' };
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return importProfileData(raw);
    } catch {
      return { ok: false, error: 'Arquivo ilegível ou JSON inválido.' };
    }
  });
}
