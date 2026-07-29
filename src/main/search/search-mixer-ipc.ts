import { ipcMain } from 'electron';
import { SEARCH_MIXER_CHANNELS } from '../../shared/channels';
import { runSearchMixerQuery } from './search-mixer-bootstrap';
import { requireScopedRoot } from '../security/scoped-workspace-fs';

/**
 * SearchMixer IPC — always binds projectRoot to the sender workspace.
 * Client-supplied projectRoot is ignored (fail-closed against path probes).
 */
export function registerSearchMixerIpc(): void {
  ipcMain.handle(SEARCH_MIXER_CHANNELS.search, async (event, raw) => {
    try {
      const { root, scope } = requireScopedRoot(event.sender);
      const client =
        raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : {};
      // Overwrite any client projectRoot with the scoped workspace root.
      return await runSearchMixerQuery({
        ...client,
        projectRoot: root,
        workspaceId: scope.projectId,
      });
    } catch (err) {
      return {
        generation: 0,
        query: '',
        hits: [],
        partial: false,
        completedSources: [],
        cancelled: false,
        elapsedMs: 0,
        error: err instanceof Error ? err.message : 'search failed',
      };
    }
  });
}
