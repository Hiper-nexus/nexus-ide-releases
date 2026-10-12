/**
 * Sanitização de prompt vindo de deep link `nexus://new?prompt=…`
 * (herdada do t3code `promptLinks.ts`).
 *
 * Um link pode ser disparado por qualquer site. O prompt só PREENCHE o
 * formulário — mas o texto que chega precisa ser o que a pessoa vê:
 * zero-width, bidi e outros invisíveis escondem instruções do revisor
 * humano enquanto o modelo lê. Quebras de linha são legítimas (pedido
 * multi-linha); viram `\n` puro. Só os invisíveis são removidos, com contagem.
 */

export const PROMPT_LINK_MAX_LENGTH = 16_384;

export interface SanitizedPrompt {
  readonly text: string;
  /** Quantos caracteres invisíveis foram removidos (0 = limpo). */
  readonly hiddenCharacters: number;
}

/**
 * Invisíveis: C0 exceto tab/lf/cr, DEL, C1, soft-hyphen, zero-width,
 * bidi, tags, variation selectors (exceto FE0E/FE0F de emoji) e afins.
 * U+2028/2029 já viraram `\n` antes desta classe.
 */
const HIDDEN_CHARACTERS = new RegExp(
  '[' +
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD' +
    '\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F' +
    '\\u200B\\u200C\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u206F' +
    '\\u3164\\uFE00-\\uFE0D\\uFEFF\\uFFA0\\uFFF0-\\uFFFB' +
    '\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E0FFF}' +
    ']',
  'gu',
);

const isEmojiPart = (codePoint: number | undefined): boolean =>
  codePoint !== undefined &&
  ((codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2190 && codePoint <= 0x2bff) ||
    codePoint === 0xfe0f);

/**
 * Normaliza quebras, remove invisíveis (contando) e faz trim.
 * `text` vazio com `hiddenCharacters > 0` é assinatura de prompt malicioso.
 */
export function sanitizeLinkedPrompt(raw: string): SanitizedPrompt {
  let hiddenCharacters = 0;
  const normalized = raw.replace(/\r\n?|[\u2028\u2029]/g, '\n');
  const visible = Array.from(
    normalized.replace(HIDDEN_CHARACTERS, () => {
      hiddenCharacters += 1;
      return '';
    }),
  );
  // ZWJ só vale dentro de sequência de emoji (família etc.).
  const text = visible
    .filter((character, index) => {
      if (character !== '\u200D') return true;
      const kept =
        isEmojiPart(visible[index - 1]?.codePointAt(0)) &&
        isEmojiPart(visible[index + 1]?.codePointAt(0));
      if (!kept) hiddenCharacters += 1;
      return kept;
    })
    .join('')
    .trim();
  return { text, hiddenCharacters };
}

export type PromptLinkRead =
  | { readonly ok: true; readonly prompt: string | null }
  | { readonly ok: false; readonly reason: 'too-long' | 'hidden-only' };

/**
 * Lê o `prompt` de uma query. `null` quando o link não traz nenhum
 * (o chamador abre o formulário vazio). Recusa longo demais e o caso
 * "só caracteres invisíveis".
 */
export function readLinkedPrompt(raw: string | null): PromptLinkRead {
  if (raw === null) return { ok: true, prompt: null };
  if (raw.length > PROMPT_LINK_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  const { text, hiddenCharacters } = sanitizeLinkedPrompt(raw);
  if (text.length === 0 && hiddenCharacters > 0) {
    return { ok: false, reason: 'hidden-only' };
  }
  return { ok: true, prompt: text.length > 0 ? text : null };
}
