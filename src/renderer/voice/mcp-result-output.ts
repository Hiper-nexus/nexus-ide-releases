import { redactVisibleSecrets } from '../../shared/vision-ipc';

export { redactVisibleSecrets };

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
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|credential|bearer|auth)$/i;

function boundedString(value: string): string {
  const redacted = redactVisibleSecrets(value);
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
