/**
 * Supressão de eco por TRANSCRIPT (não por áudio): mantém uma janela deslizante
 * do que o próprio TTS falou recentemente e descarta transcrições do mic que
 * são eco disso (o alto-falante vazando no microfone). Complementa o AEC do
 * getUserMedia e o filtro de alucinações do Whisper — é a terceira camada que
 * impede a JARVIS de "responder a si mesma".
 */

import { isLikelySpokenEcho, normEcho } from '../../shared/voice-echo-match';

export { normEcho } from '../../shared/voice-echo-match';

export const ECHO_WINDOW_CHARS = 900;
export const ECHO_MIN_CHARS = 6;
export const ECHO_TTL_MS = 60_000;

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
    return isLikelySpokenEcho(transcript, this.window());
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
