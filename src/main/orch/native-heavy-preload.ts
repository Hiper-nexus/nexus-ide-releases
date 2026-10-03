import path from 'node:path';
import { app } from 'electron';
export function heavyCommandPreloadPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'heavy-command', 'preload.cjs') : path.join(app.getAppPath(), 'resources', 'heavy-command', 'preload.cjs');
}
/** NODE_OPTIONS parses quotes itself; no shell executes this environment value. */
export function appendHeavyCommandPreload(existing: string | undefined, file: string): string {
  return `${existing?.trim() ?? ''} --require ${JSON.stringify(file)}`.trim();
}
