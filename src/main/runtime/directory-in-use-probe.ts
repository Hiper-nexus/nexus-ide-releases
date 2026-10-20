import fs from 'node:fs';
import path from 'node:path';

/**
 * Windows: prova de "fora de uso" de uma pasta por renomeação (F-908 no
 * win32, onde não há lsof/procfs para ler o cwd dos processos).
 *
 * O NTFS recusa renomear um diretório enquanto algum processo o tem como
 * diretório atual ou mantém um arquivo dentro aberto sem FILE_SHARE_DELETE
 * (o "a pasta ou um arquivo nela está aberto em outro programa" do Explorer).
 * Renomear para um irmão e desfazer na hora é, então, a sonda: deu certo, nada
 * a segura; falhou, está em uso. Recusa = em uso; nunca palpite.
 *
 * O desfazer tenta de novo com espera curta (antivírus/indexador podem pegar
 * um handle no meio); se ainda assim falhar, lança com os dois caminhos — a
 * pasta nunca é dada como livre sem estar no lugar de volta.
 */
export interface DirectoryProbeDeps {
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly suffix?: () => string;
}

const RESTORE_ATTEMPTS = 6;
const PROBE_MARK = '.nexus-gc-probe-';

export async function probeDirectoryUnusedByRename(
  directory: string,
  deps: DirectoryProbeDeps = {},
): Promise<boolean> {
  const rename = deps.rename ?? ((from, to) => fs.promises.rename(from, to));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const suffix = deps.suffix ?? (() => `${process.pid}-${Date.now().toString(36)}`);
  const probe = `${directory}${PROBE_MARK}${suffix()}`;
  try {
    await rename(directory, probe);
  } catch {
    return false;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt += 1) {
    try {
      await rename(probe, directory);
      return true;
    } catch (error) {
      lastError = error;
      await sleep(100 * (attempt + 1));
    }
  }
  throw new Error(
    `sonda de uso não conseguiu devolver ${probe} para ${directory}: ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

/**
 * A sonda que não conseguiu desfazer deixa a pasta com o nome temporário e o
 * registro apontando para o caminho vazio — a coleta seguinte veria "pasta
 * sumida" e soltaria o registro, abandonando o trabalho lá dentro. Antes disso,
 * devolve a pasta ao lugar: `restored` (voltou), `stranded` (há sobra mas não
 * foi possível devolver — nada pode ser coletado) ou `none`.
 */
export async function restoreStrandedProbe(
  directory: string,
  deps: Pick<DirectoryProbeDeps, 'rename'> & {
    readonly readdir?: (dir: string) => Promise<string[]>;
    readonly exists?: (target: string) => Promise<boolean>;
  } = {},
): Promise<'restored' | 'stranded' | 'none'> {
  const rename = deps.rename ?? ((from, to) => fs.promises.rename(from, to));
  const readdir = deps.readdir ?? ((dir) => fs.promises.readdir(dir));
  const exists = deps.exists ?? (async (target) => {
    try {
      await fs.promises.lstat(target);
      return true;
    } catch {
      return false;
    }
  });
  const parent = path.dirname(directory);
  const prefix = `${path.basename(directory)}${PROBE_MARK}`;
  let leftovers: string[];
  try {
    leftovers = (await readdir(parent)).filter((name) => name.startsWith(prefix));
  } catch {
    return 'none';
  }
  if (leftovers.length === 0) return 'none';
  if (leftovers.length > 1 || await exists(directory)) return 'stranded';
  try {
    await rename(path.join(parent, leftovers[0]!), directory);
    return 'restored';
  } catch {
    return 'stranded';
  }
}
