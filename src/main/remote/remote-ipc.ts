import { ipcMain } from 'electron';
import { z } from 'zod';
import { REMOTE_CHANNELS } from '../../shared/remote-channels';
import type { RemoteSpawnRequest } from '../../shared/remote-types';
import {
  getRemoteBridgeInfo,
  revokeRemoteTokens,
  rotateRemotePairing,
  startRemoteBridge,
  stopRemoteBridge,
} from './remote-bridge';
import {
  createRemoteTmuxSession,
  detectRemoteClis,
  listRemoteTmuxSessions,
} from './remote-spawn';

const startSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  host: z.enum(['0.0.0.0', '127.0.0.1', '::1', '::']).optional(),
});
const targetSchema = z.object({
  target: z.string().min(3).max(256),
});
const spawnSchema = z.object({
  target: z.string().min(3).max(256),
  cwd: z.string().min(1).max(4096).optional(),
  cli: z.enum(['claude', 'codex', 'gemini', 'kimi', 'antigravity']),
  sessionName: z.string().min(1).max(80).optional(),
  prompt: z.string().max(8192).optional(),
});

export function registerRemoteIpc(): void {
  ipcMain.handle(REMOTE_CHANNELS.bridgeStatus, () => getRemoteBridgeInfo());
  ipcMain.handle(REMOTE_CHANNELS.bridgeStart, async (_event, raw) => {
    const parsed = startSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ...getRemoteBridgeInfo(), error: 'invalid start request' };
    return startRemoteBridge(parsed.data);
  });
  ipcMain.handle(REMOTE_CHANNELS.bridgeStop, () => stopRemoteBridge());
  ipcMain.handle(REMOTE_CHANNELS.bridgeRotatePairing, () => rotateRemotePairing());
  ipcMain.handle(REMOTE_CHANNELS.bridgeRevokeTokens, () => revokeRemoteTokens());

  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnDetect, async (_event, raw) => {
    const parsed = targetSchema.safeParse(raw);
    if (!parsed.success) return { target: '', found: [], error: 'invalid target' };
    return detectRemoteClis(parsed.data.target);
  });
  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnList, async (_event, raw) => {
    const parsed = targetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, target: '', error: 'invalid target' };
    return listRemoteTmuxSessions(parsed.data.target);
  });
  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnCreate, async (_event, raw) => {
    const parsed = spawnSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, target: '', error: 'invalid remote spawn request' };
    return createRemoteTmuxSession(parsed.data as RemoteSpawnRequest);
  });
}
