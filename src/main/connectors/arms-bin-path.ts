import path from 'node:path';

/**
 * F-1579: caminho real do conector Arms (`bin/nexus-arms.mjs`, que o forge
 * leva como extraResource). A tela mostrava o caminho fixo do app do macOS
 * (`/Applications/NexusIDE.app/Contents/Resources/…`) também no Windows,
 * onde o Squirrel instala em `%LOCALAPPDATA%\nexus_ide\app-<versão>\resources`.
 */
export function armsBinPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'nexus-arms.mjs')
    : path.join(input.appPath, 'bin', 'nexus-arms.mjs');
}
