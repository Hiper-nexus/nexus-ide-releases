/** Normaliza texto para comparação de eco TTS (compartilhado main + renderer). */
export function normEcho(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ECHO_MIN_CHARS = 6;
const WORD_OVERLAP_THRESHOLD = 0.8;
/** Palavras >= isto casam por proximidade (STT trocou/dropou 1 letra da cauda). */
const FUZZY_MIN_LEN = 4;

/** True se `a` e `b` diferem por no máx. 1 edição (insert/delete/substituição). */
function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  // Varre em paralelo; ao achar a 1ª diferença, tenta as 3 correções e exige
  // que o resto bata (edit-distance exatamente 1).
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i += 1; // deleção em `a`
    else if (lb > la) j += 1; // inserção em `a`
    else {
      i += 1; // substituição
      j += 1;
    }
  }
  // Sobra de 1 char no fim (insert/delete) conta como a única edição.
  return edits + (la - i) + (lb - j) <= 1;
}

/**
 * True quando a transcrição parece eco de texto falado recentemente pelo TTS.
 * Camadas: (1) substring contígua; (2) sobreposição de palavras significativas
 * >= 80%, contando também casamentos FUZZY (edit-distance <= 1) para pegar a
 * cauda do TTS que voltou pelo mic e o STT transcreveu com erros de 1 letra —
 * o casamento só-exato deixava esse eco garbled virar turno. A janela temporal
 * (TTL) é aplicada por quem chama (echoSuppressor), então isto é o casador puro.
 */
export function isLikelySpokenEcho(transcript: string, spokenText: string): boolean {
  const norm = normEcho(transcript);
  if (norm.length < ECHO_MIN_CHARS) return false;
  const window = normEcho(spokenText);
  if (!window || window.length < ECHO_MIN_CHARS) return false;
  if (window.includes(norm)) return true;
  const words = norm.split(' ').filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const spokenWords = window.split(' ');
  const spoken = new Set(spokenWords);
  const fuzzyPool = spokenWords.filter((w) => w.length >= FUZZY_MIN_LEN);
  const hits = words.filter((w) => {
    if (spoken.has(w)) return true;
    if (w.length < FUZZY_MIN_LEN) return false;
    return fuzzyPool.some((sw) => withinEditDistance1(w, sw));
  }).length;
  return hits / words.length >= WORD_OVERLAP_THRESHOLD;
}
