import path from 'node:path';

/**
 * `candidate` mora DENTRO de `root` — nunca é a própria raiz (F-716).
 *
 * Não monte isso com `startsWith(root + sep)` sobre `toNamespacedPath`: no
 * win32 ele resolve o caminho e tira o separador final, então a raiz vira
 * prefixo solto — a própria raiz e uma irmã (`operator` vs `operator2`)
 * passavam como "dentro". `path.relative` respeita a fronteira de segmento e
 * a caixa do Windows.
 */
export function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
