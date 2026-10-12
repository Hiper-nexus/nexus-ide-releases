/**
 * Pós-processamento do ditado no modo CODE, depois da STT: reescrita em
 * inglês para o agente e, se ela falhar, a garantia de inglês pela própria
 * STT. Puro e injetável — voice-ipc só fornece as portas.
 */
import { DICTATION_CODE_PRIMING_PROMPT } from '../../shared/dictation-vocabulary';
import type { TranscribeRequest, TranscribeResult } from '../../shared/voice-ipc';
import type { CodePromptPolishResult } from './code-prompt-polish';

type OkTranscribe = Extract<TranscribeResult, { ok: true }>;

export interface CodeDictationPorts {
  polish(text: string): Promise<CodePromptPolishResult>;
  /** A MESMA STT de novo, para o mesmo áudio (caminho de falha). */
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  log(
    level: 'info' | 'warn',
    event: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void;
  now?(): number;
}

export async function finalizeCodeDictation(
  request: TranscribeRequest,
  result: OkTranscribe,
  sttMs: number,
  ports: CodeDictationPorts,
): Promise<TranscribeResult> {
  const now = ports.now ?? Date.now;
  const polishStartedAt = now();
  const polish = await ports.polish(result.text);
  const polishMs = now() - polishStartedAt;

  let delivered: TranscribeResult = { ...result, text: polish.text };
  let fallback: { ok: boolean; provider: string | null } | undefined;
  if (!polish.polished) {
    ports.log('warn', 'stt.codePolishSkipped', 'modo CODE seguiu com o texto da STT', {
      reason: polish.reason,
      provider: result.provider,
    });
    // A STT transcreveu LITERAL contando com a reescrita — chave presente não
    // é chave saudável (expirada, timeout, saída suspeita). Sem a reescrita o
    // CODE entregaria português: a STT transcreve o MESMO áudio pedindo
    // tradução. Só o caminho de falha paga esse tempo.
    if (request.translate === false) {
      const translated = await ports.transcribe({
        ...request,
        translate: true,
        prompt: DICTATION_CODE_PRIMING_PROMPT,
      });
      fallback = {
        ok: translated.ok,
        provider: translated.ok ? translated.provider : null,
      };
      if (translated.ok) delivered = translated;
    }
  }

  // F-1392: o log de uso (dictation-session) mede o que a reescrita fez —
  // tamanhos e motivo, nunca o texto.
  if (delivered.ok) {
    delivered = {
      ...delivered,
      polish: {
        ok: polish.polished,
        rawChars: result.text.length,
        ...(polish.reason ? { reason: polish.reason } : {}),
      },
    };
  }

  // Quem transcreveu e o que ouviu ANTES da reescrita, e onde foi a espera
  // depois de parar de falar (STT x reescrita) — inclusive no caminho de falha.
  ports.log('info', 'stt.dictationRaw', result.text.slice(0, 400), {
    provider: result.provider,
    fallbackNote: result.fallbackNote,
    mode: 'code',
    translate: request.translate === true,
    polished: polish.polished,
    final: (delivered.ok ? delivered.text : polish.text).slice(0, 400),
    sttMs,
    polishMs,
    ...(fallback ? { translateFallback: fallback } : {}),
  });
  return delivered;
}
