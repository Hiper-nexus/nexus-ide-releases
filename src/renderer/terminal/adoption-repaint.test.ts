import { describe, expect, it, vi } from 'vitest';
import {
  ADOPTION_TAPE_MAX_CHARS,
  createAdoptionRepaintTape,
  repaintAdoptedFrame,
} from './adoption-repaint';

describe('createAdoptionRepaintTape', () => {
  it('retains the bytes painted during adoption in arrival order', () => {
    const tape = createAdoptionRepaintTape();
    tape.retain('\x1b[2J');
    tape.retain('frame');
    expect(tape.read()).toBe('\x1b[2Jframe');
  });

  it('starts empty and clears back to empty', () => {
    const tape = createAdoptionRepaintTape();
    expect(tape.read()).toBe('');
    tape.retain('frame');
    tape.clear();
    expect(tape.read()).toBe('');
  });

  it('keeps the tail when retained output exceeds the cap', () => {
    const tape = createAdoptionRepaintTape(8);
    tape.retain('12345');
    tape.retain('67890');
    // The newest bytes are the ones that describe the current frame.
    expect(tape.read()).toBe('34567890');
  });

  it('keeps the tail when a single chunk is larger than the cap', () => {
    const tape = createAdoptionRepaintTape(4);
    tape.retain('abcdefgh');
    expect(tape.read()).toBe('efgh');
  });

  it('retains only replay-safe output: old terminal queries are dropped, even split across chunks (DSK-01)', () => {
    const tape = createAdoptionRepaintTape();
    tape.retain('\x1b[2Jframe\x1b[');
    tape.retain('6n\x1b]11;');
    tape.retain('?\x07\x1b[>c\x1b[32mok\x1b[0m');
    // Rewriting a query makes the new xterm answer it straight into the PTY.
    expect(tape.read()).toBe('\x1b[2Jframe\x1b[32mok\x1b[0m');
  });

  it('applies the tail cap to the sanitized output', () => {
    const tape = createAdoptionRepaintTape(8);
    tape.retain('12345\x1b[c');
    tape.retain('67890');
    expect(tape.read()).toBe('34567890');
  });

  it('caps at a bounded default so a chatty adoption cannot pin the renderer', () => {
    expect(ADOPTION_TAPE_MAX_CHARS).toBeGreaterThan(0);
    const tape = createAdoptionRepaintTape();
    tape.retain('x'.repeat(ADOPTION_TAPE_MAX_CHARS + 100));
    expect(tape.read().length).toBe(ADOPTION_TAPE_MAX_CHARS);
  });
});

describe('repaintAdoptedFrame', () => {
  it('rewrites the retained frame locally when the reset left the viewport black', () => {
    const write = vi.fn();
    const outcome = repaintAdoptedFrame({
      hasContent: false,
      tape: 'retained-frame',
      write,
    });
    // The whole point of the backstop: pixels come back from the renderer's
    // own copy. Re-pulling from main can only ever return unacked bytes, and
    // after the first replay there are none — that path is a proven no-op.
    expect(write).toHaveBeenCalledExactlyOnceWith('retained-frame');
    expect(outcome).toBe('painted');
  });

  it('leaves a viewport that already repainted untouched', () => {
    const write = vi.fn();
    const outcome = repaintAdoptedFrame({
      hasContent: true,
      tape: 'retained-frame',
      write,
    });
    expect(write).not.toHaveBeenCalled();
    expect(outcome).toBe('already-painted');
  });

  it('reports when there is nothing retained to repaint from', () => {
    const write = vi.fn();
    const outcome = repaintAdoptedFrame({ hasContent: false, tape: '', write });
    expect(write).not.toHaveBeenCalled();
    expect(outcome).toBe('nothing-retained');
  });
});
