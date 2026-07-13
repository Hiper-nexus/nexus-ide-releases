import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Imagens escolhidas via Fototeca/iCloud chegam como caminhos temporários
 * (…/TemporaryItems/com.apple.Photos.NSItemProvider/…) com nomes cheios de
 * querystring — somem antes de a missão rodar e quebram citação em shell.
 * Copiamos a imagem para um diretório estável do app com um nome limpo.
 */

/** Nome de arquivo seguro para a cópia: stem kebab-case + extensão original. */
export function stableHatchImageName(basename: string, seq: number): string {
  const ext = (basename.match(/\.(png|webp|jpe?g)$/i)?.[0] ?? '.png')
    .toLowerCase()
    .replace('.jpeg', '.jpg');
  const stem = basename
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${stem || 'pet'}-${seq}${ext}`;
}

/** Copia a imagem-base para <userData>/pet-hatch/ e devolve o caminho estável. */
export async function copyHatchImage(
  sourcePath: string,
  userDataDir: string,
): Promise<string> {
  const dir = path.join(userDataDir, 'pet-hatch');
  await fs.mkdir(dir, { recursive: true });
  const digest = createHash('sha256')
    .update(await fs.readFile(sourcePath))
    .digest('hex')
    .slice(0, 16);
  const name = stableHatchImageName(
    path.basename(sourcePath),
    Number.parseInt(digest.slice(0, 12), 16),
  );
  const dest = path.join(dir, name);
  await fs.copyFile(sourcePath, dest);
  return dest;
}
