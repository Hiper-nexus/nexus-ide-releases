/**
 * Detects, from a CLI's terminal output, that the current account hit a limit
 * and work can't continue on it. Input must be ANSI-stripped. Pure function —
 * unit tested. The failover engine feeds it a rolling window of recent output.
 */

export type LimitKind = 'rate-limit' | 'quota' | 'auth';

export interface LimitHit {
  kind: LimitKind;
  reason: string;
  /** Suggested cooldown in ms before this account is retried. */
  cooldownMs: number;
}

interface Pattern {
  kind: LimitKind;
  re: RegExp;
  cooldownMs: number;
}

const HOUR = 60 * 60 * 1000;

// Order matters: quota/credit exhaustion before generic rate-limit.
const PATTERNS: Pattern[] = [
  // Credits / quota exhausted — long cooldown (won't reset on its own soon).
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /insufficient[_\s]?quota/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /credit balance is too low/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /quota (?:exceeded|exhausted)/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /\b402\b|payment required/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /out of credits|no credits/i },
  // Rate / usage limit — resets within a window.
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /usage limit reached/i },
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /reached your (?:usage|5-hour|weekly) limit/i },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /rate[_\s]?limit(?:ed|_error)?/i },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /\b429\b|too many requests/i },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /resource[_\s]?exhausted/i },
  { kind: 'rate-limit', cooldownMs: 15 * 60 * 1000, re: /overloaded(?:_error)?/i },
  // Auth expiry — switching accounts may recover.
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /\b401\b|authentication[_\s]?error/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /invalid[_\s]?(?:api[_\s]?key|x-api-key)/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /oauth token (?:expired|revoked)/i },
];

/**
 * Try to read an explicit reset time ("resets at 3pm", "try again in 42
 * minutes") to size the cooldown precisely; falls back to the pattern default.
 */
function parseResetCooldown(text: string): number | null {
  const mins = /try again in (\d+)\s*(?:minute|min)/i.exec(text);
  if (mins) return Number(mins[1]) * 60 * 1000;
  const secs = /try again in (\d+)\s*(?:second|sec)/i.exec(text);
  if (secs) return Number(secs[1]) * 1000;
  const hrs = /(?:resets?|available again) in (\d+)\s*hour/i.exec(text);
  if (hrs) return Number(hrs[1]) * HOUR;
  return null;
}

export function detectLimit(text: string): LimitHit | null {
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    const parsed = parseResetCooldown(text);
    return {
      kind: pattern.kind,
      reason: match[0].trim().slice(0, 120),
      cooldownMs: parsed ?? pattern.cooldownMs,
    };
  }
  return null;
}
