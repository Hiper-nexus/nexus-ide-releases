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

/** Files that must be present in the packaged app for legal compliance. */
export const PACKAGED_LEGAL_FILES = [
  '/LICENSE',
  '/THIRD_PARTY_NOTICES.md',
  '/third_party/licenses/orca-MIT.txt',
  '/third_party/licenses/Apache-2.0.txt',
  '/third_party/licenses/OFL-1.1.txt',
] as const;
