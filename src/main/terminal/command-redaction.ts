/**
 * Redact secrets from shell command lines before history persistence.
 * Fail-closed: denylisted patterns replace the whole command.
 */

const REDACTED = '[REDACTED]';

const SECRET_VALUE_RE =
  /\b(Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9_]{16,}|AIza[0-9A-Za-z_-]{35}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,})\b/gi;

// GLM / z.ai (Zhipu) keys: "<32-hex id>.<secret>" with no fixed prefix.
const GLM_KEY_RE = /\b[0-9a-f]{32}\.[A-Za-z0-9]{12,}\b/gi;

// Secret carried inside an HTTP header value, e.g. -H "x-goog-api-key: AIza…".
// The value must be secret-shaped (≥12 token chars) so prose like
// "authorization: read the docs" is not clobbered.
const HEADER_SECRET_RE =
  /((?:x-[a-z0-9-]*api-key|x-goog-api-key|x-api-key|authorization|api-key)\s*:\s*)([A-Za-z0-9._~+/=-]{12,})/gi;

// Note: no bare `key` alternative — it over-redacts benign flags like
// `sort --key=2` and `openssl -key file.pem`. Provider key values are matched by
// SECRET_VALUE_RE regardless of the flag.
const FLAG_SECRET_RE =
  /(--?(?:token|secret|password|pass|api[-_]?key|authorization|cookie|credential|bearer)(?:=|\s+))(\S+)/gi;

const ENV_ASSIGN_RE =
  /\b((?=[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|CREDENTIAL|AUTH|BEARER))[A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g;

/** Default denylist: never store these commands even redacted. */
export const DEFAULT_COMMAND_DENYLIST: readonly RegExp[] = [
  /^\s*history\b/i,
  /^\s*export\s+[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)\b/i,
  /^\s*printenv\b/i,
  /^\s*env\s*$/i,
];

export interface CommandRedactionResult {
  readonly command: string;
  readonly redacted: boolean;
  readonly denylisted: boolean;
  readonly secretHits: number;
}

export function redactCommandLine(
  raw: string,
  options: {
    readonly denylist?: readonly RegExp[];
    readonly maxLength?: number;
  } = {},
): CommandRedactionResult {
  const maxLength = options.maxLength ?? 16_384;
  const denylist = options.denylist ?? DEFAULT_COMMAND_DENYLIST;
  const truncated = raw.length > maxLength ? raw.slice(0, maxLength) : raw;
  const hasControlCharacters = /[\x00-\x1f\x7f]/.test(truncated);
  const input = truncated.replace(/[\x00-\x1f\x7f]+/g, ' ');

  for (const pattern of denylist) {
    if (pattern.test(input)) {
      return {
        command: '[DENYLISTED]',
        redacted: true,
        denylisted: true,
        secretHits: 0,
      };
    }
  }

  let secretHits = 0;
  let command = input;

  command = command.replace(SECRET_VALUE_RE, () => {
    secretHits += 1;
    return REDACTED;
  });
  command = command.replace(GLM_KEY_RE, () => {
    secretHits += 1;
    return REDACTED;
  });
  // Header values run after the value patterns so a "Authorization: Bearer <t>"
  // is fully redacted by SECRET_VALUE_RE first; this catches opaque header
  // secrets with no recognizable value prefix (e.g. x-api-key: <opaque>).
  command = command.replace(HEADER_SECRET_RE, (_m, prefix: string) => {
    secretHits += 1;
    return `${prefix}${REDACTED}`;
  });
  command = command.replace(FLAG_SECRET_RE, (_m, prefix: string) => {
    secretHits += 1;
    return `${prefix}${REDACTED}`;
  });
  command = command.replace(ENV_ASSIGN_RE, (_m, key: string) => {
    secretHits += 1;
    return `${key}=${REDACTED}`;
  });

  return {
    command,
    redacted: secretHits > 0 || hasControlCharacters,
    denylisted: false,
    secretHits,
  };
}
