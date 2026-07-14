import { createHash } from 'node:crypto';

/** Stable SHA-256 idempotency key for CommandBlock inserts. */
export function computeCommandBlockIdempotencyKey(parts: {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly command: string;
  readonly cwd: string;
}): string {
  return createHash('sha256')
    .update(parts.sessionId)
    .update('\0')
    .update(String(parts.startedAt))
    .update('\0')
    .update(parts.command)
    .update('\0')
    .update(parts.cwd)
    .digest('hex');
}
