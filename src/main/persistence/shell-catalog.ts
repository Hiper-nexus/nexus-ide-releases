import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const COMMON_SHELLS = [
  '/bin/zsh',
  '/bin/bash',
  '/bin/sh',
  '/opt/homebrew/bin/fish',
  '/usr/local/bin/fish',
  '/opt/homebrew/bin/nu',
  '/usr/local/bin/nu',
] as const;

/**
 * Login shell real da conta (Directory Services no macOS). $SHELL reflete o
 * ambiente de quem lançou o app (Finder, scripts, CI) e /etc/shells lista
 * /bin/bash antes do zsh — nenhum dos dois representa o shell do usuário.
 * Uma leitura por processo; qualquer falha cai para $SHELL/comuns.
 */
let cachedLoginShell: string | null | undefined;
function resolveAccountLoginShell(): string | null {
  if (cachedLoginShell !== undefined) return cachedLoginShell;
  cachedLoginShell = null;
  if (process.platform !== 'darwin') return cachedLoginShell;
  const user = process.env.USER;
  if (!user) return cachedLoginShell;
  try {
    const result = spawnSync(
      '/usr/bin/dscl',
      ['.', '-read', `/Users/${user}`, 'UserShell'],
      { encoding: 'utf8', timeout: 2_000 },
    );
    const match = /UserShell:\s*(\/\S+)/.exec(result.stdout ?? '');
    if (match && path.isAbsolute(match[1])) cachedLoginShell = match[1];
  } catch {
    // Sem dscl: mantém null e segue a cadeia de fallbacks.
  }
  return cachedLoginShell;
}

export function collectAvailableShells(
  shellsFile: string,
  currentShell: string | undefined,
  isExecutable: (candidate: string) => boolean,
  preferredShell?: string | null,
  platform = process.platform,
): string[] {
  const declared = shellsFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  // Login shell da conta primeiro; depois $SHELL do ambiente, os comuns
  // (zsh antes do bash) e só então a ordem crua do /etc/shells.
  const candidates = [
    preferredShell ?? '',
    currentShell ?? '',
    ...COMMON_SHELLS,
    ...declared,
  ];
  const seen = new Set<string>();
  const isAbsolute = platform === 'win32'
    ? path.win32.isAbsolute
    : path.posix.isAbsolute;

  return candidates.filter((candidate) => {
    if (!isAbsolute(candidate) || seen.has(candidate)) return false;
    seen.add(candidate);
    return isExecutable(candidate);
  });
}

export function collectAvailableWindowsShells(
  environment: NodeJS.ProcessEnv,
  executable: (candidate: string) => boolean,
): string[] {
  const programFiles = [
    environment.ProgramW6432,
    environment.ProgramFiles,
  ].filter((value): value is string => Boolean(value));
  const systemRoot = environment.SystemRoot;
  const comSpec = environment.ComSpec;
  const candidates = [
    ...programFiles.map((root) =>
      path.win32.join(root, 'PowerShell', '7', 'pwsh.exe')),
    ...(systemRoot
      ? [
          path.win32.join(
            systemRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
        ]
      : []),
    ...(comSpec && path.win32.basename(comSpec).toLowerCase() === 'cmd.exe'
      ? [comSpec]
      : []),
    ...(systemRoot
      ? [path.win32.join(systemRoot, 'System32', 'cmd.exe')]
      : []),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (
      !/^[a-z]:\\/iu.test(candidate) ||
      !path.win32.isAbsolute(candidate)
    ) {
      return false;
    }
    const identity = path.win32.normalize(candidate).toLowerCase();
    if (seen.has(identity)) return false;
    if (!executable(candidate)) return false;
    seen.add(identity);
    return true;
  });
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function listAvailableShells(): string[] {
  if (process.platform === 'win32') {
    return collectAvailableWindowsShells(process.env, isExecutable);
  }
  let shellsFile = '';
  try {
    shellsFile = fs.readFileSync('/etc/shells', 'utf8');
  } catch {
    // Common candidates and $SHELL still provide a useful, validated list.
  }
  return collectAvailableShells(
    shellsFile,
    process.env.SHELL,
    isExecutable,
    resolveAccountLoginShell(),
  );
}

export function resolveConfiguredShell(
  requested: string | undefined,
  configured: string,
  available: readonly string[],
  platform = process.platform,
): string {
  const selected = configured || available[0];
  const identity = (candidate: string): string =>
    platform === 'win32'
      ? path.win32.normalize(candidate).toLowerCase()
      : candidate;
  const approved = selected
    ? available.find((candidate) => identity(candidate) === identity(selected))
    : undefined;
  if (!selected || !approved) {
    throw new Error('configured shell is not an approved executable');
  }
  if (requested && identity(requested) !== identity(selected)) {
    throw new Error('renderer shell does not match main-process settings');
  }
  return approved;
}
