import { CLEF_AUDIO_MODEL, hasAudioRecipientConsent, type DecisionAudio, type DecisionRoute, type DecisionSettings, type DecisionUsageReceipt } from '../../shared/decision-models';
import { judgeClef, type ClefConnection } from '../decision-models/clef-client';
import { validateDecisionAudio } from '../decision-models/decision-audio';
import { getClefConnection, getDecisionAvailability, getDecisionSettings } from '../decision-models/decision-availability';
import { onDecisionConfigurationChanged } from '../decision-models/decision-revision';
import type { DecisionAvailability } from '../decision-models/decision-routing';
import { decisionResultUsage } from '../decision-models/decision-usage';
import { jevAnswerProbabilities, recordJevDecision, recordJevNoAnswer, type JevNoAnswerReason } from '../jev/jev-decision-log';

/**
 * F-1161: segunda opinião do Clef-omni sobre o clipe que acabou de ativar o
 * assistente. TV e conversa ambiente já abriram missões sozinhas
 * (wake-score-gate.ts); o detector acústico e o STT só conferem se a frase de
 * ativação apareceu, não QUEM falou com o assistente. O Clef ouve o MESMO
 * trecho e ajuda a descartar ativações de TV/ambiente, só com alta confiança.
 *
 * Dois pontos de uso: o detector acústico (caminho sempre ligado de hoje,
 * `gateAcousticWake`) e o STT passivo (`startWakeClefConfirmation` em
 * paralelo; o renderer mantém esse caminho desligado por doutrina, mas o
 * Main já o protege se ele voltar).
 * Erro, timeout, falta de chave ou de autorização = comportamento de antes.
 */

/** Conservador: na dúvida a ativação passa. Só "ambiente" com ≥ 0,8 cancela. */
export const WAKE_CLEF_AMBIENT_THRESHOLD = 0.8;
/** Mesmo teto do STT passivo na nuvem (STT_PASSIVE_WAKE_CLOUD_TIMEOUT_MS): o Clef nunca alonga o orçamento da ativação. */
export const WAKE_CLEF_TIMEOUT_MS = 2_000;
/** Prazo do cliente no detector acústico (o caminho sempre ligado de hoje). */
export const WAKE_CLEF_ACOUSTIC_TIMEOUT_MS = 1_200;
/** Folga do relógio de segurança por cima do timeout do próprio cliente. */
const SETTLE_GRACE_MS = 250;
/**
 * Espera máxima real da detecção acústica: prazo do cliente + folga do relógio
 * de segurança (~1,45 s). O texto de consentimento promete "até ~1,5 s"; o
 * pré-roll do renderer guarda 2,5–3 s, então o começo do pedido falado depois
 * da frase de ativação continua no turno mesmo no pior caso.
 */
export const WAKE_CLEF_ACOUSTIC_MAX_WAIT_MS = WAKE_CLEF_ACOUSTIC_TIMEOUT_MS + SETTLE_GRACE_MS;
/** Janela enviada ao Clef no caminho acústico: a frase de ativação e o que soou logo antes. */
export const WAKE_CLEF_CLIP_MS = 2_000;
/** O que os dois detectores acústicos aceitam (cabeça PT-BR "Ei Jarvis" e SpeechKit `hey_jarvis`). */
export const ACOUSTIC_WAKE_PHRASE = '"Hey Jarvis" (or "Ei Jarvis")';
const CLIP_SAMPLE_RATE = 16_000;
/** Rede de segurança do cache de elegibilidade; a invalidação normal vem de onDecisionConfigurationChanged. */
const ELIGIBILITY_TTL_MS = 30_000;
const QUESTION_ID = 'ambient';

const ROUTE: DecisionRoute = { provider: 'clef', model: CLEF_AUDIO_MODEL, policyVersion: 'jev-clef-luna-v1',
  evidence: 'capability', reason: 'wake-audio' };

export type WakeClefVerdict =
  | { kind: 'ambient'; probability: number }
  | { kind: 'speech'; probability: number }
  | { kind: 'no-answer'; reason: JevNoAnswerReason };

export interface WakeClefPending {
  /** Nunca rejeita: falha vira `no-answer`. */
  readonly verdict: Promise<WakeClefVerdict>;
  /** O STT não achou o nome: a resposta não serve mais a ninguém. */
  cancel(): void;
}

export interface WakeClefDeps {
  getSettings: () => DecisionSettings;
  getAvailability: (settings: DecisionSettings) => DecisionAvailability;
  getConnection: (settings: DecisionSettings) => ClefConnection | undefined;
  fetch?: typeof fetch;
  record: typeof recordJevDecision;
  recordNoAnswer: typeof recordJevNoAnswer;
  timeoutMs: number;
}

const defaults: WakeClefDeps = {
  getSettings: getDecisionSettings, getAvailability: getDecisionAvailability, getConnection: getClefConnection,
  record: recordJevDecision, recordNoAnswer: recordJevNoAnswer, timeoutMs: WAKE_CLEF_TIMEOUT_MS,
};

/** As quatro chaves do operador: modo com Clef, Clef-omni escolhido, autorização de áudio e credencial pronta. */
export function wakeClefEligible(settings: DecisionSettings, availability: DecisionAvailability): boolean {
  return settingsAllowWakeAudio(settings) && availability.clef;
}

/** Só preferências: decide antes de tocar no cofre ou de codificar o clipe. */
function settingsAllowWakeAudio(settings: DecisionSettings): boolean {
  return settings.mode !== 'jev' && settings.mode !== 'luna' && settings.clefModel === CLEF_AUDIO_MODEL
    && hasAudioRecipientConsent(settings, 'clef');
}

/** A frase citada é a que o detector de fato ouviu, nunca o nome da persona. */
function wakeQuestion(wakePhrase: string) {
  return { [QUESTION_ID]: { type: 'noul' as const,
    instructions: `Listen to this short clip captured by an always-on microphone; it ends right where a wake-word detector heard ${wakePhrase}. Is it TV, video, music, background noise or people talking to each other, rather than someone saying ${wakePhrase} directly to the voice assistant right now?`,
    criteria: { true: 'TV, media, ambient sound or another conversation', false: 'a person addressing the assistant now' } } };
}

async function runConfirmation(audio: readonly DecisionAudio[], wakePhrase: string, connection: ClefConnection,
  signal: AbortSignal, deps: WakeClefDeps): Promise<WakeClefVerdict> {
  let usage: DecisionUsageReceipt | undefined;
  let failure: JevNoAnswerReason | undefined;
  try {
    const result = await judgeClef({
      state: { task: 'wake-word-confirmation', wakePhrase, spokenLanguage: 'pt-BR' },
      // A pergunta só faz sentido com o clipe: se o áudio não puder sair, nada sai.
      questions: wakeQuestion(wakePhrase), audio, audioRequired: true, signal, timeoutMs: deps.timeoutMs, retryOnTimeout: false,
      onUsage: receipt => { usage = receipt; }, onNoAnswer: reason => { failure = reason; },
    }, connection, { fetch: deps.fetch });
    const answer = result?.answers[QUESTION_ID];
    if (!result || answer?.type !== 'noul' || !Number.isFinite(answer.noul)) {
      const reason = failure ?? 'malformed';
      // Cancelado antes de qualquer requisição não custou nada: não polui o diário.
      if (reason !== 'aborted' || (usage?.requestCount ?? 0) > 0 || result) {
        deps.recordNoAnswer({ surface: 'wakeConfirm', reason, model: CLEF_AUDIO_MODEL, provider: 'clef', route: ROUTE,
          usage: usage ?? (result ? undefined : { inputTokens: 0, usd: 0, requestCount: 0, durationMs: 0, usageIncomplete: false }) });
      }
      return { kind: 'no-answer', reason };
    }
    const ambient = answer.noul >= WAKE_CLEF_AMBIENT_THRESHOLD;
    deps.record({ surface: 'wakeConfirm', model: result.model, questions: [QUESTION_ID],
      probabilities: jevAnswerProbabilities(result.answers), decision: ambient ? 'suppress-ambient' : 'allow',
      ...decisionResultUsage({ ...result, route: { ...ROUTE, model: result.model } }) });
    return ambient ? { kind: 'ambient', probability: answer.noul } : { kind: 'speech', probability: answer.noul };
  } catch {
    return { kind: 'no-answer', reason: 'internal-error' };
  }
}

/**
 * Últimos ~2 s do microfone do wake, só em memória, para o Clef ouvir o mesmo
 * trecho que o detector acústico acabou de aceitar. Nada é gravado em disco.
 */
export class WakeClipRecorder {
  private frames: Float32Array[] = [];
  private samples = 0;

  constructor(private readonly maxSamples = Math.round(CLIP_SAMPLE_RATE * WAKE_CLEF_CLIP_MS / 1_000)) {}

  push(frame: Float32Array): void {
    this.frames.push(Float32Array.from(frame));
    this.samples += frame.length;
    while (this.frames.length > 1 && this.samples - this.frames[0].length >= this.maxSamples) {
      this.samples -= this.frames.shift()!.length;
    }
  }

  clear(): void { this.frames = []; this.samples = 0; }

  /** Amostras hoje em memória (no máximo ~2 s + um frame). */
  get retainedSamples(): number { return this.samples; }

  /** WAV PCM16 mono 16 kHz em base64, ou null sem áudio suficiente (menos de 0,25 s). */
  wavBase64(): string | null {
    if (this.samples < CLIP_SAMPLE_RATE / 4) return null;
    const all = new Float32Array(this.samples);
    let offset = 0;
    for (const frame of this.frames) { all.set(frame, offset); offset += frame.length; }
    const pcm = all.subarray(Math.max(0, all.length - this.maxSamples));
    const header = Buffer.alloc(44);
    const dataBytes = pcm.length * 2;
    header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(CLIP_SAMPLE_RATE, 24); header.writeUInt32LE(CLIP_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii'); header.writeUInt32LE(dataBytes, 40);
    const body = Buffer.alloc(dataBytes);
    for (let index = 0; index < pcm.length; index++) {
      const sample = Math.max(-1, Math.min(1, Number.isFinite(pcm[index]) ? pcm[index] : 0));
      body.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), index * 2);
    }
    return Buffer.concat([header, body]).toString('base64');
  }
}

/**
 * Gate do detector acústico: com as chaves ligadas, a detecção só é
 * entregue depois do veredito (ou do teto). Ambiente confiante = descartada.
 * Sem chaves, erro, timeout ou dúvida, `deliver` roda como antes.
 */
export function gateAcousticWake(
  input: { clip: WakeClipRecorder; wakePhrase?: string; deliver: () => void;
    log?: (suppressed: boolean, verdict: WakeClefVerdict | null) => void;
    /** Dá ao chamador o cancelamento da consulta (revogação em voo). */
    onPending?: (pending: WakeClefPending) => void },
  overrides: Partial<WakeClefDeps> = {},
): Promise<boolean> | null {
  let wanted = false;
  try { wanted = settingsAllowWakeAudio({ ...defaults, ...overrides }.getSettings()); } catch { wanted = false; }
  const wavBase64 = wanted ? input.clip.wavBase64() : null;
  const pending = wavBase64 ? startWakeClefConfirmation({ wavBase64, wakePhrase: input.wakePhrase ?? ACOUSTIC_WAKE_PHRASE },
    { timeoutMs: WAKE_CLEF_ACOUSTIC_TIMEOUT_MS, ...overrides }) : null;
  if (!pending) { input.deliver(); return null; }
  try { input.onPending?.(pending); } catch { /* opcional */ }
  return shouldSuppressWake(pending, true, overrides.timeoutMs ?? WAKE_CLEF_ACOUSTIC_TIMEOUT_MS)
    .catch(() => ({ suppress: false, verdict: null }))
    .then(result => {
      try { input.log?.(result.suppress, result.verdict); } catch { /* log é opcional */ }
      if (!result.suppress) {
        try { input.deliver(); } catch { console.warn('[wake] entrega da detecção falhou após o Clef'); }
      }
      return result.suppress;
    });
}

/**
 * Dispara junto com o STT passivo. `null` = nenhuma das chaves está ligada,
 * ou o clipe não é um WAV válido: nada sai da máquina.
 */
export function startWakeClefConfirmation(
  input: { wavBase64: string; wakePhrase?: string }, overrides: Partial<WakeClefDeps> = {},
): WakeClefPending | null {
  const deps = { ...defaults, ...overrides };
  try {
    const settings = deps.getSettings();
    // Preferências primeiro: com o áudio desligado, nem o cofre de credenciais é lido.
    if (!settingsAllowWakeAudio(settings) || !wakeClefEligible(settings, deps.getAvailability(settings))) return null;
    const connection = deps.getConnection(settings);
    if (!connection || connection.model !== CLEF_AUDIO_MODEL || connection.audioConsent !== true) return null;
    const audio: DecisionAudio[] = [{ content_type: 'audio/wav', base64: input.wavBase64 }];
    if (!validateDecisionAudio(audio)) return null;
    const controller = new AbortController();
    const wakePhrase = input.wakePhrase?.trim() || ACOUSTIC_WAKE_PHRASE;
    return { verdict: runConfirmation(audio, wakePhrase, connection, controller.signal, deps), cancel: () => controller.abort() };
  } catch {
    return null;
  }
}

/**
 * Depois do STT: sem o nome na transcrição o Clef é cancelado; com o nome,
 * espera a resposta dentro do teto e devolve `true` só para ambiente confiante.
 */
export async function shouldSuppressWake(
  pending: WakeClefPending | null, containsWake: boolean, timeoutMs = WAKE_CLEF_TIMEOUT_MS,
): Promise<{ suppress: boolean; verdict: WakeClefVerdict | null }> {
  if (!pending) return { suppress: false, verdict: null };
  if (!containsWake) { pending.cancel(); return { suppress: false, verdict: null }; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<WakeClefVerdict>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'no-answer', reason: 'timeout' }), timeoutMs + SETTLE_GRACE_MS);
  });
  try {
    const verdict = await Promise.race([pending.verdict, deadline]);
    if (verdict.kind === 'no-answer' && verdict.reason === 'timeout') pending.cancel();
    return { suppress: verdict.kind === 'ambient', verdict };
  } catch {
    pending.cancel();
    return { suppress: false, verdict: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fio do detector acústico no `voice-ipc`: dono do gravador, da trava de uma
 * confirmação por vez e da revogação. Sem as quatro chaves ligadas nenhum
 * frame fica em memória; mudar modo, variante, autorização ou credencial
 * aborta a consulta em voo (a ativação segue como antes) e limpa o gravador.
 */
export class AcousticWakeConfirmer {
  private readonly clip = new WakeClipRecorder();
  private eligible = false;
  private eligibleUntil = 0;
  private pending: WakeClefPending | null = null;
  private inFlight = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly deps: Partial<WakeClefDeps> = {},
    subscribe: (listener: () => void) => () => void = onDecisionConfigurationChanged,
    private readonly now: () => number = Date.now,
  ) {
    this.unsubscribe = subscribe(() => this.revoke());
  }

  /** Frame do mic do wake: só é guardado com Clef no modo, Clef-omni, autorização de áudio e credencial. */
  push(frame: Float32Array): void {
    if (!this.isEligible()) { this.clip.clear(); return; }
    this.clip.push(frame);
  }

  /**
   * Detecção do engine. `null` = entregue na hora (sem chaves) ou descartada
   * por já haver uma confirmação em voo do mesmo trecho.
   */
  detect(input: { deliver: () => void; log?: (suppressed: boolean, verdict: WakeClefVerdict | null) => void }): Promise<boolean> | null {
    // Uma confirmação por vez: detecções repetidas do mesmo trecho não abrem
    // uma segunda chamada nem um segundo turno.
    if (this.inFlight) return null;
    const gate = gateAcousticWake({ clip: this.clip, deliver: input.deliver, log: input.log,
      onPending: pending => { this.pending = pending; } }, this.deps);
    // O clipe já foi codificado (ou não serve): nada dele fica em memória.
    this.clip.clear();
    if (!gate) return null;
    this.inFlight = true;
    return gate.finally(() => { this.inFlight = false; this.pending = null; });
  }

  get retainedSamples(): number { return this.clip.retainedSamples; }

  clear(): void { this.clip.clear(); }

  /** Configuração de decisão mudou: relê as chaves, aborta a consulta em voo e esquece o áudio. */
  revoke(): void {
    this.eligibleUntil = 0;
    this.clip.clear();
    this.pending?.cancel();
  }

  dispose(): void { this.revoke(); this.unsubscribe(); }

  private isEligible(): boolean {
    const at = this.now();
    if (at < this.eligibleUntil) return this.eligible;
    const deps = { ...defaults, ...this.deps };
    try {
      const settings = deps.getSettings();
      // Preferências primeiro: com o áudio desligado, nem o cofre é consultado.
      this.eligible = settingsAllowWakeAudio(settings) && wakeClefEligible(settings, deps.getAvailability(settings));
    } catch {
      this.eligible = false;
    }
    this.eligibleUntil = at + ELIGIBILITY_TTL_MS;
    return this.eligible;
  }
}
