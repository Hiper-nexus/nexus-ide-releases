import { detectLimit, type LimitHit } from './limit-detector';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
const WINDOW = 4_000;
/**
 * F-999: depois do eco de um pack de continuidade o worker novo lê e cita o
 * motivo da troca ("model_not_found") — texto que o detector reconhece, e a
 * recusa de modelo não tem sonda de provider que a refute. Nesse intervalo um
 * sinal de MODELO lido no terminal só vale na 2ª ocorrência em saída nova (a
 * CLI repetindo ou redesenhando o erro); o relato da própria CLI (observer)
 * vale na hora, e cota/taxa/auth não esperam — a sonda decide (F-249).
 */
export const CONTINUITY_ECHO_CONFIRM_MS = 120_000;
const NOISE = /retrying\s+in\s+\d|attempt\s+\d+\s*\/\s*\d+|api\s*error|overloaded_error|service unavailable|status[\s:(]*5\d\d\b|\bhttp\s*5\d\d\b/i;
export interface FailoverTextProposal {
  readonly hit?: LimitHit;
  /** F-999: sinal de modelo citado logo depois do pack, à espera da 2ª ocorrência. */
  readonly held?: LimitHit;
  readonly scanned?: boolean;
  readonly slowScanMs?: number;
  readonly unavailable?: boolean;
  readonly episode: number;
  readonly progressChars: number;
  readonly freshError: boolean;
  readonly at: number;
}
function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length >= 20);
}
function signature(line: string): string | null { const match = NOISE.exec(line); return match ? line.slice(match.index) : null; }
/** All scan-before-progress state lives together; Main only accepts proposals. */
export class FailoverTextReducer {
  #buffer = ''; #pending = 0; #lastScan = 0; #firedAt = -Infinity;
  slowUntil = 0; #held: Array<{ text: string; at: number }> = []; #heldChars = 0; #unavailable = false;
  #episode = 0; #transient = false; #progress = 0; #packAt = -Infinity; #heldModelAt = -Infinity;
  /** F-1484: o último limite disparado tinha prova estruturada do provedor. */
  #firedConfirmed = false;
  #seen = new Set<string>(); #errors = new Set<string>();
  #remember(line: string) { if (this.#seen.size >= 2_000) this.#seen.clear(); this.#seen.add(line); }
  control(value: { firedAt?: number; endTransient?: boolean; rejectTransient?: boolean }) {
    if (value.firedAt !== undefined) { this.#firedAt = value.firedAt; this.#buffer = ''; }
    if (value.endTransient || value.rejectTransient || value.firedAt !== undefined) { this.#transient = false; this.#progress = 0; this.#seen.clear(); this.#errors.clear(); }
  }
  observer(hit: LimitHit, at: number): FailoverTextProposal[] { return this.#hit(hit, hit.reason, '', at, true); }
  /** F-999: o pack colado/digitado nesta sessão (a TUI pode mostrar só "[Pasted text …]"). */
  input(data: string, at: number): void { if (data.includes(FAILOVER_HANDOFF_HEADER)) this.#packAt = at; }
  feed(text: string, at: number, flush = false): FailoverTextProposal[] {
    const out: FailoverTextProposal[] = [];
    if (this.#unavailable) return [{ episode: this.#episode, progressChars: this.#progress, freshError: false, unavailable: true, at }];
    if (at < this.slowUntil) {
      if (text) { this.#held.push({ text, at }); this.#heldChars += text.length; }
      if (this.#heldChars > 262_144) { this.#held = []; this.#heldChars = 0; this.#unavailable = true; return [{ episode: this.#episode, progressChars: this.#progress, freshError: false, unavailable: true, at }]; }
      return out;
    }
    if (this.#held.length) {
      const held = this.#held; this.#held = []; this.#heldChars = 0;
      for (const part of held) out.push(...this.feed(part.text, at, true));
    }
    // Overlapping half-window strides inspect admitted text, including quota
    // evidence in the middle of a flood. No tail-only replacement.
    if (text.length === 0) { if (flush && this.#pending) out.push(...this.#scan('', at)); return out; }
    for (let offset = 0; offset < text.length; offset += WINDOW / 2) {
      const part = text.slice(offset, offset + WINDOW / 2);
      if (at < this.slowUntil) { out.push(...this.feed(text.slice(offset), at, flush)); break; }
      if (at - this.#firedAt < 30_000) { this.#noteProgress(part); continue; }
      this.#buffer = (this.#buffer + part).slice(-WINDOW); this.#pending += part.length;
      // O header termina em "]": só a parte que o completa paga a busca (inclusive partido entre passadas).
      if (part.includes(']') && this.#buffer.slice(-(part.length + FAILOVER_HANDOFF_HEADER.length - 1)).includes(FAILOVER_HANDOFF_HEADER)) this.#packAt = at;
      if (this.#transient || at - this.#lastScan >= 250 || this.#pending >= WINDOW / 2 || flush) out.push(...this.#scan(part, at));
    }
    if (this.#transient) out.push({ episode: this.#episode, progressChars: this.#progress, freshError: false, at });
    return out;
  }
  #scan(text: string, at: number): FailoverTextProposal[] {
    this.#lastScan = at; this.#pending = 0;
    const started = Date.now();
    const hit = detectLimit(this.#buffer);
    const scanMs = Math.max(0, Date.now() - started);
    if (scanMs > 25) this.slowUntil = at + 5_000;
    if (hit) { const window = this.#buffer; this.#buffer = ''; return this.#hit(hit, window, text, at).map((proposal) => ({ ...proposal, ...(scanMs > 25 ? { slowScanMs: scanMs } : {}) })); }
    this.#noteProgress(text); return [{ episode: this.#episode, progressChars: this.#progress, freshError: false, scanned: true, ...(scanMs > 25 ? { slowScanMs: scanMs } : {}), at }];
  }
  #hit(hit: LimitHit, detected: string, text: string, at: number, observed = false): FailoverTextProposal[] {
    // F-1484: o texto do limite chega pelo PTY antes do hook do provedor. A
    // confirmação estruturada (StopFailure) que chega no rearme de um hit SEM
    // confirmação o promove — nunca é descartada.
    const promotes = observed && hit.confirmed === true && !this.#firedConfirmed;
    if (at - this.#firedAt < 30_000 && !promotes) return [];
    if (hit.kind === 'model' && !observed && at - this.#packAt < CONTINUITY_ECHO_CONFIRM_MS && at - this.#heldModelAt >= CONTINUITY_ECHO_CONFIRM_MS) {
      // Sem rearm: a varredura segue, e o buffer já foi zerado — só texto NOVO confirma.
      this.#heldModelAt = at;
      return [{ held: hit, scanned: true, episode: this.#episode, progressChars: this.#progress, freshError: false, at }];
    }
    let freshError = false;
    if (hit.kind === 'transient') {
      const detectedLines = lines(detected);
      if (this.#transient) for (const line of detectedLines) {
        const sig = signature(line);
        if (sig !== null && !this.#errors.has(sig)) { this.#errors.add(sig); freshError = true; }
        this.#remember(line);
      }
      else {
        this.#transient = true; this.#episode++; this.#progress = 0;
        this.#seen = new Set(detectedLines);
        this.#errors = new Set(detectedLines.map(signature).filter((v): v is string => v !== null));
      }
      if (freshError) this.#progress = 0;
      this.#noteProgress(text);
    } else { this.control({ firedAt: at }); this.#firedConfirmed = hit.confirmed === true; }
    return [{ hit, scanned: true, episode: this.#episode, progressChars: this.#progress, freshError, at }];
  }
  #noteProgress(text: string) {
    if (!this.#transient) return;
    for (const line of lines(text)) {
      if (this.#seen.has(line)) continue;
      this.#remember(line); const sig = signature(line);
      if (sig !== null) this.#errors.add(sig); else this.#progress += line.length;
    }
  }
}
