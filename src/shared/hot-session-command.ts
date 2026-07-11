/**
 * Gate for hot-session text inject (Live already engaged).
 * Overclock parity: follow-ups without re-saying the name — NOT ambient TV.
 *
 * Logs 2026-07-11: "camelo vindo", "aplaus", "musica de abertu" were injected
 * as commands → Jarvis hallucinated tools and narration.
 */

import { isLikelyNoiseTranscript, isMediaBoilerplateTranscript } from './voice-noise';

/** Imperative / product cues in pt-BR (normalized, no accents). */
const COMMAND_CUE =
  /^(cria|criar|abre|abrir|fecha|fechar|lista|listar|mostra|mostrar|leia|ler|manda|mandar|envia|enviar|faz|fazer|roda|rodar|digita|digitar|escreve|escrever|para|parar|troca|trocar|muda|mudar|foca|focar|termina|terminar|encerra|encerrar|confirma|confirmar|sim|nao|ok|okay|nova|novo|missao|missoes|squad|pane|panes|terminal|execut|build|deploy|git|status|restaura|restaurar|delega|delegar|pergunta|perguntar|navega|navegar|volta|voltar|cancela|cancelar|mata|matar|mata|kill|stop|run|open|close|read|write|send)$/;

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

/** TV / YouTube / ambient STT garbage (expanded from real logs). */
const AMBIENT_MEDIA = [
  /\baplaus/,
  /\bmusica\b/,
  /\blegendas?\b/,
  /\binscrev/,
  /\bsininho\b/,
  /\bassistindo\b/,
  /\bcontinuar assistindo\b/,
  /\bcidade no brasil\b/,
  /\bobrigad[oa] por assistir\b/,
  /\bthanks for watching\b/,
  /\bamara\.org\b/,
  /\bcamelo\b/,
  /\babertura\b/,
  /\bcomentar(io|ios)?\b/,
  /\bse inscreva\b/,
];

export function isAmbientMediaTranscript(text: string): boolean {
  const n = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9. -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return false;
  if (isMediaBoilerplateTranscript(n)) return true;
  return AMBIENT_MEDIA.some((re) => re.test(n));
}

/**
 * Minimum peak RMS (post-AGC) to trust a no-wake hot inject.
 * Logs: TV injects at 0.02–0.15; real "Jarvis"/command near mic ≥ 0.12–0.3.
 */
export const HOT_COMMAND_MIN_PEAK_RMS = 0.10;

/**
 * True when text + energy look like a deliberate follow-up command, not room
 * media / STT garbage.
 */
export function isHotSessionCommandCandidate(
  text: string,
  opts: { peakRms?: number; requireEnergy?: boolean } = {},
): boolean {
  const raw = text.trim();
  if (!raw || raw.length < 3 || raw.length > 180) return false;
  if (isLikelyNoiseTranscript(raw)) return false;
  if (isAmbientMediaTranscript(raw)) return false;

  if (opts.requireEnergy !== false) {
    const peak = opts.peakRms ?? 0;
    if (!(peak >= HOT_COMMAND_MIN_PEAK_RMS)) return false;
  }

  const words = normalizeWords(raw);
  if (words.length === 0) return false;
  // Single random noun from STT ("aplaus") — not a command.
  if (words.length === 1) {
    return COMMAND_CUE.test(words[0]!);
  }
  // Multi-word follow-ups still need an actionable cue. A permissive fallback
  // previously accepted ordinary TV/conversation phrases.
  if (words.some((w) => COMMAND_CUE.test(w))) return true;
  return false;
}
