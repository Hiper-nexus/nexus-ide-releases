import { ipcMain } from 'electron';
import {
  ORIENTATION_CHANNELS,
  orientationSnapshotSchema,
  type OrientationSnapshot,
} from '../../../shared/orientation-types';
import { resolveProjectExecutionScopeCached } from '../../persistence/project-identity';
import { activeWorkspaceOrNull } from '../../persistence/workspace-store';
import {
  getProjectOrientationService,
  tryGetProjectOrientationService,
} from './orientation-service';

function requireActiveScope() {
  const workspace = activeWorkspaceOrNull();
  if (!workspace) throw new Error('no workspace is open');
  return resolveProjectExecutionScopeCached(workspace);
}

export function registerOrientationIpc(): void {
  ipcMain.handle(ORIENTATION_CHANNELS.get, async (): Promise<OrientationSnapshot | null> => {
    const service = tryGetProjectOrientationService();
    if (!service) return null;
    try {
      const scope = requireActiveScope();
      const map = service.get(scope);
      if (!map) return null;
      return orientationSnapshotSchema.parse(service.toSnapshot(map));
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    ORIENTATION_CHANNELS.ensure,
    async (): Promise<OrientationSnapshot | null> => {
      const service = tryGetProjectOrientationService();
      if (!service) return null;
      try {
        const scope = requireActiveScope();
        const map = await service.ensure(scope, {
          reason: 'pre-kickoff',
          waitMs: 3_000,
        });
        return orientationSnapshotSchema.parse(service.toSnapshot(map));
      } catch (error) {
        console.warn('[orientation] ensure ipc failed:', error);
        return null;
      }
    },
  );

  ipcMain.handle(
    ORIENTATION_CHANNELS.refresh,
    async (): Promise<OrientationSnapshot | null> => {
      try {
        const service = getProjectOrientationService();
        const scope = requireActiveScope();
        const map = await service.refresh(scope);
        return orientationSnapshotSchema.parse(service.toSnapshot(map));
      } catch (error) {
        console.warn('[orientation] refresh ipc failed:', error);
        return null;
      }
    },
  );
}
