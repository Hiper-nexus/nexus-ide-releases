/**
 * Matching permissivo do nome "Jarvis" para wake / engajamento.
 *
 * Política de produto: basta o nome **Jarvis** (ou STT perto). Não exige
 * "Hey Jarvis". Aceita "Jarvis", "Ei Jarvis", "acorda Jarvis", "cheguei Jarvis",
 * "olá Jarvis", "ouça Jarvis", etc. Ambient longo ("hoje o Jarvis falou…")
 * continua filtrado fora de posição de endereço.
 */

/** Aliases observados em STT PT-BR (Groq/Whisper) + sotaque. */
export const JARVIS_STT_ALIASES = new Set([
  'jarvis',
  'jarbas',
  'jarbis',
  'javes',
  'javis',
  'jarves',
  'jarvi',
  'jarvez',
  'jarvins',
  'jarvix',
  'jarwis',
  'jarvie',
  'jarvies',
  'jarv',
  'yavis',
  'charvis',
  'harvis',
  'garvis',
  'jarwis',
  'jackson',
  'jasper',
  'jervis',
  'jives',
  'jave',
  'eijax',
  'rejaves',
  'jacques',
  'carvis',
  'marvis',
  'zarvis',
  'jarviz',
  'jarvus',
  'gervis',
  'geravis',
]);

/**
 * Prefixo curto antes do nome: cumprimento OU verbo de chamada.
 * "acorda jarvis", "cheguei jarvis", "ouça jarvis", "oi jarvis".
 */
export const WAKE_PREFIX_TOKENS = new Set([
  // cumprimentos
  'hey',
  'hei',
  'ei',
  'e',
  'oi',
  'ola',
  'oye',
  'ai',
  'ae',
  'eh',
  'hello',
  'olaa',
  'oie',
  'fala',
  'falae',
  'ok',
  'alo',
  'alou',
  'eae',
  'iae',
  // chamada / atenção
  'acorda',
  'acordar',
  'acorde',
  'acordou',
  'chega',
  'cheguei',
  'chegado',
  'chegando',
  'ouca',
  'ouco',
  'ouso',
  'ouve',
  'ouvir',
  'escuta',
  'escute',
  'escutar',
  'ajuda',
  'ajudar',
  'vem',
  'volta',
  'voltar',
  'ativa',
  'ativar',
  'liga',
  'ligar',
  'abre',
  'abrir',
  'psiu',
  'eihe',
  'porfavor',
  'please',
  // NÃO incluir artigo "o"/"a" sozinho — "o jarvis falou…" ambient.
  // "o jarvis" (só 2 tokens) é tratado em isJarvisWakeAddress.
]);

/** @deprecated use WAKE_PREFIX_TOKENS — mantido para imports legados */
const WAKE_GREETINGS = WAKE_PREFIX_TOKENS;

export function normalizeNameToken(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Distância de edição (Levenshtein) com early-exit. */
export function editDistance(left: string, right: string, max = 3): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > max) return max + 1;
  const rows = left.length + 1;
  const cols = right.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let r = 1; r < rows; r += 1) {
    const curr = [r];
    let rowMin = r;
    for (let c = 1; c < cols; c += 1) {
      const cost = left[r - 1] === right[c - 1] ? 0 : 1;
      const v = Math.min(prev[c]! + 1, curr[c - 1]! + 1, prev[c - 1]! + cost);
      curr[c] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[right.length]!;
}

/**
 * Token isolado parece "Jarvis"? (exato, alias, prefixo jarv*, ou ≤2 edits).
 */
export function looksLikeJarvisName(raw: string, target = 'jarvis'): boolean {
  const heard = normalizeNameToken(raw);
  if (!heard || heard.length < 3) return false;
  const expected = normalizeNameToken(target) || 'jarvis';

  if (heard === expected) return true;
  if (JARVIS_STT_ALIASES.has(heard)) return true;

  // Prefixo característico: jarv… / jarb… / charv…
  if (/^(jarv|jarb|charv|harv|garv|yav)/.test(heard) && heard.length >= 4) {
    return true;
  }

  // Sufixo …rvis / …avis em nomes curtos (javes, travis-like)
  if (heard.length >= 4 && heard.length <= 10) {
    if (/(rvis|avis|arvis|erves|arves)$/.test(heard)) {
      const dist = editDistance(heard, expected, 3);
      if (dist <= 2) return true;
    }
  }

  // Fuzzy geral: até 2 edits para alvo ≥5 chars; 1 edit se alvo 4
  const maxEdits = expected.length >= 5 ? 2 : 1;
  if (heard.length >= 3 && heard.length <= 12) {
    if (editDistance(heard, expected, maxEdits) <= maxEdits) return true;
  }

  return false;
}

const JOINED_GREETING_PREFIXES = [
  'hey',
  'hei',
  'ei',
  'e',
  'oi',
  'ola',
  'oye',
  'ai',
  'eh',
  'ok',
] as const;

/** "heyjarvis" / "eijarbas" colados pelo STT. */
export function stripJoinedGreeting(token: string): string | null {
  const heard = normalizeNameToken(token);
  for (const g of JOINED_GREETING_PREFIXES) {
    if (heard.startsWith(g) && heard.length > g.length + 2) {
      return heard.slice(g.length);
    }
  }
  return null;
}

/**
 * Transcript curto é chamada à Jarvis?
 * Só o nome, prefixo+nome ("acorda jarvis"), ou nome+comando ("jarvis abre").
 * Usado no gate de ruído do Live e no wake passivo.
 */
export function isJarvisWakeAddress(
  text: string,
  assistantName = 'Jarvis',
): boolean {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeNameToken)
    .filter(Boolean);
  // Frases de chamada costumam ser curtas; ambient longo cai no matcher passivo.
  if (words.length === 0 || words.length > 8) return false;

  const target = normalizeNameToken(assistantName) || 'jarvis';

  // Só o nome (ou nome colado com cumprimento)
  if (words.length === 1) {
    const joined = stripJoinedGreeting(words[0]!);
    if (joined && looksLikeJarvisName(joined, target)) return true;
    return looksLikeJarvisName(words[0]!, target);
  }

  // Nome no primeiro token: "jarvis", "jarvis abre o terminal"
  if (looksLikeJarvisName(words[0]!, target)) return true;

  // "o jarvis" / "a jarvis" só em clip de 2 tokens (STT curto)
  if (
    words.length === 2 &&
    (words[0] === 'o' || words[0] === 'a') &&
    looksLikeJarvisName(words[1]!, target)
  ) {
    return true;
  }

  // prefixo + nome: "oi jarvis", "acorda jarvis", "cheguei jarvis", "ouça jarvis"
  if (WAKE_PREFIX_TOKENS.has(words[0]!)) {
    if (looksLikeJarvisName(words[1]!, target)) return true;
    const joined = stripJoinedGreeting(words[1]!);
    if (joined && looksLikeJarvisName(joined, target)) return true;
  }

  // "e ai jarvis" / "bom dia jarvis" (dois tokens curtos + nome)
  if (
    words.length >= 3 &&
    looksLikeJarvisName(words[2]!, target) &&
    isTwoTokenWakeLead(words[0]!, words[1]!)
  ) {
    return true;
  }

  return false;
}

/** "e ai", "bom dia", "por favor" antes do nome. */
function isTwoTokenWakeLead(a: string, b: string): boolean {
  if (a === 'e' && (b === 'ai' || b === 'ei' || b === 'ae' || b === 'aii')) {
    return true;
  }
  if (a === 'bom' && (b === 'dia' || b === 'diaa')) return true;
  if (a === 'boa' && (b === 'tarde' || b === 'noite')) return true;
  if (a === 'por' && b === 'favor') return true;
  // dois prefixos empilhados: "oi ouca jarvis" raro; "ei ouca jarvis"
  if (WAKE_PREFIX_TOKENS.has(a) && WAKE_PREFIX_TOKENS.has(b)) return true;
  return false;
}

/**
 * Posição válida do nome num clip STT de wake passivo.
 * Exportado para o matcher do renderer.
 */
export function isJarvisAddressTokenIndex(
  words: readonly string[],
  index: number,
): boolean {
  if (index < 0 || index >= words.length) return false;
  if (index === 0) return true;
  const w0 = normalizeNameToken(words[0] ?? '');
  if (index === 1) {
    return WAKE_PREFIX_TOKENS.has(w0);
  }
  if (index === 2) {
    const w1 = normalizeNameToken(words[1] ?? '');
    return isTwoTokenWakeLead(w0, w1);
  }
  return false;
}
