/**
 * Bus único de saída PTY → consumidores remotos (bridge WS e relay do
 * companion). Motivo de existir: os dois caminhos tapeavam `tapSessionData`
 * separadamente e cada um encodava o MESMO chunk no MESMO
 * TerminalStreamSession — com ambos ativos, a seq avançava 2× por chunk e
 * todo consumidor via um "gap" permanente (o thin client dispararia
 * reconciliação a cada chunk). Aqui o chunk é encodado UMA vez e o frame
 * resultante é entregue a todos os consumidores interessados: uma seq, um
 * frame, zero gaps falsos.
 *
 * Fail-safe por contrato: nada aqui pode quebrar o caminho de output do PTY —
 * `wants`/`deliver` de consumidor são isolados por try/catch, e sem
 * consumidor interessado o chunk nem é encodado (custo zero no caso comum).
 */

import { tapSessionData } from '../pty/pty-manager';
import { encodeRemoteTerminalOutput } from './remote-terminal-streams';

/** Fatia de segurança para parsing barato no celular. */
const OUTPUT_SLICE_CHARS = 24_000;

export interface EncodedRemoteOutput {
  streamId: number;
  frameBase64: string;
  seq: number;
  resumeFromSeq: number;
  /**
   * Cursor DEDICADO de push (por sessão, avança só aqui no bus). O seq do
   * frame ORCA também avança em encodes de resposta (pane.read/pane.input),
   * então usá-lo para detectar perda de push geraria gaps falsos para os
   * demais inscritos toda vez que alguém desse read — cada cliente cura por
   * pushSeq, imune aos encodes de resposta.
   */
  pushSeq: number;
}

export interface EncodedOutputConsumer {
  /** Checagem barata por chunk — sem interessado, o chunk nem é encodado. */
  wants(sessionId: string): boolean;
  deliver(sessionId: string, encoded: EncodedRemoteOutput, text: string): void;
}

const consumers = new Set<EncodedOutputConsumer>();
const pushCursors = new Map<string, number>();
let tapDispose: (() => void) | null = null;

/** Cursor de push atual da sessão SEM avançar (baseline para clientes). */
export function peekPushCursor(sessionId: string): number {
  return pushCursors.get(sessionId) ?? 0;
}

/** Reset de testes/shutdown (mantém consumidores; zera só os cursores). */
export function clearPushCursors(): void {
  pushCursors.clear();
}

export function subscribeEncodedSessionOutput(
  consumer: EncodedOutputConsumer,
): () => void {
  consumers.add(consumer);
  if (!tapDispose) {
    tapDispose = tapSessionData((sessionId, data) => {
      if (!data) return;
      const interested = [...consumers].filter((candidate) => {
        try {
          return candidate.wants(sessionId);
        } catch {
          return false;
        }
      });
      if (interested.length === 0) return;
      for (let offset = 0; offset < data.length; offset += OUTPUT_SLICE_CHARS) {
        const chunk = data.slice(offset, offset + OUTPUT_SLICE_CHARS);
        // UMA seq por chunk, compartilhada por todos os consumidores.
        const frame = encodeRemoteTerminalOutput(sessionId, chunk);
        const pushSeq = (pushCursors.get(sessionId) ?? 0) + 1;
        pushCursors.set(sessionId, pushSeq);
        const encoded: EncodedRemoteOutput = { ...frame, pushSeq };
        for (const target of interested) {
          try {
            target.deliver(sessionId, encoded, chunk);
          } catch {
            // Consumidor nunca derruba o output local nem os demais.
          }
        }
      }
    });
  }
  return () => {
    consumers.delete(consumer);
    if (consumers.size === 0 && tapDispose) {
      tapDispose();
      tapDispose = null;
    }
  };
}
