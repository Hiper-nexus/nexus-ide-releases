/**
 * Filtro de transcrição-lixo do Whisper, CONSCIENTE DE CONTEXTO.
 *
 * O Whisper alucina frases fixas em silêncio/ruído ("you", "thank you",
 * "obrigado por assistir" — créditos de YouTube do corpus). Numa captura FRIA
 * (wake/PTT do nada), essas frases sozinhas são quase sempre alucinação.
 * MAS em conversa ativa, "valeu", "tchau", "oi" são respostas legítimas — o
 * filtro antigo descartava e a JARVIS parecia surda ("falei e ela ignorou").
 *
 * Regra: lista completa só vale fora de conversa; em conversa ativa, apenas
 * os artefatos que nunca são fala real (créditos, pontuação pura).
 */

/** Alucinações clássicas do Whisper em áudio sem fala. */
const COLD_GHOSTS = new Set([
  'you', 'thank you', 'thanks', 'thank you.', 'thanks for watching',
  'thanks for watching!', 'you.', 'bye', 'bye.', '.', 'obrigado',
  'obrigado.', 'obrigado por assistir', 'valeu', 'tchau', 'até a próxima',
  'e aí', 'e ai', 'ei', 'oi', 'legendas pela comunidade amara.org', 'amara.org',
]);

/** Artefatos que NUNCA são fala real, mesmo em conversa. */
const HARD_GHOSTS = new Set([
  '.', 'legendas pela comunidade amara.org', 'amara.org',
  'thanks for watching', 'thanks for watching!', 'obrigado por assistir',
]);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * true = descartar em silêncio (não virar turno). `inConversation` = há uma
 * conversa ativa com a JARVIS (janela de memória curta ainda quente).
 */
export function isDiscardableTranscript(
  text: string,
  opts: { inConversation: boolean },
): boolean {
  const clean = normalize(text);
  if (clean.length === 0) return true;
  return opts.inConversation ? HARD_GHOSTS.has(clean) : COLD_GHOSTS.has(clean);
}
