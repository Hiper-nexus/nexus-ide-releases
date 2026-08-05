/**
 * Adoption repaint backstop (renderer side).
 *
 * Adopting a headless PTY paints the retained frame, then `term.reset()`s and
 * fires a double SIGWINCH so the TUI redraws at the pane's real width. When
 * the provider ignores that resize pair the reset has already ERASED the only
 * copy of the frame and the pane stays black with a live session behind it
 * (real flight 05/08, pane #es4n-4, orq).
 *
 * Recovering by asking main again does not work: `pty.replay` pulls
 * `sequence > highWater`, and main's window holds only UNACKED chunks. After
 * the first replay both are exhausted, so a second pull returns `[]` — a
 * guaranteed no-op in exactly the case that needs it. The renderer therefore
 * keeps its own bounded copy of what it painted and rewrites that locally.
 *
 * Pure helpers with no Electron or xterm imports so they stay unit-testable.
 */

/**
 * Bound on the retained frame. A fullscreen TUI redraw at 120 columns is a
 * few tens of KB; this holds several of them while keeping a chatty adoption
 * from pinning renderer memory.
 */
export const ADOPTION_TAPE_MAX_CHARS = 256_000;

/** Bounded, tail-preserving copy of the bytes painted during adoption. */
export interface AdoptionRepaintTape {
  retain(data: string): void;
  /** Everything still retained, oldest first. */
  read(): string;
  clear(): void;
}

export function createAdoptionRepaintTape(
  maxChars: number = ADOPTION_TAPE_MAX_CHARS,
): AdoptionRepaintTape {
  let retained = '';
  return {
    retain(data) {
      if (!data) return;
      // The tail describes the current frame: an eviction must drop the
      // OLDEST bytes, never the redraw that is about to be replayed.
      const next = retained + data;
      retained =
        next.length > maxChars ? next.slice(next.length - maxChars) : next;
    },
    read: () => retained,
    clear() {
      retained = '';
    },
  };
}

export type AdoptionRepaintOutcome =
  | 'painted'
  | 'already-painted'
  | 'nothing-retained';

/**
 * Repaint an adopted pane whose viewport stayed empty after the reset. The
 * duplication is invisible in an empty buffer; a black pane is not cosmetic.
 */
export function repaintAdoptedFrame(input: {
  hasContent: boolean;
  tape: string;
  write: (data: string) => void;
}): AdoptionRepaintOutcome {
  if (input.hasContent) return 'already-painted';
  if (!input.tape) return 'nothing-retained';
  input.write(input.tape);
  return 'painted';
}
