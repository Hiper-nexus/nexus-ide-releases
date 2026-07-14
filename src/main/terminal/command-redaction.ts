/**
 * Redact secrets from shell command lines before history persistence.
 * Fail-closed: denylisted patterns replace the whole command.
 */

const REDACTED = '[REDACTED]';

const SECRET_VALUE_RE =
  /\b(Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9_]{16,})\b/gi;

const FLAG_SECRET_RE =
  /(--?(?:token|secret|password|pass|api-key|authorization|cookie|credential)(?:=|\s+))([^\s]+)/gi;

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
  const input = raw.length > maxLength ? raw.slice(0, maxLength) : raw;

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
    redacted: secretHits > 0,
    denylisted: false,
    secretHits,
  };
}
