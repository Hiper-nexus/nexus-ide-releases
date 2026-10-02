import type { JevQuestion } from '../jev/jev-client';
import { redactCloudflareTokens } from '../../shared/vision-ipc';

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /eyJ[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xai-[A-Za-z0-9]{16,}/g,
  /gsk_[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /apikey_[A-Za-z0-9_]{20,}/g,
  /xi_[A-Za-z0-9]{16,}/g,
  /hf_[A-Za-z0-9]{16,}/g,
  /npm_[A-Za-z0-9]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Prefixo/sufixo do nome limitados: `[A-Za-z_]*` sem teto era quadrático numa corrida longa de letras. */
const ASSIGNMENT_PATTERN =
  /([A-Za-z_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]{0,64}\s*[=:]\s*)(["']?)([^\s"']+)/g;

/**
 * Variante case-insensitive (camelCase tipo `apiKey:`) que exige um valor com
 * cara de credencial — ≥12 chars do alfabeto de tokens e ao menos um dígito —
 * para não comer prosa ("token: the design token system").
 */
const CI_ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|access[_-]?key|secret|token|password|passwd)\s*[=:]\s*)(["']?)([A-Za-z0-9_\-./+=]{12,})/gi;

/** Substitui segredos conhecidos por [REDACTED] antes do state sair do processo. */
export function redactSecrets(text: string): string {
  let out = redactCloudflareTokens(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  out = out.replace(ASSIGNMENT_PATTERN, '$1[REDACTED]');
  return out.replace(CI_ASSIGNMENT_PATTERN, (match, p1: string, _q: string, val: string) =>
    /\d/.test(val) ? `${p1}[REDACTED]` : match,
  );
}

/** Nomes de campo que carregam credencial: o valor inteiro vira [REDACTED]. */
const SENSITIVE_FIELD_PATTERN =
  /api[_-]?key|access[_-]?key|authorization|bearer|token|secret|password|passwd|credential/i;

function isSensitiveFieldName(key: string): boolean {
  return SENSITIVE_FIELD_PATTERN.test(key);
}

/**
 * No mapa de perguntas a CHAVE é identificador (`flow:`, `inv:`, `hurdle:`),
 * não campo de credencial — `inv:credential_grant` não pode apagar a pergunta
 * inteira. Redige os valores; a chave passa intacta.
 */
export function redactQuestions(
  questions: Record<string, JevQuestion>,
): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const [k, v] of Object.entries(questions)) {
    out[k] = redactState(v) as JevQuestion;
  }
  return out;
}

/** Aplica redactSecrets recursivamente em toda string do state. */
export function redactState(state: unknown): unknown {
  if (typeof state === 'string') return redactSecrets(state);
  if (Array.isArray(state)) return state.map(redactState);
  if (state && typeof state === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
      out[k] = isSensitiveFieldName(k) ? '[REDACTED]' : redactState(v);
    }
    return out;
  }
  return state;
}

/** Trunca texto longo; keepTail preserva o fim (saída de teste, tail de log). */
export function capText(
  text: string,
  maxChars: number,
  opts?: { keepTail?: boolean },
): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return opts?.keepTail
    ? `\n[... ${omitted} chars omitted]${text.slice(omitted)}`
    : `${text.slice(0, maxChars)}\n[... ${omitted} chars omitted]`;
}
