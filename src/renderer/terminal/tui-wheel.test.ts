import { describe, expect, it } from 'vitest';
import {
  isTuiAlternateBuffer,
  TUI_WHEEL_PAGE_DOWN,
  TUI_WHEEL_PAGE_UP,
  tuiWheelPageSequence,
} from './tui-wheel';

describe('isTuiAlternateBuffer', () => {
  it('só trata alternate como TUI', () => {
    expect(isTuiAlternateBuffer('alternate')).toBe(true);
    expect(isTuiAlternateBuffer('normal')).toBe(false);
    expect(isTuiAlternateBuffer(undefined)).toBe(false);
    expect(isTuiAlternateBuffer('')).toBe(false);
  });
});

describe('tuiWheelPageSequence', () => {
  it('não mexe no scroll de shell/log (buffer normal)', () => {
    expect(
      tuiWheelPageSequence({ bufferType: 'normal', deltaY: -120 }),
    ).toBeNull();
    expect(
      tuiWheelPageSequence({ bufferType: 'normal', deltaY: 120 }),
    ).toBeNull();
  });

  it('no TUI, rodinha vira PageUp/PageDown', () => {
    expect(
      tuiWheelPageSequence({ bufferType: 'alternate', deltaY: -80 }),
    ).toBe(TUI_WHEEL_PAGE_UP);
    expect(
      tuiWheelPageSequence({ bufferType: 'alternate', deltaY: 80 }),
    ).toBe(TUI_WHEEL_PAGE_DOWN);
  });

  it('ignora jitter de trackpad e delta inválido', () => {
    expect(
      tuiWheelPageSequence({ bufferType: 'alternate', deltaY: -8 }),
    ).toBeNull();
    expect(
      tuiWheelPageSequence({ bufferType: 'alternate', deltaY: Number.NaN }),
    ).toBeNull();
  });
});
