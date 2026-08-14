import { chmodSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { parseSshConfig } from './ssh-config-parser';
import { isSshAlias, looksLikeEndpoint, requireSshAlias } from './ssh-alias';
import {
  nexusSshConfigPath,
  userSshConfigPath,
  type SshHostRecord,
} from './ssh-host-registry';

const INCLUDE_BEGIN = '# BEGIN nexus-ide ssh';
const INCLUDE_END = '# END nexus-ide ssh';
const MANAGED_BEGIN = '# BEGIN nexus-ide host ';
const MANAGED_END = '# END nexus-ide host ';

export type ImportedSshHost = {
  readonly alias: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
};

export function parseImportableSshHosts(
  content: string,
  options?: { home?: string },
): readonly ImportedSshHost[] {
  const parsed = parseSshConfig(content, options);
  const out: ImportedSshHost[] = [];
  const seen = new Set<string>();
  for (const host of parsed) {
    for (const pattern of host.hostPatterns) {
      if (!isSshAlias(pattern)) continue;
      if (looksLikeEndpoint(pattern)) continue;
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      out.push({
        alias: pattern,
        user: host.user,
        port: host.port,
        identityFile: host.identityFiles[0],
      });
    }
  }
  return out;
}

export function renderManagedHostBlock(input: {
  alias: string;
  hostname: string;
  user: string;
  port?: number;
  identityFile: string;
}): string {
  const alias = requireSshAlias(input.alias);
  const lines = [
    `${MANAGED_BEGIN}${alias}`,
    `Host ${alias}`,
    `  HostName ${input.hostname}`,
    `  User ${input.user}`,
    ...(input.port && input.port !== 22 ? [`  Port ${input.port}`] : []),
    `  IdentityFile ${input.identityFile}`,
    '  IdentitiesOnly yes',
    `${MANAGED_END}${alias}`,
    '',
  ];
  return lines.join('\n');
}

export function upsertManagedHostBlock(
  existing: string,
  block: string,
  alias: string,
): string {
  const clean = requireSshAlias(alias);
  const start = `${MANAGED_BEGIN}${clean}`;
  const end = `${MANAGED_END}${clean}`;
  const startAt = existing.indexOf(start);
  const endAt = existing.indexOf(end);
  if (startAt >= 0 && endAt > startAt) {
    const after = existing.slice(endAt + end.length).replace(/^\n/, '');
    return `${existing.slice(0, startAt).replace(/\n+$/, '\n')}${block}${after}`;
  }
  const trimmed = existing.replace(/\n+$/, '');
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}`;
}

export function removeManagedHostBlock(existing: string, alias: string): string {
  const clean = requireSshAlias(alias);
  const start = `${MANAGED_BEGIN}${clean}`;
  const end = `${MANAGED_END}${clean}`;
  const startAt = existing.indexOf(start);
  const endAt = existing.indexOf(end);
  if (startAt < 0 || endAt < startAt) return existing;
  const before = existing.slice(0, startAt).replace(/\n+$/, '');
  const after = existing.slice(endAt + end.length).replace(/^\n+/, '');
  return [before, after].filter(Boolean).join('\n\n') + (after || before ? '\n' : '');
}

export function plantSshConfigInclude(
  existing: string,
  includePath: string,
): { readonly next: string; readonly planted: boolean } {
  const includeLine = `Include ${includePath}`;
  if (existing.includes(includeLine) || existing.includes(INCLUDE_BEGIN)) {
    return { next: existing, planted: false };
  }
  const block = `${INCLUDE_BEGIN}\n${includeLine}\n${INCLUDE_END}\n`;
  const trimmed = existing.replace(/^\uFEFF/, '');
  return {
    next: trimmed ? `${block}\n${trimmed.replace(/^\n+/, '')}` : `${block}\n`,
    planted: true,
  };
}

export async function writeManagedSshHost(input: {
  alias: string;
  hostname: string;
  user: string;
  port?: number;
  identityFile: string;
  home?: string;
}): Promise<void> {
  const home = input.home ?? homedir();
  const managedPath = nexusSshConfigPath(home);
  await mkdir(dirname(managedPath), { recursive: true, mode: 0o700 });
  let current = '';
  try {
    current = await readFile(managedPath, 'utf8');
  } catch {
    current = '';
  }
  const block = renderManagedHostBlock(input);
  const next = upsertManagedHostBlock(current, block, input.alias);
  await writeFile(managedPath, next, { encoding: 'utf8', mode: 0o600 });
  chmodSync(managedPath, 0o600);

  const userConfig = userSshConfigPath(home);
  await mkdir(dirname(userConfig), { recursive: true, mode: 0o700 });
  let userCurrent = '';
  try {
    userCurrent = await readFile(userConfig, 'utf8');
  } catch {
    userCurrent = '';
  }
  const planted = plantSshConfigInclude(userCurrent, managedPath);
  if (planted.planted) {
    await writeFile(userConfig, planted.next, { encoding: 'utf8', mode: 0o600 });
    chmodSync(userConfig, 0o600);
  }
}

export async function removeManagedSshHost(
  alias: string,
  home = homedir(),
): Promise<void> {
  const managedPath = nexusSshConfigPath(home);
  let current = '';
  try {
    current = await readFile(managedPath, 'utf8');
  } catch {
    return;
  }
  const next = removeManagedHostBlock(current, alias);
  await writeFile(managedPath, next, { encoding: 'utf8', mode: 0o600 });
  chmodSync(managedPath, 0o600);
}

export function importedHostToRecord(
  host: ImportedSshHost,
  createdAt: string,
): SshHostRecord {
  return {
    alias: host.alias,
    source: 'imported',
    user: host.user,
    port: host.port && host.port !== 22 ? host.port : undefined,
    identityFile: host.identityFile,
    createdAt,
  };
}
