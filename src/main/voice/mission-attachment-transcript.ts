import fs from 'node:fs';
import path from 'node:path';
import type { TranscribeRequest } from '../../shared/voice-ipc';
import { isLikelyNoiseTranscript } from '../../shared/voice-noise';
import { MISSION_TRANSCRIPT_SUFFIX } from '../orch/mission-attachment-staging';
import { currentProbes, getVoiceConfig } from './voice-config-store';
import { transcribe } from './stt-service';

/**
 * Transcrição de áudio anexado à missão, em background, no MESMO STT que o
 * ditado já usa (cadeia configurada do voice-config-store + stt-service). O
 * resultado vira `<áudio>.transcript.txt` ao lado do arquivo de intake — é de
 * lá que `stageMissionAttachmentsIntoExecutionScope` copia para o escopo de
 * execução e é o que `readMissionAttachmentTranscript` lê no prompt. Toda
 * falha é silenciosa: sem sidecar, o prompt já cai em
 * "Sem transcrição disponível".
 */

/** Espelha o teto de item do intake (14 MiB): acima disso o base64 da STT não cabe. */
export const MISSION_TRANSCRIPT_MAX_BYTES = 14 * 1024 * 1024;
/** Orçamento total do job: a cadeia tem timeout por provedor, isto é o teto do job inteiro. */
export const MISSION_TRANSCRIPT_TIMEOUT_MS = 90_000;

/** Extensões iguais às de `AUDIO_EXT` em mission-attachment-staging (o gate do prompt). */
const AUDIO_MIME_BY_EXT: Readonly<Record<string, TranscribeRequest['mime']>> = {
  '.aac': 'audio/aac',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
};

/**
 * Roda uma transcrição e grava o sidecar. Devolve true só quando o texto
 * ficou no disco. Nunca lança: quem chama em background não precisa tratar.
 */
export async function runMissionAttachmentTranscript(
  absoluteAudio: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<boolean> {
  const sidecar = absoluteAudio + MISSION_TRANSCRIPT_SUFFIX;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const mime = AUDIO_MIME_BY_EXT[path.extname(absoluteAudio).toLowerCase()];
    if (!mime) return false;
    if (fs.existsSync(sidecar)) return false;
    const stat = await fs.promises.stat(absoluteAudio);
    if (!stat.isFile() || stat.size <= 0) return false;
    if (stat.size > (options.maxBytes ?? MISSION_TRANSCRIPT_MAX_BYTES)) {
      console.warn(
        '[mission-attachment-transcript] áudio acima do teto, sem transcrição:',
        stat.size,
        'bytes',
      );
      return false;
    }
    const bytes = await fs.promises.readFile(absoluteAudio);
    const request: TranscribeRequest = {
      audioBase64: bytes.toString('base64'),
      mime,
      // Irrelevante aqui: só o PCM cru (audio/pcm) usa taxa, e anexo tem container.
      sampleRate: 16_000,
      // Literal: a cadeia Whisper padrão traduz PT→EN para o ditado; missão
      // quer o texto falado, na língua do áudio.
      translate: false,
    };
    const job = transcribe(request, getVoiceConfig(), currentProbes());
    const watchdog = new Promise<null>((resolve) => {
      timer = setTimeout(
        () => resolve(null),
        options.timeoutMs ?? MISSION_TRANSCRIPT_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([job, watchdog]);
    // Se o watchdog venceu, o job segue em voo com timeout próprio de provedor;
    // sem este handler a rejeição futura derrubaria o main.
    job.catch(() => undefined);
    if (!result || !result.ok || !result.text) return false;
    const text = result.text.trim();
    if (!text || isLikelyNoiseTranscript(text)) return false;
    const tmp = `${sidecar}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, sidecar);
    return true;
  } catch (error) {
    console.warn(
      '[mission-attachment-transcript] transcrição falhou (segue sem sidecar):',
      error instanceof Error ? error.message : error,
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const inFlight = new Set<string>();

/** Dispara a transcrição sem bloquear quem importa o anexo; idempotente por caminho. */
export function scheduleMissionAttachmentTranscript(absoluteAudio: string): void {
  if (inFlight.has(absoluteAudio)) return;
  inFlight.add(absoluteAudio);
  void runMissionAttachmentTranscript(absoluteAudio)
    .catch((error) => {
      console.warn(
        '[mission-attachment-transcript] job em background falhou:',
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      inFlight.delete(absoluteAudio);
    });
}
