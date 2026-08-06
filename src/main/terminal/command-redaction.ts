/**
 * Redact secrets from shell command lines before history persistence.
 * Fail-closed: denylisted patterns replace the whole command.
 */

const REDACTED = '[REDACTED]';

const SECRET_VALUE_RE =
  /\b(Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9_]{16,}|AIza[0-9A-Za-z_-]{35}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,})\b/gi;

// GLM / z.ai (Zhipu) keys: "<32-hex id>.<secret>" with no fixed prefix.
const GLM_KEY_RE = /\b[0-9a-f]{32}\.[A-Za-z0-9]{12,}\b/gi;

// AWS key ids are strictly uppercase — case-sensitive on purpose so lowercase
// prose like "akiaia..." in a hash is not clobbered.
const AWS_KEY_RE = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA)[0-9A-Z]{16}\b/g;

// JWT / OIDC id_token: three base64url segments, header always starts "eyJ".
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// Slack bot/user/app/refresh tokens.
const SLACK_TOKEN_RE = /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/gi;

// Google OAuth refresh tokens are opaque and start with "1//".
const GOOGLE_REFRESH_RE = /\b1\/\/[A-Za-z0-9_-]{20,}\b/g;

// Credentials embedded in a connection string / URL userinfo:
// postgres://user:password@host, mongodb+srv://u:p@h, https://u:tok@api.
// Only the password half is masked so the host stays diagnosable.
//
// The scheme repetition is bounded on purpose: an unbounded `*` rescans the
// rest of the line from every start offset hunting for "://", which is
// quadratic on long benign prose (measured ~780ms on a single 40k line, versus
// ~0.1ms for every other pattern here). No real URL scheme nears 32 chars.
const URL_CREDENTIAL_RE =
  /([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s:/@]{1,128}):([^\s/@]{1,256})@/gi;

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
  for (const pattern of [
    AWS_KEY_RE,
    JWT_RE,
    SLACK_TOKEN_RE,
    GOOGLE_REFRESH_RE,
  ]) {
    command = command.replace(pattern, () => {
      secretHits += 1;
      return REDACTED;
    });
  }
  // Mask only the password half of a connection string so the scheme/host stay
  // readable for diagnosis.
  command = command.replace(
    URL_CREDENTIAL_RE,
    (_m, scheme: string, user: string) => {
      secretHits += 1;
      return `${scheme}${user}:${REDACTED}@`;
    },
  );
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

/** PEM / OpenSSH armoured blocks: the body only matches across lines. */
const ARMOURED_BLOCK_RE =
  /-----BEGIN (?:[A-Z0-9 ]*)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]*)?PRIVATE KEY-----/g;

/** A block truncated by a crash never reaches its END marker. */
const DANGLING_BLOCK_RE =
  /-----BEGIN (?:[A-Z0-9 ]*)?PRIVATE KEY-----[\s\S]*$/;

export interface SecretTextRedactionResult {
  readonly text: string;
  readonly redacted: boolean;
}

/**
 * Redact free-form multi-line text (agent prose, mission narrative, captured
 * output) before it reaches a durable, human-readable surface.
 *
 * Differs from `redactCommandLine` in two ways that matter for prose:
 * armoured key blocks are collapsed *before* the line pass (their base64 body
 * matches no single-line pattern), and the command denylist is never applied —
 * a memory is masked, never discarded wholesale.
 */
export function redactSecretText(raw: string): SecretTextRedactionResult {
  let redacted = false;
  let text = raw.replaceAll('\r\n', '\n');

  const collapse = (): string => {
    redacted = true;
    return REDACTED;
  };
  text = text.replace(ARMOURED_BLOCK_RE, collapse);
  if (DANGLING_BLOCK_RE.test(text)) {
    text = text.replace(DANGLING_BLOCK_RE, collapse);
  }

  const lines = text.split('\n').map((line) => {
    // Length capping belongs to the caller — never truncate silently here.
    const result = redactCommandLine(line, {
      denylist: [],
      maxLength: line.length,
    });
    redacted ||= result.redacted;
    return result.command;
  });
  return { text: lines.join('\n'), redacted };
}
