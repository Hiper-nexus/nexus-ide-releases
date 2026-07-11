/**
 * Port limpo (autorizado pelo produto) de:
 *   Overclock @overclock-app/core voiceNlu.ts
 *
 * matchWakeWord: detecção textual pós-STT — path principal de wake do Overclock.
 * Não é openWakeWord acústico; é VAD → STT → este matcher.
 */

/** Fase da escuta passiva (Overclock JARVIS_PASSIVE_PHASES). */
export const JARVIS_PASSIVE_PHASES = ['off', 'standby', 'capturing', 'checking'] as const;
export type JarvisPassivePhase = (typeof JARVIS_PASSIVE_PHASES)[number];

/** STT aliases Whisper/Groq para "Jarvis" (Overclock + truncamentos reais). */
const WAKE_ALIASES = new Set([
  'jarbas',
  'jarbis',
  // truncamentos / STT sujo observados no Nexus
  'javes',
  'javis',
  'jarves',
  'jarvi',
  'jarviz',
  'jarvus',
  'jarvix',
  'jarvys',
  'jarviss',
  'charvis',
  'harvis',
  'jackson',
  'jasper',
  'jacques',
  'eijax',
  'rejaves',
  'aja',
  'jar',
  'jars',
  'yarvis',
  'garvis',
]);

/**
 * Match the wake word at ANY token position in `text`
 * (F-057: "Obrigado. Jarvis." / "vamos lá... jarvis?" must wake).
 *
 * C-070: `wakeWord` is configurable (default "Jarvis").
 *
 * Accepts:
 * - Exact match at distance 0 at ANY position.
 * - Fuzzy edit-distance ≤ 1 only in the first two tokens, tokens ≥ 4 chars.
 * - Aliases only when default "jarvis".
 * - First occurrence wins.
 *
 * Returns `{ rest }` after the wake word, or null.
 */
export function matchWakeWord(
  text: string,
  wakeWord = 'jarvis',
): { rest: string } | null {
  const configured = wakeWord
    .trim()
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
  const target = configured.length > 0 ? configured : ['jarvis'];
  const isDefault = target.length === 1 && target[0] === 'jarvis';
  const joined = target.join('');
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const tokenHit = (
    token: string,
    expected: string,
    fuzzy: boolean,
    def: boolean,
  ): boolean =>
    token.length > 0 &&
    (fuzzy
      ? (def && WAKE_ALIASES.has(token)) ||
        (expected.length >= 4 ? editDistanceAtMostOne(token, expected) : token === expected)
      : token === expected);

  // Extensão Nexus: STT truncado "e ja" / "ei ja" / "e jar" (logs reais).
  if (isDefault && words.length === 2) {
    const a = normalizeWord(words[0]!);
    const b = normalizeWord(words[1]!);
    const fillers = new Set([
      'e',
      'ei',
      'hey',
      'hei',
      'oi',
      'ola',
      'ok',
      'ai',
      'ae',
      'acorda',
      'acordar',
      'acordou',
      'ativa',
      'ativar',
      'chama',
      'chamar',
    ]);
    if (
      fillers.has(a) &&
      b.length >= 2 &&
      b.length <= 5 &&
      'jarvis'.startsWith(b) &&
      b.startsWith('ja')
    ) {
      return { rest: '' };
    }
  }
  if (isDefault && words.length === 1) {
    const one = normalizeWord(words[0]!);
    if (WAKE_ALIASES.has(one) || one === 'jarvis') return { rest: '' };
    // "heyjarvis" / "eijarbas" colados
    for (const g of [
      'hey',
      'hei',
      'ei',
      'e',
      'oi',
      'ola',
      'ok',
      'acorda',
      'acordar',
    ] as const) {
      if (one.startsWith(g) && one.length > g.length + 2) {
        const tail = one.slice(g.length);
        if (tokenHit(tail, 'jarvis', true, isDefault)) {
          return { rest: '' };
        }
      }
    }
  }

  for (let i = 0; i < words.length; i += 1) {
    const fuzzy = i < 2;
    let consumed = 0;
    // Token colado "eijarbas" / "heyjarvis" / "acordajarvis" no início
    if (isDefault && fuzzy) {
      const rawTok = normalizeWord(words[i]!);
      for (const g of [
        'hey',
        'hei',
        'ei',
        'e',
        'oi',
        'ola',
        'ok',
        'acorda',
        'acordar',
      ] as const) {
        if (rawTok.startsWith(g) && rawTok.length > g.length + 2) {
          const tail = rawTok.slice(g.length);
          if (tokenHit(tail, 'jarvis', true, isDefault)) {
            consumed = 1;
            break;
          }
        }
      }
    }
    if (i + target.length <= words.length && consumed === 0) {
      let all = true;
      for (let k = 0; k < target.length; k += 1) {
        if (!tokenHit(normalizeWord(words[i + k]!), target[k]!, fuzzy, isDefault)) {
          all = false;
          break;
        }
      }
      if (all) consumed = target.length;
    }
    if (consumed === 0 && joined.length >= 4) {
      let acc = '';
      for (let k = 0; i + k < words.length && acc.length <= joined.length; k += 1) {
        acc += normalizeWord(words[i + k]!);
        if (acc.length >= joined.length - 1 && tokenHit(acc, joined, fuzzy, isDefault)) {
          consumed = k + 1;
          break;
        }
      }
    }
    if (consumed > 0) {
      const rest = words
        .slice(i + consumed)
        .join(' ')
        .replace(/^[\s,.;:!?]+/, '')
        .trim();
      return { rest };
    }
  }
  return null;
}

function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]! <= 1;
}

const NEG_EXACT = ['nao', 'para', 'pare'];
const NEG_PREFIX = ['nega', 'cancel'];
const AFF_EXACT = ['sim', 'pode', 'vai', 'manda'];
const AFF_PREFIX = ['aprov', 'confirm'];

/** Classifica confirmação de tool (Overclock). */
export function matchVoiceConfirmation(
  text: string,
): { approved: boolean; always?: boolean } | null {
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const has = (exact: string[], prefixes: string[]) =>
    words.some((w) => exact.includes(w) || prefixes.some((p) => w.startsWith(p)));

  if (has(NEG_EXACT, NEG_PREFIX)) return { approved: false };
  if (has(AFF_EXACT, AFF_PREFIX)) {
    const always = words.includes('sempre');
    return always ? { approved: true, always: true } : { approved: true };
  }
  return null;
}
