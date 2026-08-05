import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HOLD_TO_TALK_THRESHOLD_MS,
  HoldToTalkDiscriminator,
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

  it('auto-repeat antes do limiar é digitação: libera a tecla e devolve o espaço retido', () => {
    const d = new HoldToTalkDiscriminator();
    d.keyDown({ repeat: false });

    const repeat = d.keyDown({ repeat: true });
    expect(repeat.suppressKey).toBe(false);
    expect(repeat.emitSpaces).toBe(1);
    expect(repeat.startDictation).toBe(false);
    expect(d.state).toBe('typing');

    // O limiar que já estava armado não pode armar ditado depois disso.
    expect(d.thresholdElapsed().startDictation).toBe(false);

    // Repeats seguintes seguem passando direto para o terminal.
    const next = d.keyDown({ repeat: true });
    expect(next.suppressKey).toBe(false);
    expect(next.emitSpaces).toBe(0);
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

  it('soltar após digitação por repeat não encerra ditado nenhum', () => {
    const d = new HoldToTalkDiscriminator();
    d.keyDown({ repeat: false });
    d.keyDown({ repeat: true });

    const up = d.keyUp();
    expect(up.stopDictation).toBe(false);
    expect(up.suppressKey).toBe(false);
    expect(d.state).toBe('idle');
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

  it('o limiar é curto o bastante para push-to-talk e longo o bastante para um toque', () => {
    expect(HOLD_TO_TALK_THRESHOLD_MS).toBeGreaterThanOrEqual(150);
    expect(HOLD_TO_TALK_THRESHOLD_MS).toBeLessThanOrEqual(400);
  });
});
