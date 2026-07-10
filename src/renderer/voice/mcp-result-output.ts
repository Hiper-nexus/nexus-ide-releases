const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const UNSUPPORTED = '[UNSUPPORTED]';

const MAX_RESULT_CHARS = 16_000;
const MAX_STRING_CHARS = 12_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 75;
const MAX_KEY_CHARS = 128;
const MAX_DEPTH = 7;
const INITIAL_PREVIEW_CHARS = 7_500;

const SECRET_KEY_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|credential|bearer)$/i;

const PRIVATE_KEY_RE =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const GEMINI_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const GITHUB_KEY_RE = /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g;
const NPM_KEY_RE = /\bnpm_[A-Za-z0-9_]{16,}\b/g;
const ENV_ASSIGNMENT_RE =
  /(^|[\r\n])(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)([^\r\n]*)/g;
const SECRET_ENV_NAME_RE =
  /(^|_)(token|secret|password|pass|key|credential|auth|bearer)($|_)/i;
const URL_CREDENTIAL_RE =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const SECRET_ASSIGNMENT_RE =
  /(\b(?:api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|cookie|credential)\b\s*[:=]\s*)(["'`]?)([^\s,"'`;]+)/gi;

function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_RE, '[REDACTED_PRIVATE_KEY]')
    .replace(
      ENV_ASSIGNMENT_RE,
      (match, lineStart: string, prefix: string, name: string) =>
        SECRET_ENV_NAME_RE.test(name) ? `${lineStart}${prefix}${REDACTED}` : match,
    )
    .replace(URL_CREDENTIAL_RE, '$1[REDACTED]@')
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(OPENAI_KEY_RE, REDACTED)
    .replace(GEMINI_KEY_RE, REDACTED)
    .replace(GITHUB_KEY_RE, REDACTED)
    .replace(NPM_KEY_RE, REDACTED)
    .replace(
      SECRET_ASSIGNMENT_RE,
      (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}`,
    );
}

function boundedString(value: string): string {
  const redacted = redactSensitiveText(value);
  if (redacted.length <= MAX_STRING_CHARS) return redacted;
  return `${redacted.slice(0, MAX_STRING_CHARS)}...${TRUNCATED}`;
}

function sanitizeValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (SECRET_KEY_RE.test(key)) return REDACTED;
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (value === null) return null;
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return UNSUPPORTED;
  }

  if (seen.has(value)) return TRUNCATED;
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, '', depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(TRUNCATED);
    return items;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: boundedString(value.name),
      message: boundedString(value.message),
    };
  }

  const source = value as Record<string, unknown>;
  const entries = Object.entries(source).slice(0, MAX_OBJECT_KEYS);
  const sanitized = Object.fromEntries(
    entries.map(([childKey, childValue]) => {
      const safeKey = boundedString(childKey).slice(0, MAX_KEY_CHARS);
      return [safeKey, sanitizeValue(childValue, childKey, depth + 1, seen)];
    }),
  );
  if (Object.keys(source).length > MAX_OBJECT_KEYS) {
    sanitized.__truncated_keys = TRUNCATED;
  }
  return sanitized;
}

function boundedPreview(serialized: string): { truncated: true; preview: string } {
  let previewLength = Math.min(INITIAL_PREVIEW_CHARS, serialized.length);
  let result = {
    truncated: true as const,
    preview: `${serialized.slice(0, previewLength)}...${TRUNCATED}`,
  };
  while (JSON.stringify(result).length > MAX_RESULT_CHARS && previewLength > 0) {
    previewLength = Math.floor(previewLength * 0.8);
    result = {
      truncated: true,
      preview: `${serialized.slice(0, previewLength)}...${TRUNCATED}`,
    };
  }
  return result;
}

/**
 * Produces a JSON-safe, secret-redacted and size-bounded copy for a Live
 * provider. The original MCP result is never mutated.
 */
export function sanitizeMcpResultOutput(result: unknown): unknown {
  const sanitized = sanitizeValue(result, '', 0, new WeakSet<object>());
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_RESULT_CHARS) return sanitized;
  return boundedPreview(serialized);
}
