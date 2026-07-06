import crypto from 'node:crypto';

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(t: string): string {
  return crypto.createHash('sha256').update(t).digest('hex');
}

export function safeEqualHash(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
