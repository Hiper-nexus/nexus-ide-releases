import { createRequire } from 'node:module';
import path from 'node:path';
import type { HeavyCommandKind } from './heavy-command-permit';

// F-1273: the permit decision on the Main side must agree with the one the
// resource hooks make, so it reuses catalog.commandKind verbatim: quoted
// text, comments and heredoc bodies are never the program being run, and a
// command longer than 16384 chars stays conservatively metered as 'build'.
const requireForCatalog = createRequire(__filename);
type CatalogCommandKind = (command: string) => string | null;
let catalogKind: CatalogCommandKind | undefined;
function loadCatalogKind(): CatalogCommandKind {
  if (catalogKind) return catalogKind;
  try {
    // In the app the catalog ships next to the other heavy-command resources;
    // this mirrors native-heavy-preload.ts's path selection.
    const electron = require('electron') as typeof import('electron');
    const file = electron.app.isPackaged
      ? path.join(process.resourcesPath, 'heavy-command', 'catalog.cjs')
      : path.join(electron.app.getAppPath(), 'resources', 'heavy-command', 'catalog.cjs');
    catalogKind = (requireForCatalog(file) as { commandKind: CatalogCommandKind }).commandKind;
    return catalogKind;
  } catch {}
  // Outside the running app (unit tests, tooling): resolve from this source.
  catalogKind = (requireForCatalog('../../../resources/heavy-command/catalog.cjs') as { commandKind: CatalogCommandKind }).commandKind;
  return catalogKind;
}

export function classifyHeavyCommand(command: string): HeavyCommandKind | null {
  return loadCatalogKind()(command) as HeavyCommandKind | null;
}
