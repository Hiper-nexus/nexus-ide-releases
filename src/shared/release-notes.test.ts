import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CURRENT_RELEASE } from './release-notes';

function readJson(relativeUrl: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('release metadata', () => {
  it('mantém pacote, lockfile, changelog e notas internas na mesma versão', () => {
    const packageJson = readJson('../../package.json');
    const serverPackageJson = readJson('../../server/package.json');
    const packageLock = readJson('../../package-lock.json');
    const lockPackages = packageLock.packages as
      | Record<string, { version?: unknown }>
      | undefined;
    const changelog = readFileSync(
      fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url)),
      'utf8',
    );

    expect(packageJson.version).toBe(CURRENT_RELEASE.version);
    expect(serverPackageJson.version).toBe(CURRENT_RELEASE.version);
    expect(packageLock.version).toBe(CURRENT_RELEASE.version);
    expect(lockPackages?.['']?.version).toBe(CURRENT_RELEASE.version);
    expect(changelog).toContain(`## ${CURRENT_RELEASE.version} —`);
    expect(CURRENT_RELEASE.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});
