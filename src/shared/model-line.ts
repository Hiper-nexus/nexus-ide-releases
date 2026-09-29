/**
 * Linha de modelo (F-217 — regra do operador 29/09: "qualquer modelo novo é
 * usado; os mais novos são os melhores", com ou sem benchmark publicado).
 *
 * Dois ids são da MESMA linha quando só os números de versão mudam:
 * `gpt-6-sol` × `gpt-6.1-sol`, `claude-opus-5` × `claude-opus-5-5`,
 * `gemini-3.8-flash-low` × `gemini-3.9-flash-low-preview`.
 *
 * Regras:
 *  - marcador de contexto `[1m]` é ignorado;
 *  - um sufixo de CANAL no fim (-preview/-exp/-experimental/-latest) não cria
 *    linha nova — mas só no fim (`-preview-low` e `-preview-` no meio separam);
 *  - qualquer outro sufixo separa linhas: `-ultrafast`, `-256k`, data
 *    `-2026-09-29`, `MiniMax-M3` × `MiniMax-M3.1-Flash-Preview`;
 *  - versão = cada grupo de dígitos em ordem (`gpt-6.1-sol` → [6,1]);
 *    comparada lexicograficamente, partes ausentes contam como 0, e empate
 *    NÃO é "mais novo" (`gemini-3.8-flash-preview` não supera `gemini-3.8-flash`).
 */

const CONTEXT_TAG = /\[[^\]]*\]$/u;
const CHANNEL_SUFFIX = /-(?:preview|exp|experimental|latest)$/iu;
const DIGIT_GROUP = /\d+(?:[.-]\d+)*/gu;
const DIGITS = /\d+/gu;

export interface ModelLine {
  readonly stem: string;
  readonly version: readonly number[];
}

export function modelLineOf(model: string): ModelLine {
  const bare = model.replace(CONTEXT_TAG, '');
  return {
    stem: bare.toLowerCase().replace(CHANNEL_SUFFIX, '').replace(DIGIT_GROUP, '#'),
    version: (bare.match(DIGITS) ?? []).map(Number),
  };
}

/** `a` é estritamente maior que `b` na comparação numérica lexicográfica. */
export function isNewerModelVersion(
  a: readonly number[],
  b: readonly number[],
): boolean {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** `model` é da mesma linha de `reference` e não é mais velho que ela. */
export function isSameLineAtLeast(model: string, reference: string): boolean {
  const mine = modelLineOf(model);
  const ref = modelLineOf(reference);
  return (
    mine.stem === ref.stem && !isNewerModelVersion(ref.version, mine.version)
  );
}

/**
 * O mais novo da mesma linha entre `candidates`; empates de versão ficam com o
 * primeiro na ordem dos candidatos. Sem candidato mais novo, devolve `model`.
 */
export function newestInModelLine(
  model: string,
  candidates: readonly string[],
): string {
  const target = modelLineOf(model);
  let best: { model: string; version: readonly number[] } | null = null;
  for (const candidate of candidates) {
    const line = modelLineOf(candidate);
    if (line.stem !== target.stem) continue;
    if (!isNewerModelVersion(line.version, target.version)) continue;
    if (best && !isNewerModelVersion(line.version, best.version)) continue;
    best = { model: candidate, version: line.version };
  }
  return best?.model ?? model;
}
