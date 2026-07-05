/**
 * Supressão de eco por TRANSCRIPT (não por áudio): mantém uma janela deslizante
 * do que o próprio TTS falou recentemente e descarta transcrições do mic que
 * são eco disso (o alto-falante vazando no microfone). Complementa o AEC do
 * getUserMedia e o filtro de alucinações do Whisper — é a terceira camada que
 * impede a JARVIS de "responder a si mesma".
 *
 * Matching: texto normalizado (minúsculas, sem acento/pontuação). É eco quando
 * a transcrição é substring contígua da fala recente OU quando ≥80% das suas
 * palavras significativas (>2 chars) aparecem na janela. Entradas expiram por
 * TTL — fala antiga do TTS não pode censurar o usuário minutos depois.
 */

export const ECHO_WINDOW_CHARS = 300;
export const ECHO_MIN_CHARS = 6;
export const ECHO_TTL_MS = 60_000;
const WORD_OVERLAP_THRESHOLD = 0.8;

/** Normaliza para comparação: minúsculas, sem acentos, sem pontuação. */
export function normEcho(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SpokenEntry {
  text: string;
  at: number;
}

export class EchoSuppressor {
  private entries: SpokenEntry[] = [];

  constructor(private nowFn: () => number = Date.now) {}

  /** Registra texto que o TTS acabou de falar (chamar no sucesso do speak). */
  record(text: string): void {
    const norm = normEcho(text);
    if (!norm) return;
    this.entries.push({ text: norm, at: this.nowFn() });
    this.prune();
  }

  /** True quando a transcrição do mic é eco da fala recente do TTS. */
  isEcho(transcript: string): boolean {
    this.prune();
    const norm = normEcho(transcript);
    // Muito curto para afirmar eco, ou nada falado recentemente → deixa passar.
    if (norm.length < ECHO_MIN_CHARS) return false;
    const window = this.window();
    if (!window) return false;

    if (window.includes(norm)) return true;

    const words = norm.split(' ').filter((w) => w.length > 2);
    if (words.length === 0) return false;
    const spoken = new Set(window.split(' '));
    const hits = words.filter((w) => spoken.has(w)).length;
    return hits / words.length >= WORD_OVERLAP_THRESHOLD;
  }

  reset(): void {
    this.entries = [];
  }

  private window(): string {
    return this.entries.map((e) => e.text).join(' ');
  }

  private prune(): void {
    const cutoff = this.nowFn() - ECHO_TTL_MS;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    // Cap de chars: derruba as entradas mais antigas até caber na janela.
    while (this.entries.length > 1 && this.window().length > ECHO_WINDOW_CHARS) {
      this.entries.shift();
    }
    if (this.entries.length === 1 && this.entries[0].text.length > ECHO_WINDOW_CHARS) {
      this.entries[0] = {
        ...this.entries[0],
        text: this.entries[0].text.slice(-ECHO_WINDOW_CHARS),
      };
    }
  }
}

/** Singleton do processo main — TTS grava, o fluxo de STT consulta. */
export const echoSuppressor = new EchoSuppressor();
