/** @vitest-environment jsdom */
/**
 * Prova de RELÓGIO REAL do discriminador de Space.
 *
 * As suítes existentes cobrem a máquina de estados e a camada DOM com timers
 * FALSOS — necessário para o limiar de 250ms, mas um timer falso também aceita
 * um limiar semanticamente errado sem reclamar. Este arquivo roda contra tempo
 * de parede de verdade, com KeyboardEvent real no documento real, reproduzindo
 * a rajada de digitação do operador: é o cenário que ele vai testar primeiro
 * quando voltar ("um toque tem que digitar espaço, não armar o Jarvis").
 *
 * Sem timers falsos aqui de propósito. As esperas são curtas (dezenas de ms).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { attachWindowPtt } from './voice-window-ptt';
import { HOLD_TO_TALK_THRESHOLD_MS } from './hold-to-talk';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.replaceChildren();
});

function mountTerminal(): HTMLTextAreaElement {
  const term = document.createElement('div');
  term.className = 'xterm';
  const helper = document.createElement('textarea');
  helper.className = 'xterm-helper-textarea';
  term.appendChild(helper);
  document.body.appendChild(term);
  helper.focus();
  return helper;
}

interface Recorder {
  starts: number;
  stops: number;
  spaces: number;
}

function attach(recorder: Recorder, target: HTMLElement): void {
  dispose = attachWindowPtt(
    {
      onStart: () => {
        recorder.starts += 1;
      },
      onStop: () => {
        recorder.stops += 1;
      },
      emitSpace: (_target, count) => {
        recorder.spaces += count;
      },
    },
    {
      getKeyCode: () => 'Space',
      isEnabled: () => true,
    },
  );
  void target;
}

function press(target: HTMLElement, repeat = false): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      repeat,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function release(target: HTMLElement): void {
  target.dispatchEvent(
    new KeyboardEvent('keyup', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('Space hold-to-talk — tempo de parede real', () => {
  it('rajada de digitação humana entrega TODOS os espaços e nunca arma o ditado', async () => {
    const helper = mountTerminal();
    const recorder: Recorder = { starts: 0, stops: 0, spaces: 0 };
    attach(recorder, helper);

    // Sete espaços numa cadência humana rápida (~45ms de tecla baixa).
    for (let i = 0; i < 7; i += 1) {
      press(helper);
      await sleep(45);
      release(helper);
      await sleep(25);
    }

    expect(recorder.spaces).toBe(7);
    // "Jarvis pisca" = armar e abortar. Nem um start pode ter acontecido.
    expect(recorder.starts).toBe(0);
    expect(recorder.stops).toBe(0);
  });

  it('segurar de verdade arma o ditado UMA vez e para ao soltar', async () => {
    const helper = mountTerminal();
    const recorder: Recorder = { starts: 0, stops: 0, spaces: 0 };
    attach(recorder, helper);

    press(helper);
    await sleep(HOLD_TO_TALK_THRESHOLD_MS + 120);

    expect(recorder.starts).toBe(1);
    // Um hold de fala não pode vazar espaço para o terminal.
    expect(recorder.spaces).toBe(0);

    release(helper);
    expect(recorder.stops).toBe(1);
  });

  it('auto-repeat do SO antes do limiar é suprimido; soltar cedo = 1 espaço, sem ditado', async () => {
    const helper = mountTerminal();
    const recorder: Recorder = { starts: 0, stops: 0, spaces: 0 };
    attach(recorder, helper);

    press(helper);
    await sleep(40);
    press(helper, true);
    await sleep(40);
    press(helper, true);
    release(helper);
    await sleep(HOLD_TO_TALK_THRESHOLD_MS);

    expect(recorder.starts).toBe(0);
    expect(recorder.spaces).toBe(1);
  });

  it('segurar além do limiar com auto-repeat do SO no meio ainda arma o ditado', async () => {
    const helper = mountTerminal();
    const recorder: Recorder = { starts: 0, stops: 0, spaces: 0 };
    attach(recorder, helper);

    press(helper);
    await sleep(100);
    press(helper, true);
    await sleep(HOLD_TO_TALK_THRESHOLD_MS);

    expect(recorder.starts).toBe(1);
    expect(recorder.spaces).toBe(0);
    release(helper);
    expect(recorder.stops).toBe(1);
  });

  it('toque logo abaixo do limiar ainda é espaço, não fala', async () => {
    const helper = mountTerminal();
    const recorder: Recorder = { starts: 0, stops: 0, spaces: 0 };
    attach(recorder, helper);

    press(helper);
    await sleep(Math.max(0, HOLD_TO_TALK_THRESHOLD_MS - 90));
    release(helper);
    await sleep(HOLD_TO_TALK_THRESHOLD_MS);

    expect(recorder.spaces).toBe(1);
    expect(recorder.starts).toBe(0);
  });

  it('soltar antes do limiar cancela o timer — nada arma depois do keyup', async () => {
    const helper = mountTerminal();
    const recorder: Recorder = { starts: 0, stops: 0, spaces: 0 };
    attach(recorder, helper);

    press(helper);
    await sleep(30);
    release(helper);
    // Muito além do limiar: um timer órfão apareceria aqui.
    await sleep(HOLD_TO_TALK_THRESHOLD_MS + 150);

    expect(recorder.starts).toBe(0);
    expect(recorder.spaces).toBe(1);
  });
});
