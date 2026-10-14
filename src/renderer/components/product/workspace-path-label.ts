/**
 * Rótulo de pasta para o rail: o menor sufixo do caminho que ainda distingue
 * aquela pasta das outras abertas.
 *
 * O rail mostrava só o apelido, e dois `web` de repositórios diferentes ficavam
 * indistinguíveis. Mostrar o caminho inteiro resolve a ambiguidade e cria outra
 * dor: `/Users/<nome>/dev/...` é prefixo comum a tudo, gasta a largura toda e
 * é cortado justamente onde a informação estava.
 *
 * Truncar por CSS exigiria `direction: rtl`, e aí os separadores — neutros para
 * o algoritmo bidi — podem trocar de lado ("/Users/x" vira "Users/x/"). Por
 * isso o encurtamento é do TEXTO, não da caixa.
 */
const MIN_SEGMENTS = 2;
const ELLIPSIS = '…';

export interface WorkspacePathEntry {
  readonly id: string;
  readonly path?: string;
}

function segmentsOf(workspacePath: string): readonly string[] {
  return workspacePath
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter((segment) => segment !== '');
}

function tail(segments: readonly string[], depth: number): string {
  if (depth >= segments.length) {
    // Caminho curto sai inteiro: raiz POSIX ganha a barra; drive (`C:`) nao,
    // senao o rotulo inventa uma raiz que nao existe.
    return /^[A-Za-z]:$/.test(segments[0] ?? '')
      ? segments.join('/')
      : `/${segments.join('/')}`;
  }
  return `${ELLIPSIS}/${segments.slice(-depth).join('/')}`;
}

/** Sufixo com pelo menos `MIN_SEGMENTS` níveis; sem ambiguidade a considerar. */
export function shortenWorkspacePath(
  workspacePath: string,
  segments: number = MIN_SEGMENTS,
): string {
  const parts = segmentsOf(workspacePath);
  if (parts.length === 0) return workspacePath;
  return tail(parts, segments);
}

/**
 * Rótulos de um conjunto: cada um cresce só até deixar de colidir com os
 * demais, então pastas de nome único ficam curtas e as ambíguas ganham
 * exatamente o contexto que faltava.
 */
export function workspacePathLabels(
  workspaces: readonly WorkspacePathEntry[],
): ReadonlyMap<string, string> {
  const entries = workspaces
    .filter((workspace): workspace is WorkspacePathEntry & { path: string } =>
      typeof workspace.path === 'string' && workspace.path !== '',
    )
    .map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      segments: segmentsOf(workspace.path),
    }));

  const deepest = entries.reduce(
    (max, entry) => Math.max(max, entry.segments.length),
    MIN_SEGMENTS,
  );

  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.segments.length === 0) {
      labels.set(entry.id, entry.path);
      continue;
    }
    let depth = MIN_SEGMENTS;
    for (; depth < deepest; depth += 1) {
      const candidate = tail(entry.segments, depth);
      const collides = entries.some(
        (other) =>
          other.id !== entry.id && tail(other.segments, depth) === candidate,
      );
      if (!collides) break;
    }
    labels.set(entry.id, tail(entry.segments, depth));
  }
  return labels;
}
