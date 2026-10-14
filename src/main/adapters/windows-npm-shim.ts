import fs from 'node:fs';
import path from 'node:path';
import { cliInstallRecipeCandidates } from './cli-install-recipes';
import { resolveCliBinary } from '../path-resolver';
import { quoteWindowsArg } from '../pty/windows-command-line';

/**
 * Windows npm creates a .cmd launcher rather than a symlink. Resolve the
 * package entrypoint only when the shim names the same built-in package.
 */
export function windowsNpmShimTarget(adapterId: string, binPath: string): string | null {
  if (!/\.cmd$/iu.test(binPath)) return null;
  let shim: string;
  try {
    shim = fs.readFileSync(binPath, 'utf8').replaceAll('\\', '/').toLowerCase();
  } catch {
    return null;
  }
  for (const recipe of cliInstallRecipeCandidates(adapterId, 'win32')) {
    if (recipe.kind !== 'argv' || recipe.runner !== 'npm') continue;
    const packageName = recipe.argv[recipe.argv.length - 1];
    const root = path.join(path.dirname(binPath), 'node_modules', ...packageName.split('/'));
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      const command = path.basename(binPath, '.cmd');
      const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[command];
      if (!relative) continue;
      const targetRef = `node_modules/${packageName}/${relative.replace(/^\.\//u, '')}`.replaceAll('\\', '/').toLowerCase();
      const invocation = shim.split(/\r?\n/u).filter((line) =>
        !/^\s*(?:rem\b|::)/u.test(line) && line.trimEnd().endsWith('%*') &&
        [`"%dp0%/${targetRef}"`, `"%~dp0/${targetRef}"`, `"%~dp0%/${targetRef}"`]
          .some((target) => line.includes(target)));
      if (invocation.length !== 1) continue;
      const entrypoint = path.resolve(root, relative);
      if (!entrypoint.startsWith(root + path.sep)) continue;
      if (fs.statSync(entrypoint).isFile()) return entrypoint;
    } catch {
      // A missing or changed package cannot establish launcher ownership.
    }
  }
  return null;
}

export function windowsNpmShimInvocation(
  adapterId: string,
  binPath: string,
  nodePath: string | null,
): { executable: string; argsPrefix: string[] } | null {
  const target = windowsNpmShimTarget(adapterId, binPath);
  if (!target) return null;
  if (/\.(?:exe|com)$/iu.test(target)) {
    return { executable: target, argsPrefix: [] };
  }
  if (!nodePath) return null;
  if (/\.(?:[cm]?js)$/iu.test(target)) {
    return { executable: nodePath, argsPrefix: [target] };
  }
  try {
    const fd = fs.openSync(target, 'r');
    const start = Buffer.alloc(160);
    try {
      const count = fs.readSync(fd, start, 0, start.length, 0);
      if (/^#![^\r\n]*\bnode\b/iu.test(start.toString('utf8', 0, count))) {
        return { executable: nodePath, argsPrefix: [target] };
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Unknown launcher format: do not claim the package entrypoint is runnable.
  }
  return null;
}

/**
 * F-668: o executável real por trás do `.cmd` do npm de uma CLI embutida,
 * verificado pelo pacote dela. `node.exe` vem do lado do atalho (Node
 * portátil) ou do PATH (prefixo npm separado, ex. `~/.local/bin`).
 */
export function windowsNpmShimSpawn(
  adapterId: string,
  shimPath: string,
): { file: string; argsPrefix: string[] } | null {
  if (!/\.cmd$/iu.test(shimPath)) return null;
  const sibling = path.join(path.dirname(shimPath), 'node.exe');
  const node = fs.existsSync(sibling)
    ? sibling
    : resolveCliBinary('node')?.binPath ?? null;
  const nodePath = node && /\.exe$/iu.test(node) ? node : null;
  const invocation = windowsNpmShimInvocation(adapterId, shimPath, nodePath);
  return invocation
    ? { file: invocation.executable, argsPrefix: invocation.argsPrefix }
    : null;
}

/**
 * F-1507: sonda curta de CLI (`provider list`, `models`) no Windows, com argv
 * fixo do código. O `shell: true` do Node junta caminho e argv com espaço SEM
 * aspas: com o npm em `C:\Users\Ana Maria\…` o cmd.exe procurava
 * `C:\Users\Ana`. Atalho do npm verificado → o pacote pelo `node.exe`, sem
 * cmd.exe (F-668); `.cmd`/`.bat` não verificado ou nome nu → cmd.exe com o
 * caminho sempre entre aspas (um caminho não tem `"`) e o argv citado;
 * `.exe` → direto.
 */
export function windowsCliProbeLaunch(
  adapterId: string,
  binPath: string,
  args: readonly string[],
): { file: string; args: string[]; windowsVerbatimArguments?: true } {
  const batch = /\.(?:cmd|bat)$/iu.test(binPath);
  if (!batch && path.isAbsolute(binPath)) return { file: binPath, args: [...args] };
  const shim = batch ? windowsNpmShimSpawn(adapterId, binPath) : null;
  if (shim) return { file: shim.file, args: [...shim.argsPrefix, ...args] };
  const line = [`"${binPath}"`, ...args.map(quoteWindowsArg)].join(' ');
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
