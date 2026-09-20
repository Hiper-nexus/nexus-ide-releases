import { describe, expect, it, vi } from 'vitest';
import { resumeTerminalVisibilityBeforePaint } from './terminal-visibility-resume';

describe('resumeTerminalVisibilityBeforePaint', () => {
  it('resumes WebGL, fits and propagates size before flushing output', () => {
    const calls: string[] = [];

    const resumed = resumeTerminalVisibilityBeforePaint({
      resumeRenderer: () => calls.push('resume'),
      fitVisibleGrid: () => {
        calls.push('fit');
        return true;
      },
      propagateSize: () => calls.push('resize'),
      flushOutput: () => calls.push('flush'),
      repaint: () => calls.push('repaint'),
    });

    expect(resumed).toBe(true);
    expect(calls).toEqual([
      'resume',
      'fit',
      'resize',
      'flush',
      'repaint',
    ]);
  });

  it('does not flush into the previous grid when the slot cannot be fitted', () => {
    const flushOutput = vi.fn();
    const repaint = vi.fn();

    const resumed = resumeTerminalVisibilityBeforePaint({
      resumeRenderer: vi.fn(),
      fitVisibleGrid: () => {
        throw new Error('slot is not measurable yet');
      },
      propagateSize: vi.fn(),
      flushOutput,
      repaint,
    });

    expect(resumed).toBe(false);
    expect(flushOutput).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
  });

  it('does not flush into the previous grid when fit reports failure without throwing (F-356)', () => {
    // fitHostGrid (the real fitVisibleGrid implementation) never throws — it
    // catches its own errors and reports failure as `false`. The interface
    // used to type fitVisibleGrid as `(): void`, so that `false` was silently
    // discarded and the reveal path fell through to propagate/flush/repaint
    // against the STALE grid, which is what produced the empty
    // blocks/spinners reported after maximizing a Codex pane.
    const flushOutput = vi.fn();
    const repaint = vi.fn();
    const propagateSize = vi.fn();

    const resumed = resumeTerminalVisibilityBeforePaint({
      resumeRenderer: vi.fn(),
      fitVisibleGrid: () => false,
      propagateSize,
      flushOutput,
      repaint,
    });

    expect(resumed).toBe(false);
    expect(propagateSize).not.toHaveBeenCalled();
    expect(flushOutput).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
  });

  it('keeps the DOM fallback operable when WebGL or PTY resize fails', () => {
    const calls: string[] = [];

    const resumed = resumeTerminalVisibilityBeforePaint({
      resumeRenderer: () => {
        calls.push('resume');
        throw new Error('GPU unavailable');
      },
      fitVisibleGrid: () => {
        calls.push('fit');
        return true;
      },
      propagateSize: () => {
        calls.push('resize');
        throw new Error('transient IPC failure');
      },
      flushOutput: () => calls.push('flush'),
      repaint: () => calls.push('repaint'),
    });

    expect(resumed).toBe(true);
    expect(calls).toEqual([
      'resume',
      'fit',
      'resize',
      'flush',
      'repaint',
    ]);
  });
});
