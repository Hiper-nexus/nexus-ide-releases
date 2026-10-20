import { describe, expect, it } from 'vitest';
import { consumeMyVoiceFocus, requestMyVoiceFocus } from './my-voice-focus';

describe('my-voice-focus (F-1616)', () => {
  it('um pedido vale uma vez só', () => {
    expect(consumeMyVoiceFocus()).toBe(false);
    requestMyVoiceFocus();
    requestMyVoiceFocus();
    expect(consumeMyVoiceFocus()).toBe(true);
    expect(consumeMyVoiceFocus()).toBe(false);
  });
});
