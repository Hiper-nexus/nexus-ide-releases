import fs from 'node:fs';
import path from 'node:path';
import { linkEntry, linkFile } from '../orch/cli-mcp-session-artifacts';

/**
 * F-575/F-629: o macOS resolve o keychain padrão a partir do `$HOME` do
 * PROCESSO (`~/Library/Keychains/*.keychain-db`). Um pane com HOME privado do
 * Nexus fica sem keychain, e qualquer escrita nele (gh migrando token, git
 * osxkeychain, refresh OAuth de uma CLI, SDKs de terceiros) abre o modal do
 * sistema "Chaves Não Encontradas" — cujo botão "Reajustar Para Padrões" pode
 * apagar o keychain do operador. O link devolve a lista de busca real; o
 * acesso a cada item continua sob a ACL do securityd, como num terminal comum.
 *
 * Best-effort por arquivo: um keychain ausente nunca aborta o spawn.
 */
export function linkDarwinUserKeychains(realHome: string, privateHome: string): void {
  const realDir = path.join(realHome, 'Library', 'Keychains');
  let names: string[];
  try {
    names = fs.readdirSync(realDir).filter((name) => name.endsWith('.keychain-db'));
  } catch {
    return;
  }
  if (names.length === 0) return;
  const targetDir = path.join(privateHome, 'Library', 'Keychains');
  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  for (const name of names) {
    const target = path.join(targetDir, name);
    try {
      if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
      linkFile(path.join(realDir, name), target);
    } catch {
      // Um keychain individual falho não derruba os demais.
    }
  }
}

/**
 * F-579 tier 1: entradas exatas de identidade/credencial do desenvolvedor
 * (relativas ao HOME real). Os dois `.config/*` exigem `<overlay>/.config`
 * como diretório REAL 0700 — criado só quando ainda não existe (o tier 2 pode
 * tê-lo linkado; nesse caso o link resolve o pai e a entrada já "existe").
 */
export const DEVELOPER_IDENTITY_HOME_ENTRIES = [
  '.gitconfig',
  '.git-credentials',
  '.netrc',
  '_netrc',
  '.ssh',
  '.gnupg',
  '.config/git',
  '.config/gh',
] as const;

/**
 * F-579 tier 1: linka apenas DEVELOPER_IDENTITY_HOME_ENTRIES. Best-effort por
 * entrada e idempotente; quando o tier 2 já linkou `.config`, o lstat do
 * alvo resolve através do symlink e a entrada "já existe" — o `.config`
 * real do HOME nunca é substituído por um diretório local.
 */
export function linkDeveloperIdentity(
  realHome: string,
  overlayDir: string,
): void {
  for (const rel of DEVELOPER_IDENTITY_HOME_ENTRIES) {
    try {
      const source = path.join(realHome, rel);
      const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!sourceStat) continue;
      const target = path.join(overlayDir, rel);
      // lstat resolve através de um `.config` linkado pelo tier 2 e encontra
      // a entrada lá — skip sem trocar o symlink por diretório real.
      if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
      const parent = path.dirname(target);
      const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (!parentStat) {
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      }
      const dirent = fs
        .readdirSync(path.dirname(source), { withFileTypes: true })
        .find((entry) => entry.name === path.basename(source));
      if (dirent) {
        linkEntry(source, target, dirent);
      } else {
        linkFile(source, target);
      }
    } catch {
      // Uma entrada falha não derruba as demais nem o spawn.
    }
  }
}

function realpathOrNull(dir: string): string | null {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return null;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

type PrivateHomeOptions = {
  realHome: string;
  userDataDir: string;
  platform?: NodeJS.Platform;
};

/**
 * Só HOMEs que o próprio Nexus criou (`~/.nexus/**` ou `<userData>/**`) —
 * nunca o HOME real nem um HOME arbitrário herdado do ambiente. Resolve
 * symlinks antes de comparar, então um link para fora das raízes não passa.
 */
function nexusPrivateHome(
  home: string | undefined,
  options: PrivateHomeOptions,
): { home: string; realHome: string } | null {
  if (!home) return null;
  const resolvedHome = realpathOrNull(home);
  const realHome = realpathOrNull(options.realHome);
  if (!resolvedHome || !realHome || resolvedHome === realHome) return null;
  const roots = [path.join(realHome, '.nexus'), realpathOrNull(options.userDataDir)]
    .filter((root): root is string => Boolean(root));
  return roots.some((root) => isInside(resolvedHome, root))
    ? { home: resolvedHome, realHome }
    : null;
}

/** Devolve true quando o HOME privado tem keychain ao final. */
export function ensurePrivateHomeKeychains(
  home: string | undefined,
  options: PrivateHomeOptions,
): boolean {
  if ((options.platform ?? process.platform) !== 'darwin') return false;
  const target = nexusPrivateHome(home, options);
  if (!target) return false;
  linkDarwinUserKeychains(target.realHome, target.home);
  return fs.existsSync(path.join(target.home, 'Library', 'Keychains'));
}

/**
 * F-629: guarda central do spawn. Todo HOME privado do Nexus enxerga o
 * keychain real (macOS) e, quando a lane é gravável, a identidade de
 * desenvolvedor do operador (F-579 tier 1: git, SSH, gh). Sem isso um agente
 * em pane Grok/MiMo/cursor/droid via `gh` deslogado e pedia
 * `gh auth login` com a máquina autenticada. Idempotente: nunca substitui o
 * que o preparo do adapter já colocou no HOME.
 */
export function ensurePrivateHomeOperatorAccess(
  home: string | undefined,
  options: PrivateHomeOptions & { writable: boolean },
): void {
  ensurePrivateHomeKeychains(home, options);
  if (!options.writable) return;
  const target = nexusPrivateHome(home, options);
  if (target) linkDeveloperIdentity(target.realHome, target.home);
}
