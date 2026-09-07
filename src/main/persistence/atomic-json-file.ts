import { writeFileAtomic } from '../util/atomic-write';

/**
 * Persist JSON without ever exposing a partially-written destination file.
 *
 * This is a shim over the canonical writer in `src/main/util/atomic-write.ts`,
 * kept only because one of its two callers lives in `src/main/orch/`. New code
 * should import `writeJsonAtomic` or `writeFileAtomic` from there directly.
 *
 * The two implementations used to be independent, and this one was the weaker
 * duplicate: it had O_EXCL on the temp file and fsync'd the bytes, but not the
 * 0o700 parent directory, not O_NOFOLLOW, not `fchmodSync` on the descriptor,
 * and not the post-rename directory fsync. That is a trap rather than a mere
 * inconsistency — the next caller who needs to persist a token greps, finds a
 * function called `writeJsonFileAtomic` sitting in `persistence/` next to
 * `secrets-store.ts`, and reasonably concludes it is the secret-safe one.
 * Delegating makes the weaker choice unavailable.
 *
 * Output bytes are unchanged from the previous implementation, trailing newline
 * included, so an existing `settings.json` is byte-identical after this.
 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
