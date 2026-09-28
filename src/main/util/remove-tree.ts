import fs from 'node:fs';
import path from 'node:path';

/**
 * Remoção recursiva que NUNCA segue link (F-663).
 *
 * O `fs.rm`/`fs.rmSync` recursivo do Node 24 (Electron 43) atravessa
 * junctions no Windows e apaga o conteúdo do ALVO, não só o link — o Node 22
 * não fazia isso. Overlays de pane ligam por junction as conversas duráveis do
 * provider-state, perfis de CLI e a identidade do operador; o teardown do
 * overlay apagava tudo isso e o "Retomar" nunca achava a conversa.
 *
 * Aqui todo link da árvore (symlink ou junction) sai primeiro — só o link — e
 * o rm apaga o que sobrou, que já não aponta para fora. Se um link não puder
 * ser removido, a remoção é abortada: sobrar lixo é melhor do que seguir o
 * link e apagar o que não é nosso.
 */

type TreeRmOptions = fs.RmOptions;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function unlinkLinkSync(link: string): void {
  try {
    fs.unlinkSync(link);
  } catch (error) {
    if (isMissing(error)) return;
    // Link de diretório que o SO só aceita remover como diretório; o
    // rmdir de um reparse point remove o ponto, nunca o alvo.
    fs.rmdirSync(link);
  }
}

async function unlinkLink(link: string): Promise<void> {
  try {
    await fs.promises.unlink(link);
  } catch (error) {
    if (isMissing(error)) return;
    await fs.promises.rmdir(link);
  }
}

function mayBeLink(entry: fs.Dirent): boolean {
  return entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory());
}

/** Remove todo symlink/junction sob `root` (inclusive) sem seguir nenhum. */
export function unlinkLinksInTreeSync(root: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    unlinkLinkSync(root);
    return true;
  }
  if (!stat.isDirectory()) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory() || mayBeLink(entry)) unlinkLinksInTreeSync(child);
  }
  return false;
}

/** Versão assíncrona de {@link unlinkLinksInTreeSync}. */
export async function unlinkLinksInTree(root: string): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(root);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    await unlinkLink(root);
    return true;
  }
  if (!stat.isDirectory()) return false;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory() || mayBeLink(entry)) await unlinkLinksInTree(child);
  }
  return false;
}

/** `fs.rmSync(target, { recursive: true, ...options })` sem seguir link. */
export function removeTreeSync(target: string, options: TreeRmOptions = {}): void {
  if (unlinkLinksInTreeSync(target)) return;
  fs.rmSync(target, { ...options, recursive: true });
}

/** `fs.promises.rm(target, { recursive: true, ...options })` sem seguir link. */
export async function removeTree(target: string, options: TreeRmOptions = {}): Promise<void> {
  if (await unlinkLinksInTree(target)) return;
  await fs.promises.rm(target, { ...options, recursive: true });
}
