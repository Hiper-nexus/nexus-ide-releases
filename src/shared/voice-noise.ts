/**
 * Gate de transcrição-lixo, PURO e compartilhado (main + renderer). Whisper
 * alucina frases fixas em silêncio/ruído e — com AEC desligado — a caixa do
 * próprio TTS volta pelo alto-falante como interjeição garbled ("Ooooooooh!").
 *
 * Política de produto: chamada à Jarvis (só o nome ou variação STT) NÃO é
 * ruído — desperta / engaja Live. Eco real de TTS continua no echoSuppressor.
 */

import { isJarvisWakeAddress, looksLikeJarvisName } from './jarvis-name-match';

const NOISE_WORDS = new Set([
  'a', 'ah', 'ai', 'ok', 'okay', 'hum', 'hmm', 'hm', 'ha', 'uh', 'uhum', 'aham',
  'e', 'eh', 'ta', 'you', 'o', 'oh',
  'ei', 'hey', 'hei', 'oi', 'ola',
]);

/** Vogal única alongada: "ooo", "aaaa", "ooooooooh" (com h final opcional). */
const ELONGATED_VOWEL = /^([aeiou])\1{2,}h*$/;

/** Risada: "kkkk", "haha", "hehe", "rsrs", "huehue". */
const LAUGHTER = /^(k{2,}|(ha){2,}|(he){2,}|(rs)+|(hue)+)$/;

function isNoiseToken(word: string): boolean {
  // Nome Jarvis (mesmo garbled) NÃO é ruído genérico — é engajamento.
  if (looksLikeJarvisName(word)) return false;
  return (
    NOISE_WORDS.has(word) ||
    /^h?u+m+$/.test(word) ||
    /^a+h*$/.test(word) ||
    ELONGATED_VOWEL.test(word) ||
    LAUGHTER.test(word)
  );
}

/**
 * Chamada à assistente (só Jarvis / Ei Jarvis / Hey Javes / …).
 * Nunca descartar no Live nem no Classic como "ruído".
 */
export function isWakeAddressTranscript(text: string): boolean {
  return isJarvisWakeAddress(text);
}

const MEDIA_BOILERPLATE = [
  /\bobrigad[oa] por assistir\b/,
  /\bthanks for watching\b/,
  /\blegendas pela comunidade amara(?:\.org)?\b/,
  /\b(?:se inscrev[ae]|inscreva-se) no canal\b/,
  /\bativ[ae] o sininho\b/,
  /\breceber notificacoes? de novos videos?\b/,
];

function normalizeWords(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.split(' ') : [];
}

/** Whisper/media-credit boilerplate, including the common combined sentence. */
export function isMediaBoilerplateTranscript(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9. -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const matches = MEDIA_BOILERPLATE.filter((pattern) => pattern.test(normalized));
  if (matches.length >= 2) return true;
  return MEDIA_BOILERPLATE.some((pattern) => pattern.test(normalized)) &&
    normalized.split(' ').length <= 5;
}

export function isLikelyNoiseTranscript(text: string): boolean {
  const words = normalizeWords(text);
  const normalized = words.join(' ');
  // Saudações curtas deliberadas são fala real, não ruído.
  if (normalized === 'oi' || normalized === 'e ai') return false;
  // "Jarvis", "Ei Jarvis", "Hey Javes", "javis" sozinho → engajamento.
  if (isWakeAddressTranscript(text)) return false;
  if (!normalized || normalized.length <= 2) return true;
  if (isMediaBoilerplateTranscript(normalized)) return true;
  if (normalized === 'thank you' || normalized === 'obrigado por assistir') return true;
  if (
    normalized === 'se inscreve no canal' ||
    normalized === 'se inscreva no canal' ||
    normalized === 'inscreva-se no canal'
  ) {
    return true;
  }
  // "o javis" (artigo + nome) era eco TTS; com política permissiva ainda
  // engaja se o segundo token parece Jarvis.
  if (words.length === 2 && words[0] === 'o' && looksLikeJarvisName(words[1]!)) {
    return false;
  }
  return words.length <= 3 && words.every(isNoiseToken);
}
