/**
 * Repos de release depois da transferência para a org Hiper-nexus.
 * O binário 0.32.x ainda consulta os slugs antigos; o GitHub 301 redireciona,
 * e estes aliases ficam no fallback para não quebrar checagem/publicação.
 */
export const CANONICAL_RELEASE_REPO = 'Hiper-nexus/nexus-ide';
export const PUBLIC_RELEASES_REPO = 'Hiper-nexus/nexus-ide-releases';

export const LEGACY_CANONICAL_RELEASE_REPOS = [
  'cleofasvolarehost/nexus-ide',
] as const;

export const LEGACY_PUBLIC_RELEASES_REPOS = [
  'cleofasvolarehost/nexus-ide-releases',
] as const;

export const CANONICAL_RELEASE_REPOS = [
  CANONICAL_RELEASE_REPO,
  ...LEGACY_CANONICAL_RELEASE_REPOS,
] as const;

export const PUBLIC_RELEASES_REPOS = [
  PUBLIC_RELEASES_REPO,
  ...LEGACY_PUBLIC_RELEASES_REPOS,
] as const;

const GH_RELEASES_PER_PAGE = 100;

export function githubReleasesApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=${GH_RELEASES_PER_PAGE}`;
}

export function isTrustedGithubReleasePath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return [...CANONICAL_RELEASE_REPOS, ...PUBLIC_RELEASES_REPOS].some((repo) =>
    path.startsWith(`/${repo.toLowerCase()}/releases/`),
  );
}
