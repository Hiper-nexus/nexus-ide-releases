// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/core/ssh/config/sshConfigParser.ts
// See src/vendor/emdash/ssh/LICENSE.md. Nexus changes:
//  - `glob` package import replaced with node:fs/promises `glob` (the npm glob
//    package is only a transitive, undeclared dependency in Nexus and has no
//    installed types). Matches are filtered to regular files via stat(),
//    mirroring upstream's { nodir: true }. Requires Node >= 22 at runtime
//    (Electron 43 qualifies).
//  - `@shared/core/ssh/ssh` type import repointed to the local vendored
//    ./ssh-config-host interface.
//  - Orphaned trailing doc comment for resolveIdentityAgentFromSshConfig
//    dropped (that function lives in ./resolve-ssh-config).
//
// Best-effort listing of ~/.ssh/config aliases for UI import. Not canonical for connection behavior.
import { glob, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SshConfigHost } from './ssh-config-host';

/**
 * Strips surrounding quotes (single or double) from a value string.
 */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Expands a leading `~` or `~/` to the user's home directory.
 */
function expandTilde(filePath: string): string {
  if (filePath === '~') {
    return homedir();
  }
  if (filePath.startsWith('~/')) {
    return join(homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Parses ~/.ssh/config and returns an array of host entries.
 * Skips wildcard host patterns (containing * or ?).
 */
export async function parseSshConfigFile(): Promise<SshConfigHost[]> {
  const configPath = join(homedir(), '.ssh', 'config');
  return await parseSshConfigFileAt(configPath);
}

export async function parseSshConfigFileAt(configPath: string): Promise<SshConfigHost[]> {
  const content = await readSshConfigWithIncludes(configPath, new Set());
  return parseSshConfigContent(content);
}

async function readSshConfigWithIncludes(
  configPath: string,
  includeStack: Set<string>
): Promise<string> {
  const absoluteConfigPath = resolve(configPath);
  if (includeStack.has(absoluteConfigPath)) return '';

  const nextIncludeStack = new Set(includeStack);
  nextIncludeStack.add(absoluteConfigPath);

  const configDir = dirname(absoluteConfigPath);
  const content = await readFile(configPath, 'utf-8').catch(() => '');
  const expandedLines: string[] = [];

  for (const line of content.split('\n')) {
    const includeMatch = line.trim().match(/^Include\s+(.+)$/i);
    if (!includeMatch) {
      expandedLines.push(line);
      continue;
    }

    const includeFiles = await resolveIncludePaths(includeMatch[1], configDir);
    for (const includeFile of includeFiles) {
      expandedLines.push(await readSshConfigWithIncludes(includeFile, nextIncludeStack));
    }
  }

  return expandedLines.join('\n');
}

async function resolveIncludePaths(value: string, configDir: string): Promise<string[]> {
  const patterns = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const matches = await Promise.all(
    patterns.map(async (pattern) => {
      const expandedPattern = expandTilde(stripQuotes(pattern));
      const absolutePattern = isAbsolute(expandedPattern)
        ? expandedPattern
        : resolve(configDir, expandedPattern);
      return await expandIncludePattern(absolutePattern);
    })
  );

  return matches.flat().sort();
}

// Keeps only regular files, mirroring upstream's glob { nodir: true } option.
async function expandIncludePattern(absolutePattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const match of glob(absolutePattern)) {
    const stats = await stat(match).catch(() => null);
    if (stats?.isFile()) found.push(match);
  }
  return found;
}

/**
 * Parses OpenSSH config content for concrete Host aliases that can be shown in
 * import UI. This is intentionally best-effort; connection behavior is resolved
 * with `ssh -G`.
 */
export function parseSshConfigContent(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  const lines = content.split('\n');
  let currentAliases: string[] = [];
  let currentConfig: Omit<SshConfigHost, 'host'> | null = null;

  const flushCurrentHost = () => {
    if (!currentConfig || currentAliases.length === 0) return;
    for (const host of currentAliases) {
      hosts.push({ host, ...currentConfig });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Match Host directive
    const hostMatch = trimmed.match(/^Host\s+(.+)$/i);
    if (hostMatch) {
      flushCurrentHost();
      currentAliases = hostMatch[1]
        .trim()
        .split(/\s+/)
        .map(stripQuotes)
        .filter((host) => host && !host.includes('*') && !host.includes('?'));
      currentConfig = currentAliases.length > 0 ? {} : null;
      continue;
    }

    // Match HostName
    const hostnameMatch = trimmed.match(/^HostName\s+(.+)$/i);
    if (hostnameMatch && currentConfig) {
      currentConfig.hostname = stripQuotes(hostnameMatch[1].trim());
      continue;
    }

    // Match User
    const userMatch = trimmed.match(/^User\s+(.+)$/i);
    if (userMatch && currentConfig) {
      currentConfig.user = stripQuotes(userMatch[1].trim());
      continue;
    }

    // Match Port
    const portMatch = trimmed.match(/^Port\s+(\d+)$/i);
    if (portMatch && currentConfig) {
      currentConfig.port = parseInt(portMatch[1], 10);
      continue;
    }

    // Match IdentityFile
    const identityMatch = trimmed.match(/^IdentityFile\s+(.+)$/i);
    if (identityMatch && currentConfig) {
      const identityFile = expandTilde(stripQuotes(identityMatch[1].trim()));
      currentConfig.identityFile = identityFile;
      continue;
    }

    // Match IdentityAgent
    const identityAgentMatch = trimmed.match(/^IdentityAgent\s+(.+)$/i);
    if (identityAgentMatch && currentConfig) {
      const identityAgent = expandTilde(stripQuotes(identityAgentMatch[1].trim()));
      currentConfig.identityAgent = identityAgent;
      continue;
    }

    // Match ProxyJump
    const proxyJumpMatch = trimmed.match(/^ProxyJump\s+(.+)$/i);
    if (proxyJumpMatch && currentConfig) {
      const proxyJump = stripQuotes(proxyJumpMatch[1].trim());
      currentConfig.proxyJump = proxyJump.toLowerCase() === 'none' ? undefined : proxyJump;
      continue;
    }

    // Match ProxyCommand
    const proxyCommandMatch = trimmed.match(/^ProxyCommand\s+(.+)$/i);
    if (proxyCommandMatch && currentConfig) {
      const proxyCommand = proxyCommandMatch[1].trim();
      currentConfig.proxyCommand = proxyCommand.toLowerCase() === 'none' ? undefined : proxyCommand;
      continue;
    }

    // Match ForwardAgent
    const forwardAgentMatch = trimmed.match(/^ForwardAgent\s+(.+)$/i);
    if (forwardAgentMatch && currentConfig) {
      const value = stripQuotes(forwardAgentMatch[1].trim());
      const normalizedValue = value.toLowerCase();
      currentConfig.forwardAgent = normalizedValue !== 'no';
      if (currentConfig.forwardAgent) {
        currentConfig.forwardAgentValue = normalizedValue === 'yes' ? undefined : value;
      }
      continue;
    }
  }

  // Don't forget the last host
  flushCurrentHost();

  return hosts;
}

export function findSshConfigHostByHostName(
  hosts: SshConfigHost[],
  hostname: string
): SshConfigHost | undefined {
  const normalizedHostname = hostname.toLowerCase();
  return hosts.find((host) => host.hostname?.toLowerCase() === normalizedHostname);
}
