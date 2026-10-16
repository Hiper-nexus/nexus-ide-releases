/**
 * Base de áudio do TURNO (voice-session-state). Cobre o defeito em que o
 * finishAndProcess lia a base no fim da captura e ignorava a resposta que o
 * server_vad já havia começado a tocar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  markTurnAudioBaseline,
  realtimeAudioPlayedCounter,
  realtimeAudioSuppressedCounter,
  turnAudioBaseline,
  turnAudioBaselineFor,
  turnExecution,
} from './voice-session-state';

/** O que o beginListening faz ao abrir um turno de captura. */
function openTurn(): number {
  realtimeAudioPlayedCounter.reset();
  realtimeAudioSuppressedCounter.reset();
  const token = turnExecution.beginTurn();
  markTurnAudioBaseline();
  return token;
}

function providerPlays(chunks: number, held = 0): void {
  for (let i = 0; i < chunks; i += 1) realtimeAudioPlayedCounter.tick(Date.now());
  for (let i = 0; i < held; i += 1) realtimeAudioSuppressedCounter.tick(Date.now());
}

beforeEach(() => {
  realtimeAudioPlayedCounter.reset();
  realtimeAudioSuppressedCounter.reset();
});

describe('markTurnAudioBaseline / turnAudioBaselineFor', () => {
  it('fotografa os contadores recém-zerados e o token do turno que abriu', () => {
    const token = openTurn();

    expect(turnAudioBaseline).toMatchObject({ token, played: 0, held: 0 });
    expect(turnAudioBaseline.startedAt).toBeGreaterThan(0);
    expect(turnAudioBaselineFor(token)).toBe(turnAudioBaseline);
  });

  it('o áudio tocado antes do fim da captura continua contando como resposta do turno', () => {
    const token = openTurn();
    providerPlays(4, 1); // server_vad respondeu enquanto o usuário ainda captava

    // Comportamento antigo: a base lida no fim da captura já inclui os 4 chunks.
    const endOfCaptureBase = realtimeAudioPlayedCounter.total;

    const base = turnAudioBaselineFor(token);

    expect(realtimeAudioPlayedCounter.total - base.played).toBe(4);
    expect(realtimeAudioSuppressedCounter.total - base.held).toBe(1);
    expect(realtimeAudioPlayedCounter.total - endOfCaptureBase).toBe(0);
  });

  it('foto de outro turno nunca é emprestada: cai nos totais de agora', () => {
    const first = openTurn();
    providerPlays(3);
    const second = turnExecution.beginTurn(); // captura aberta sem passar pelo mark

    expect(second).not.toBe(first);
    const base = turnAudioBaselineFor(second, 123);

    expect(base).toEqual({ token: second, played: 3, held: 0, startedAt: 123 });
    // Os chunks do turno anterior (3) não valem como evidência do novo.
    expect(realtimeAudioPlayedCounter.total - base.played).toBe(0);
  });

  it('marcar de novo no turno seguinte substitui a foto', () => {
    openTurn();
    providerPlays(2);
    const token = openTurn();

    expect(turnAudioBaseline).toMatchObject({ token, played: 0, held: 0 });
  });
});
