/**
 * Resolve the packaged / dev path to THIRD_PARTY_NOTICES.md so MIT third-party
 * attribution (Orca, Onlook, fonts, …) ships with closed-source builds.
 */
import fs from 'node:fs';
import path from 'node:path';

export function resolveThirdPartyNoticesPath(opts: {
  appPath: string;
  cwd?: string;
}): string | null {
  const candidates = [
    path.join(opts.appPath, 'THIRD_PARTY_NOTICES.md'),
    path.join(opts.appPath, '..', 'THIRD_PARTY_NOTICES.md'),
    path.join(opts.appPath, '..', '..', 'THIRD_PARTY_NOTICES.md'),
    path.join(opts.cwd ?? process.cwd(), 'THIRD_PARTY_NOTICES.md'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * `shell.openPath` entrega o caminho ao app externo (Finder/editor), que NÃO
 * lê dentro do app.asar — mesmo com `fs.existsSync` passando via shim do
 * Electron, abrir falha com "Failed to open path". Para caminhos dentro do
 * asar, extrai uma cópia para um diretório real e abre a cópia.
 */
export function materializeOpenableNoticesPath(
  found: string,
  tempDir: string,
  copy: (src: string, dest: string) => void = fs.copyFileSync,
): string {
  if (!found.split(path.sep).some((part) => part.endsWith('.asar'))) {
    return found;
  }
  const dest = path.join(tempDir, 'NexusIDE-THIRD_PARTY_NOTICES.md');
  copy(found, dest);
  return dest;
}

/** Files that must be present in the packaged app for legal compliance. */
export const PACKAGED_LEGAL_FILES = [
  '/LICENSE',
  '/THIRD_PARTY_NOTICES.md',
  '/third_party/licenses/orca-MIT.txt',
  '/third_party/licenses/Apache-2.0.txt',
  '/third_party/licenses/OFL-1.1.txt',
] as const;
