import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HOLD_TO_TALK_SAFETY_MAX_MS,
  HOLD_TO_TALK_SILENCE_MS,
  HOLD_TO_TALK_MAX_MS,
  HOLD_TO_TALK_MIN_MS,
  HOLD_TO_TALK_THRESHOLD_MS,
  HoldToTalkDiscriminator,
  clampHoldToTalkMs,
} from './hold-to-talk';

describe('fiação viva do hold-to-talk', () => {
  it('o PTT da janela usa o discriminador em vez de armar no keydown', () => {
    const source = readFileSync(
      new URL('./voice-window-ptt.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('HoldToTalkDiscriminator');
    expect(source).toContain('discriminator.thresholdElapsed()');
    // O bug original: onStart() chamado direto no handler de keydown.
    expect(source).not.toMatch(/onKeyDown[\s\S]*?callbacks\.onStart\(\)/u);
  });

  it('o controller entrega o espaço retido no pane focado (emitSpace fiado)', () => {
    const source = readFileSync(
      new URL('./voice-controller.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('emitSpace:');
    expect(source).toContain("writeToPane(paneId, ' '.repeat(count))");
  });

  it('PTT e ditado usam holdToTalkAutoStop — nunca o auto-stop do wake (envio prematuro)', () => {
    const source = readFileSync(
      new URL('./voice-controller.ts', import.meta.url),
      'utf8',
    );
    // O bug: holdGuard com maxMs/silenceMs = 60s encerrava a captura no meio
    // da fala e o finishAndProcess injetava o trecho ANTES do keyup.
    expect(source).toContain('holdToTalkAutoStop(');
    expect(source).toMatch(/beginListening\(\s*capture\.current!,\s*holdToTalkAutoStop\(/u);
    expect(source).not.toContain('PTT_HOLD_MAX_MS');
    expect(source).toContain('HOLD_TO_TALK_SAFETY_MAX_MS');
    expect(source).toContain('HOLD_TO_TALK_SILENCE_MS');
  });
});

describe('contrato de fim de fala do hold-to-talk', () => {
  it('silêncio nunca encerra (Infinity) e o maxMs é válvula de segurança, não teto de ditado', () => {
    expect(HOLD_TO_TALK_SILENCE_MS).toBe(Number.POSITIVE_INFINITY);
    // Um ditado longo legítimo (2–3 min com pausas) nunca pode ser cortado.
    expect(HOLD_TO_TALK_SAFETY_MAX_MS).toBeGreaterThanOrEqual(3 * 60_000);
    // A válvula ainda precisa existir: tecla presa / keyup perdido.
    expect(HOLD_TO_TALK_SAFETY_MAX_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe('HoldToTalkDiscriminator', () => {
  it('um toque rápido devolve o espaço e NUNCA arma o ditado', () => {
    const d = new HoldToTalkDiscriminator();
    const down = d.keyDown({ repeat: false });
    expect(down.suppressKey).toBe(true);
    expect(down.startDictation).toBe(false);
    expect(down.armThreshold).toBe(true);

    const up = d.keyUp();
    expect(up.startDictation).toBe(false);
    expect(up.stopDictation).toBe(false);
    expect(up.emitSpaces).toBe(1);
    expect(d.state).toBe('idle');
  });

  it('segurar além do limiar arma o ditado uma única vez', () => {
    const d = new HoldToTalkDiscriminator();
    d.keyDown({ repeat: false });
    const elapsed = d.thresholdElapsed();
    expect(elapsed.startDictation).toBe(true);
    expect(d.state).toBe('talking');

    // Um segundo disparo do timer não re-arma.
    expect(d.thresholdElapsed().startDictation).toBe(false);
  });

  it('soltar depois de armado encerra o ditado e não digita espaço', () => {
    const d = new HoldToTalkDiscriminator();
    d.keyDown({ repeat: false });
    d.thresholdElapsed();

    const up = d.keyUp();
    expect(up.stopDictation).toBe(true);
    expect(up.emitSpaces).toBe(0);
    expect(d.state).toBe('idle');
  });

  it('nunca arma-e-aborta: um toque não produz start seguido de stop (sem piscar)', () => {
    const d = new HoldToTalkDiscriminator();
    const events = [d.keyDown({ repeat: false }), d.keyUp()];
    expect(events.some((e) => e.startDictation)).toBe(false);
    expect(events.some((e) => e.stopDictation)).toBe(false);
  });

  it('auto-repeat antes do limiar é suprimido: a decisão é só por tempo', () => {
    const d = new HoldToTalkDiscriminator();
    d.keyDown({ repeat: false });

    const repeat = d.keyDown({ repeat: true });
    expect(repeat.suppressKey).toBe(true);
    expect(repeat.emitSpaces).toBe(0);
    expect(repeat.startDictation).toBe(false);
    expect(d.state).toBe('pending');

    // Segurou além do limiar, mesmo com repeats do SO no meio: fala.
    expect(d.thresholdElapsed().startDictation).toBe(true);
    expect(d.state).toBe('talking');
  });

  it('soltar antes do limiar após repeats entrega exatamente 1 espaço', () => {
    const d = new HoldToTalkDiscriminator();
    d.keyDown({ repeat: false });
    d.keyDown({ repeat: true });
    d.keyDown({ repeat: true });

    const up = d.keyUp();
    expect(up.emitSpaces).toBe(1);
    expect(up.startDictation).toBe(false);
    expect(d.state).toBe('idle');
  });

  it('repeat órfão (sem keydown retido) não vira espaço nem ditado', () => {
    const d = new HoldToTalkDiscriminator();
    const repeat = d.keyDown({ repeat: true });
    expect(repeat.suppressKey).toBe(false);
    expect(repeat.emitSpaces).toBe(0);
    expect(d.state).toBe('idle');
  });

  it('auto-repeat durante o ditado continua suprimido', () => {
    const d = new HoldToTalkDiscriminator();
    d.keyDown({ repeat: false });
    d.thresholdElapsed();

    const repeat = d.keyDown({ repeat: true });
    expect(repeat.suppressKey).toBe(true);
    expect(repeat.emitSpaces).toBe(0);
    expect(d.state).toBe('talking');
  });

  it('keyup sem keydown correspondente é inerte', () => {
    const d = new HoldToTalkDiscriminator();
    const up = d.keyUp();
    expect(up).toEqual({
      suppressKey: false,
      startDictation: false,
      stopDictation: false,
      emitSpaces: 0,
      armThreshold: false,
    });
  });

  it('cancelar (blur) encerra ditado em curso e descarta o espaço retido', () => {
    const talking = new HoldToTalkDiscriminator();
    talking.keyDown({ repeat: false });
    talking.thresholdElapsed();
    expect(talking.cancel().stopDictation).toBe(true);
    expect(talking.state).toBe('idle');

    const pending = new HoldToTalkDiscriminator();
    pending.keyDown({ repeat: false });
    const cancelled = pending.cancel();
    expect(cancelled.stopDictation).toBe(false);
    expect(cancelled.emitSpaces).toBe(0);
    expect(pending.state).toBe('idle');
  });

  it('um segundo keydown não-repeat enquanto pendente não duplica o espaço retido', () => {
    const d = new HoldToTalkDiscriminator();
    d.keyDown({ repeat: false });
    const again = d.keyDown({ repeat: false });
    expect(again.armThreshold).toBe(false);
    expect(again.emitSpaces).toBe(0);
    expect(d.keyUp().emitSpaces).toBe(1);
  });

  it('o limiar padrão (450ms) é maior que um espaço de digitação lento e cabe na faixa configurável', () => {
    // Contrato novo: o teto subiu de 400 para 600 ms porque o auto-repeat do SO
    // deixou de ser sinal de digitação (é suprimido em 'pending').
    expect(HOLD_TO_TALK_THRESHOLD_MS).toBe(450);
    expect(HOLD_TO_TALK_THRESHOLD_MS).toBeGreaterThanOrEqual(HOLD_TO_TALK_MIN_MS);
    expect(HOLD_TO_TALK_THRESHOLD_MS).toBeLessThanOrEqual(600);
    expect(HOLD_TO_TALK_MIN_MS).toBe(250);
    expect(HOLD_TO_TALK_MAX_MS).toBe(1000);
  });

  it('clampHoldToTalkMs prende na faixa e cai no padrão para lixo', () => {
    expect(clampHoldToTalkMs(100)).toBe(250);
    expect(clampHoldToTalkMs(5000)).toBe(1000);
    expect(clampHoldToTalkMs(600.4)).toBe(600);
    expect(clampHoldToTalkMs(undefined)).toBe(450);
    expect(clampHoldToTalkMs(Number.NaN)).toBe(450);
  });
});
