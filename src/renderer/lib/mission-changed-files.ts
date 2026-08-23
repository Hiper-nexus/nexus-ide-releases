/**
 * "O que mudou" — a entrega em linguagem de gente.
 *
 * `result.artifactRefs` é tipado como `idSchema` no contrato, mas o motor
 * grava CAMINHOS relativos ao projeto (verificado no app rodando 23/08:
 * ["index.html", "docs/plan.md", ...]). A aba Resultado mostrava a lista crua
 * em monoespaçada — sem link, sem verbo, sem preview. Para quem não programa,
 * uma lista de caminhos não responde "o que foi feito".
 *
 * Este módulo separa o que É arquivo do que é identificador opaco e nomeia
 * cada arquivo pelo papel que ele cumpre.
 */

export interface ChangedFile {
  /** Caminho relativo ao projeto, como o motor gravou. */
  readonly path: string;
  /** O que este arquivo é, em uma palavra que o leigo reconhece. */
  readonly role: string;
}

export interface ChangedFilesProjection {
  readonly files: readonly ChangedFile[];
  /** Refs que não são caminho de arquivo — ficam no detalhe técnico. */
  readonly opaqueRefs: readonly string[];
}

/** Um ref é arquivo quando tem extensão e não parece um id gerado. */
function looksLikePath(ref: string): boolean {
  const value = ref.trim();
  if (!value || value.length > 512) return false;
  if (/\s/u.test(value)) return false;
  // ids do motor: uuid, hash longo, prefixo tipo "handoff-…"
  if (/^[0-9a-f]{16,}$/iu.test(value)) return false;
  return /\.[A-Za-z0-9]{1,10}$/u.test(value);
}

const ROLE_BY_EXTENSION: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.(?:html?|htm)$/iu, 'página'],
  [/\.(?:css|scss|sass|less)$/iu, 'estilo'],
  [/\.(?:tsx?|jsx?|mjs|cjs)$/iu, 'código'],
  [/\.(?:md|mdx|txt|rst)$/iu, 'documento'],
  [/\.(?:json|ya?ml|toml|ini|env)$/iu, 'configuração'],
  [/\.(?:png|jpe?g|gif|svg|webp|avif|ico)$/iu, 'imagem'],
  [/\.(?:mp3|wav|ogg|opus|m4a)$/iu, 'áudio'],
  [/\.(?:mp4|mov|webm|mkv)$/iu, 'vídeo'],
  [/\.(?:pdf|docx?|xlsx?|pptx?)$/iu, 'arquivo'],
  [/\.(?:sh|bash|zsh|ps1)$/iu, 'script'],
  [/\.(?:sql)$/iu, 'banco de dados'],
];

/** Papel do arquivo em uma palavra — nunca a extensão crua. */
export function fileRole(path: string): string {
  for (const [pattern, role] of ROLE_BY_EXTENSION) {
    if (pattern.test(path)) return role;
  }
  return 'arquivo';
}

/**
 * Projeta os refs da entrega em arquivos nomeados + refs opacos.
 * Ordem: a raiz do projeto primeiro (é o que a pessoa quer ver), depois
 * caminho mais curto — o mais aninhado costuma ser apoio.
 */
export function projectChangedFiles(
  artifactRefs: readonly string[],
): ChangedFilesProjection {
  const files: ChangedFile[] = [];
  const opaqueRefs: string[] = [];
  const seen = new Set<string>();

  for (const ref of artifactRefs) {
    const value = ref.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (looksLikePath(value)) {
      files.push({ path: value, role: fileRole(value) });
    } else {
      opaqueRefs.push(value);
    }
  }

  files.sort((left, right) => {
    const leftDepth = left.path.split('/').length;
    const rightDepth = right.path.split('/').length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return left.path.localeCompare(right.path, 'pt-BR');
  });

  return { files, opaqueRefs };
}
