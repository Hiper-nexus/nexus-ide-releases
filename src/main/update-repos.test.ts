import { describe, expect, it } from 'vitest';

import {
  CANONICAL_RELEASE_REPO,
  CANONICAL_RELEASE_REPOS,
  githubReleasesApiUrl,
  isTrustedGithubReleasePath,
  LEGACY_CANONICAL_RELEASE_REPOS,
  LEGACY_PUBLIC_RELEASES_REPOS,
  PUBLIC_RELEASES_REPO,
  PUBLIC_RELEASES_REPOS,
} from './update-repos';

describe('update release repos', () => {
  it('pins the org canônica and keeps the pre-transfer slugs as fallback', () => {
    expect(CANONICAL_RELEASE_REPO).toBe('Hiper-nexus/nexus-ide');
    expect(PUBLIC_RELEASES_REPO).toBe('Hiper-nexus/nexus-ide-releases');
    expect(CANONICAL_RELEASE_REPOS).toEqual([
      'Hiper-nexus/nexus-ide',
      'cleofasvolarehost/nexus-ide',
    ]);
    expect(PUBLIC_RELEASES_REPOS).toEqual([
      'Hiper-nexus/nexus-ide-releases',
      'cleofasvolarehost/nexus-ide-releases',
    ]);
    expect(LEGACY_CANONICAL_RELEASE_REPOS).toContain('cleofasvolarehost/nexus-ide');
    expect(LEGACY_PUBLIC_RELEASES_REPOS).toContain(
      'cleofasvolarehost/nexus-ide-releases',
    );
  });

  it('builds the public releases API URL the updater fetches', () => {
    expect(githubReleasesApiUrl(PUBLIC_RELEASES_REPO)).toBe(
      'https://api.github.com/repos/Hiper-nexus/nexus-ide-releases/releases?per_page=100',
    );
  });

  it('trusts GitHub release paths on the new org and the legacy redirect slugs', () => {
    expect(
      isTrustedGithubReleasePath('/Hiper-nexus/nexus-ide/releases/download/v0.32.16/'),
    ).toBe(true);
    expect(
      isTrustedGithubReleasePath(
        '/cleofasvolarehost/nexus-ide-releases/releases/download/v0.32.16/',
      ),
    ).toBe(true);
    expect(isTrustedGithubReleasePath('/Hiper-nexus/nexus-ide/issues/1')).toBe(
      false,
    );
    expect(isTrustedGithubReleasePath('/example/nexus/releases/download/v9/')).toBe(
      false,
    );
  });
});
