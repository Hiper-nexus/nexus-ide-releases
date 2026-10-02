import fs from 'node:fs';
import path from 'node:path';

/**
 * F-747: o instalador oficial do Devin no Windows (`setup.ps1`/`install.ps1`)
 * termina com `Copy-Item <novo> devin.exe -Force`. Com um pane Devin aberto o
 * Windows recusa ("O processo não pode acessar o arquivo…") e "Atualizar CLI"
 * falhava. Renomear um executável em uso é permitido: o atual vai para
 * `<exe>.old-<marca>` — a convenção do updater do próprio Devin —, o script
 * copia o novo e os panes abertos seguem no binário antigo.
 */
export type InUseExecutableFs = Pick<
  typeof fs,
  'existsSync' | 'renameSync' | 'readdirSync' | 'rmSync'
>;

/**
 * Apaga as cópias `.old-*` de atualizações anteriores que já não estão em uso
 * (cada uma tem ~190 MB). A que ainda roda num pane recusa a remoção e fica.
 */
export function removeStaleExecutableCopies(
  entry: string,
  fsImpl: InUseExecutableFs = fs,
): string[] {
  const dir = path.dirname(entry);
  const prefix = `${path.basename(entry)}.old-`;
  const removed: string[] = [];
  let names: string[];
  try {
    names = fsImpl.readdirSync(dir) as string[];
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fsImpl.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // Em uso por um pane: fica para a próxima atualização.
    }
  }
  return removed;
}

/** Tira o executável do caminho do instalador. Null quando não havia nenhum. */
export function moveExecutableAside(
  entry: string,
  stamp: string,
  fsImpl: InUseExecutableFs = fs,
): string | null {
  if (!fsImpl.existsSync(entry)) return null;
  const aside = `${entry}.old-${stamp}`;
  fsImpl.renameSync(entry, aside);
  return aside;
}

/**
 * Instalador que falhou sem deixar binário novo: devolve o antigo ao lugar,
 * senão a CLI some da máquina. Com binário novo presente, nada muda.
 */
export function restoreExecutableIfMissing(
  entry: string,
  aside: string | null,
  fsImpl: InUseExecutableFs = fs,
): boolean {
  if (!aside || fsImpl.existsSync(entry) || !fsImpl.existsSync(aside)) return false;
  fsImpl.renameSync(aside, entry);
  return true;
}
