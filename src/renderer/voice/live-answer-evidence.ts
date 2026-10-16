/**
 * Espera do transcript final que ENCERRA quando o provider já respondeu.
 *
 * Com `server_vad` (Grok Voice, OpenAI) o servidor decide o fim da fala antes
 * do endpoint local e já começa a responder — em áudio ou numa tool nativa —
 * enquanto `finishAndProcess` ainda aguarda `conversation.item.input_audio_
 * transcription.completed`. Esse evento pode vir depois da resposta ou nem
 * vir (transcrição desligada no servidor). Esperar a janela inteira
 * (4,8 s no wake, 6,5 s no click, 3,5 s no reply) prende o pipeline `busy`
 * com a Jarvis já falando e atrasa a continuidade da conversa.
 *
 * Aqui o wait do waiter corre contra uma sondagem barata do estado do
 * provider. A regra de evidência é a MESMA do rescue
 * (`classifyLiveRescueSnapshot`):
 *  - tool nativa: prova definitiva — encerra na hora (o transcript não muda o
 *    desfecho, o turno já pertence à tool);
 *  - áudio do provider: o transcript ainda filtra eco/lixo depois, então ganha
 *    uma carência curta para chegar antes de encerrar.
 *
 * Sem nenhuma evidência nada muda: o wait vai até o timeout do waiter e o
 * mute continua sendo degradado como antes (ANTI-MUTE intacto).
 */
import {
  classifyLiveRescueSnapshot,
  type LiveRescueSnapshot,
} from './live-mute-rescue';
import type { RealtimeTranscriptWaitOutcome } from './realtime-transcript-waiter';

/** Quanto o transcript ainda pode demorar depois da PRIMEIRA prova de áudio. */
export const PROVIDER_ANSWER_TRANSCRIPT_GRACE_MS = 450;
export const PROVIDER_ANSWER_POLL_MS = 50;

export type EarlyAnswerEvidence = 'tool' | 'audio';

export interface TranscriptOrAnswerOutcome extends RealtimeTranscriptWaitOutcome {
  /**
   * Presente SÓ quando o wait terminou antes do timeout por prova de resposta
   * do provider (e sem transcript). Ausente em transcript real, timeout e
   * supersede.
   */
  early?: EarlyAnswerEvidence;
}

export interface WaitForTranscriptOrAnswerOptions {
  /** Liga a saída antecipada. Desligada (Classic pode falar), vira o wait puro. */
  enabled: boolean;
  /** Abre o wait do waiter — chamado UMA vez, já escopado ao turno. */
  wait: () => Promise<RealtimeTranscriptWaitOutcome>;
  /** Libera o wait pendente deste turno sem transcript e sem supersede. */
  settleEarly: () => void;
  read: () => LiveRescueSnapshot;
  turnToken: number;
  /** Referência das provas de tool (`lastToolAt >= startedAt`). */
  startedAt: number;
  /** Chunks do provider já vistos quando o TURNO abriu (não no fim da captura). */
  playedBaseline: number;
  heldBaseline: number;
  graceMs?: number;
  pollMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

export async function waitForTranscriptOrProviderAnswer(
  opts: WaitForTranscriptOrAnswerOptions,
): Promise<TranscriptOrAnswerOutcome> {
  let settled = false;
  const waited = opts.wait().then((outcome) => {
    settled = true;
    return outcome;
  });
  if (!opts.enabled) return waited;

  const now = opts.now ?? Date.now;
  const delay =
    opts.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = opts.graceMs ?? PROVIDER_ANSWER_TRANSCRIPT_GRACE_MS;
  const pollMs = opts.pollMs ?? PROVIDER_ANSWER_POLL_MS;

  const watchProvider = async (): Promise<EarlyAnswerEvidence | null> => {
    let audioSeenAt: number | null = null;
    while (!settled) {
      await delay(pollMs);
      // O waiter pode ter resolvido durante o delay (transcript, timeout ou
      // supersede): nunca mexer num wait que já não é o nosso.
      if (settled) return null;
      let evidence: ReturnType<typeof classifyLiveRescueSnapshot>;
      try {
        evidence = classifyLiveRescueSnapshot(opts.read(), opts);
      } catch {
        // Leitura de estado nunca derruba o turno: sem prova, o wait segue.
        evidence = null;
      }
      // Outro turno assumiu: o waiter dele resolve o nosso como superseded.
      if (evidence === 'superseded') return null;
      if (evidence === 'tool') return 'tool';
      if (evidence === 'audio') {
        audioSeenAt ??= now();
        if (now() - audioSeenAt >= graceMs) return 'audio';
      }
    }
    return null;
  };

  const early = await Promise.race([waited.then(() => null), watchProvider()]);
  if (!early) return waited;

  opts.settleEarly();
  const outcome = await waited;
  // Um transcript que chegou no mesmo tick vence a saída antecipada.
  if (outcome.text !== null || outcome.superseded) return outcome;
  return { ...outcome, early };
}
