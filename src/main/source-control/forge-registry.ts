/**
 * Forge registry — picks the right forge provider for a repo's remote and
 * ties together the previously orphaned Nexus-vendored pieces (parseHostedRemote,
 * forge flags, the GitHub/GitLab REST providers, disabled stubs). A remote's
 * host decides the provider; a feature flag decides whether it's enabled
 * (GitHub/GitLab on by default; Bitbucket/Azure/Gitea off). Provider construction
 * is injected-friendly so the selection logic is testable without HTTP.
 */
import { parseHostedRemote } from '../git/hosted-remote-url';
import { isForgeEnabled, createDisabledForgeStub } from './forge-flags';
import type { ForgeProvider, ForgeProviderId } from './forge-provider';
import { createGitHubForgeProvider, type GitHubHttp } from './github-forge-provider';
import { createGitLabForgeProvider, type GitLabHttp } from './gitlab-forge-provider';

export interface ForgeSelection {
  providerId: ForgeProviderId;
  host: string;
  owner: string;
  name: string;
  enabled: boolean;
}

/** Resolve a remote URL to its forge, or null when it isn't a hosted repo. */
export function selectForge(
  remoteUrl: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ForgeSelection | null {
  if (!remoteUrl) return null;
  const parsed = parseHostedRemote(remoteUrl);
  if (!parsed) return null;
  const parts = parsed.path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const providerId = parsed.provider as ForgeProviderId;
  return {
    providerId,
    host: parsed.host,
    owner: parts[0]!,
    name: parts[1]!.replace(/\.git$/, ''),
    enabled: isForgeEnabled(providerId, env),
  };
}

/**
 * Build the provider for a selection. Disabled forges (or ones without a REST
 * implementation) return the refusing stub, so callers never accidentally hit
 * an unsupported forge.
 */
export function resolveForgeProvider(
  selection: ForgeSelection,
  token: string,
  http: GitHubHttp & GitLabHttp,
): ForgeProvider {
  if (!selection.enabled) return createDisabledForgeStub(selection.providerId);
  switch (selection.providerId) {
    case 'github':
      return createGitHubForgeProvider({ token, http });
    case 'gitlab':
      return createGitLabForgeProvider({ token, http });
    default:
      return createDisabledForgeStub(selection.providerId);
  }
}
