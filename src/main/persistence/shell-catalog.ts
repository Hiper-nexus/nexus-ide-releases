import fs from 'node:fs';
import path from 'node:path';

const COMMON_SHELLS = [
  '/bin/zsh',
  '/bin/bash',
  '/bin/sh',
  '/opt/homebrew/bin/fish',
  '/usr/local/bin/fish',
  '/opt/homebrew/bin/nu',
  '/usr/local/bin/nu',
] as const;

export function collectAvailableShells(
  shellsFile: string,
  currentShell: string | undefined,
  isExecutable: (candidate: string) => boolean,
): string[] {
  const declared = shellsFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const candidates = [currentShell ?? '', ...declared, ...COMMON_SHELLS];
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    if (!path.isAbsolute(candidate) || seen.has(candidate)) return false;
    seen.add(candidate);
    return isExecutable(candidate);
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
  let shellsFile = '';
  try {
    shellsFile = fs.readFileSync('/etc/shells', 'utf8');
  } catch {
    // Common candidates and $SHELL still provide a useful, validated list.
  }
  return collectAvailableShells(shellsFile, process.env.SHELL, isExecutable);
}
