/**
 * Gate de transcrição-lixo, PURO e compartilhado (main + renderer). Whisper
 * alucina frases fixas em silêncio/ruído e — com AEC desligado — a cauda do
 * próprio TTS volta pelo alto-falante como interjeição garbled ("Ooooooooh!",
 * "o javis"). Este gate mata essas capturas ANTES do cérebro, encerrando a
 * cadeia de reply graciosamente em vez de a JARVIS responder a si mesma.
 *
 * Conservador de propósito: só descarta capturas curtas (≤3 tokens) em que
 * TODO token é ruído/interjeição/eco de wake — uma resposta curta legítima
 * ("sim", "não", "abre") NUNCA é ruído.
 */

const NOISE_WORDS = new Set([
  'a', 'ah', 'ai', 'ok', 'okay', 'hum', 'hmm', 'hm', 'ha', 'uh', 'uhum', 'aham',
  'e', 'eh', 'ei', 'hey', 'ta', 'you', 'o', 'oh',
]);

/** Nome do assistente garbled pelo STT (eco do wake), nunca um comando real. */
const JARVIS_GARBLE = /^(jarvis|jarvi|jarv|javis|javes|jave|jarves|jervis|jives)$/;

/** Vogal única alongada: "ooo", "aaaa", "ooooooooh" (com h final opcional). */
const ELONGATED_VOWEL = /^([aeiou])\1{2,}h*$/;

/** Risada: "kkkk", "haha", "hehe", "rsrs", "huehue". */
const LAUGHTER = /^(k{2,}|(ha){2,}|(he){2,}|(rs)+|(hue)+)$/;

function isNoiseToken(word: string): boolean {
  return (
    NOISE_WORDS.has(word) ||
    /^h?u+m+$/.test(word) ||
    /^a+h*$/.test(word) ||
    ELONGATED_VOWEL.test(word) ||
    LAUGHTER.test(word) ||
    JARVIS_GARBLE.test(word)
  );
}

export function isLikelyNoiseTranscript(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Saudações curtas deliberadas são fala real, não ruído.
  if (normalized === 'oi' || normalized === 'e ai') return false;
  if (!normalized || normalized.length <= 2) return true;
  if (normalized === 'thank you' || normalized === 'obrigado por assistir') return true;
  if (
    normalized === 'se inscreve no canal' ||
    normalized === 'se inscreva no canal' ||
    normalized === 'inscreva-se no canal'
  ) {
    return true;
  }
  const words = normalized.split(' ');
  return words.length <= 3 && words.every(isNoiseToken);
}
