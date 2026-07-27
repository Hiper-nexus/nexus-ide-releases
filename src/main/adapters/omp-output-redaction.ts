const REDACTED = '[REDACTED]';
const MAX_REDACTION_DEPTH = 12;

const SENSITIVE_ENV_NAME_RE =
  /(?:API_KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|BEARER)$/i;

/**
 * Redactor for untrusted OMP child output.
 *
 * Exact values are captured from the main-owned launch environment and never
 * serialized. Generic patterns are a second line of defence for credentials
 * emitted by tools/providers that were not part of that environment.
 */
export class OmpChildOutputRedactor {
  private exactValues: string[];
  private readonly streamTails = new Map<string, string>();

  constructor(
    exactValues: readonly string[] = [],
    env: Readonly<Record<string, string>> = {},
  ) {
    const values = new Set<string>();
    for (const value of exactValues) {
      if (typeof value === 'string' && value.length > 0) values.add(value);
    }
    for (const [name, value] of Object.entries(env)) {
      if (
        SENSITIVE_ENV_NAME_RE.test(name) &&
        typeof value === 'string' &&
        value.length > 0
      ) {
        values.add(value);
      }
    }
    // Replace longer overlapping values first.
    this.exactValues = [...values].sort(
      (left, right) => right.length - left.length,
    );
  }

  text(value: string): string {
    return redactGenericCredentials(this.replaceExact(value));
  }

  /**
   * Redacts exact values even when a provider splits one credential over
   * multiple NDJSON delta frames. Only a suffix that is still a possible
   * secret prefix is delayed; normal text continues to stream immediately.
   */
  stream(streamId: string, value: string): string {
    const combined = this.replaceExact(
      `${this.streamTails.get(streamId) ?? ''}${value}`,
    );
    let retainedChars = 0;
    for (const secret of this.exactValues) {
      const maxPrefix = Math.min(secret.length - 1, combined.length);
      for (let length = maxPrefix; length > retainedChars; length -= 1) {
        if (combined.endsWith(secret.slice(0, length))) {
          retainedChars = length;
          break;
        }
      }
    }
    const emitLength = combined.length - retainedChars;
    const emitted = combined.slice(0, emitLength);
    if (retainedChars > 0) {
      this.streamTails.set(streamId, combined.slice(emitLength));
    } else {
      this.streamTails.delete(streamId);
    }
    return redactGenericCredentials(emitted);
  }

  flush(streamId: string): string {
    const tail = this.streamTails.get(streamId) ?? '';
    this.streamTails.delete(streamId);
    return this.text(tail);
  }

  clearStreams(): void {
    this.streamTails.clear();
  }

  clear(): void {
    this.clearStreams();
    this.exactValues.fill('');
    this.exactValues = [];
  }

  private replaceExact(value: string): string {
    let redacted = value;
    for (const secret of this.exactValues) {
      redacted = redacted.split(secret).join(REDACTED);
    }
    return redacted;
  }

  value<T>(value: T): T {
    return redactValue(value, (text) => this.text(text)) as T;
  }
}

export function redactGenericCredentials(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:sk-|gh[pousr]_|npm_)[A-Za-z0-9_-]{12,}\b/g,
      REDACTED,
    )
    .replace(
      /([?&](?:token|secret|password|api[_-]?key|authorization|cookie|credential)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(--?(?:token|secret|password|pass|api-key|authorization|cookie|credential)(?:=|\s+))[^\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b((?=[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|CREDENTIAL|AUTH|BEARER))[A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g,
      '$1=[REDACTED]',
    )
    .replace(
      /((?:["']?)(?:token|secret|password|pass|api[_-]?key|authorization|cookie|credential)(?:["']?)\s*[:=]\s*["'])[^"'\r\n]+(["'])/gi,
      '$1[REDACTED]$2',
    );
}

function redactValue(
  value: unknown,
  redactText: (value: string) => string,
  depth = 0,
): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACTION_DEPTH) return '[REDACTED_DEPTH]';
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, redactText, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactValue(entry, redactText, depth + 1),
    ]),
  );
}
