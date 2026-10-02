/**
 * Limpeza server-side do texto de um relato de bug. Funções puras: nada de I/O, nada de estado.
 *
 * O app desktop já limpa o que coleta, mas o servidor nunca confia nisso: um cliente adulterado (ou um bug do
 * app) mandaria a chave de API de alguém direto para o nosso banco. Por isso TUDO o que é texto livre e tudo
 * do diagnóstico passa por aqui antes de ser gravado.
 *
 * Ordem importa: primeiro tiramos o que é invisível (senão um segredo partido por um caractere de largura
 * zero escaparia das máscaras), depois mascaramos, e só então arrumamos o layout e cortamos o tamanho.
 */

export const REDACTED = '[oculto]';
const EMAIL_MASK = '[email]';
const USER_MASK = '[usuario]';

/** Sequências ANSI de cor/cursor (CSI) e de título/link (OSC): lixo de terminal, e nunca texto do usuário. */
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g;
/** NEL, LS e PS são quebras de linha em Unicode; viram \n antes de qualquer outra coisa. */
const UNICODE_LINE_BREAKS = /\r\n|\r|\u0085|\u2028|\u2029/g;
/**
 * Controle C0 (menos \t e \n), DEL, C1, hífen suave, largura zero, marcas de direção (bidi: "exe.txt" invertido),
 * separadores invisíveis e o bloco Tag (U+E0000..E007F), que serve para esconder instruções em ASCII dentro de
 * um texto aparentemente vazio.
 */
const INVISIBLE_OR_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

type Replacer = string | ((match: string, ...groups: string[]) => string);
interface Rule { readonly pattern: RegExp; readonly replace: Replacer }

const PREFIXED_TOKEN_BODIES = [
  String.raw`sk-[A-Za-z0-9_-]{8,}`, // OpenAI, Anthropic (sk-ant-…)
  String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{8,}`, // Stripe
  String.raw`whsec_[A-Za-z0-9]{8,}`, // webhook do Stripe
  String.raw`re_[A-Za-z0-9_]{10,}`, // Resend
  String.raw`gh[pousr]_[A-Za-z0-9]{20,}`, // GitHub
  String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`glpat-[A-Za-z0-9_-]{20,}`, // GitLab
  String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`, // Slack
  String.raw`AKIA[0-9A-Z]{16}`, // AWS
  String.raw`AIza[0-9A-Za-z_-]{35}`, // Google
  String.raw`npm_[A-Za-z0-9]{30,}`,
];

const QUOTED = String.raw`"[^"\n]*"|'[^'\n]*'`;
/** `Authorization: Bearer x` vira `Authorization: [oculto]` de uma vez, sem deixar o x para trás. */
const SENSITIVE_VALUE = String.raw`(?:${QUOTED}|(?:Bearer|Basic)\s+\S+|[^\s"',;}]+)`;
const SENSITIVE_NAME = String.raw`(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|pwd|credential|authorization)`;
/** Com ":" (prosa: "token: expirou") só vale valor entre aspas ou com cara de segredo; com "=" vale qualquer um. */
const LOOKS_LIKE_SECRET = /^[A-Za-z0-9_\-./+=]{12,}$/;

const RULES: readonly Rule[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: REDACTED },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_match, scheme) => `${scheme} ${REDACTED}` },
  // Todo cabeçalho JWT começa com `{"`, que em base64url é `eyJ`.
  { pattern: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, replace: REDACTED },
  { pattern: new RegExp(String.raw`\b(?:${PREFIXED_TOKEN_BODIES.join('|')})`, 'g'), replace: REDACTED },
  // Senha dentro de uma URL de conexão: esquema://usuario:SENHA@host
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, replace: (_match, head) => `${head}${REDACTED}@` },
  // Linhas de ambiente: KEY=valor, export KEY=valor, set KEY=valor, $env:KEY=valor. A chave fica, o valor some.
  { pattern: new RegExp(String.raw`\b((?:export\s+)?[A-Z][A-Z0-9_]{2,})\s*=\s*(?:${QUOTED}|[^\s"']+)`, 'g'), replace: (_match, key) => `${key}=${REDACTED}` },
  {
    pattern: new RegExp(String.raw`\b([A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(${SENSITIVE_VALUE})`, 'gi'),
    replace: (match, key, separator, value) => {
      const isStrong = separator.includes('=') || /^["']/.test(value) || LOOKS_LIKE_SECRET.test(value);
      return isStrong ? `${key}${separator}${REDACTED}` : match;
    },
  },
  { pattern: /(\/Users\/)[^/\s]+/g, replace: (_match, head) => `${head}${USER_MASK}` },
  { pattern: /(\/home\/)[^/\s]+/g, replace: (_match, head) => `${head}${USER_MASK}` },
  // No Windows o nome do usuário pode ter espaço ("Maria Silva"): vale até a próxima barra.
  { pattern: /\b([A-Za-z]:[\\/]Users[\\/])[^\\/:*?"<>|\r\n]{1,64}/gi, replace: (_match, head) => `${head}${USER_MASK}` },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, replace: EMAIL_MASK },
];

function stripInvisible(value: string): string {
  return value.normalize('NFKC')
    .replace(ANSI, '')
    .replace(UNICODE_LINE_BREAKS, '\n')
    .replace(INVISIBLE_OR_CONTROL, '');
}

/** Só as máscaras de segredo, caminho e e-mail (sem layout nem corte). Exportada para os testes. */
export function maskSecrets(value: string): string {
  return RULES.reduce((text, rule) => text.replace(rule.pattern, rule.replace as never), value);
}

/** Corta por pontos de código: nunca deixa um par substituto (emoji) pela metade. */
function capLength(value: string, maxLength: number): string {
  const characters = Array.from(value);
  return characters.length <= maxLength ? value : characters.slice(0, maxLength).join('');
}

/** Uma linha só (título, nome do modelo…): quebras viram espaço e os espaços repetidos colapsam. */
export function scrubLine(value: string, maxLength: number): string {
  const masked = maskSecrets(stripInvisible(value));
  return capLength(masked.replace(/\s+/g, ' ').trim(), maxLength);
}

/** Texto de várias linhas (descrição, passos): no máximo uma linha em branco seguida, fim das linhas aparado. */
export function scrubText(value: string, maxLength: number): string {
  const masked = maskSecrets(stripInvisible(value));
  const tidy = masked
    .replace(/\t/g, '  ')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return capLength(tidy, maxLength);
}

export interface DiagnosticEvent { readonly t: number; readonly kind: string; readonly code?: string }
export interface Diagnostics { readonly events: readonly DiagnosticEvent[]; readonly errors: readonly string[] }

export const DIAGNOSTIC_LIMITS = { kind: 40, code: 80, error: 200 } as const;

/** Devolve um diagnóstico novo: nada do objeto recebido é alterado. */
export function scrubDiagnostics(diagnostics: Diagnostics): Diagnostics {
  return {
    events: diagnostics.events.map(event => ({
      t: event.t,
      kind: scrubLine(event.kind, DIAGNOSTIC_LIMITS.kind),
      ...(event.code === undefined ? {} : { code: scrubLine(event.code, DIAGNOSTIC_LIMITS.code) }),
    })),
    errors: diagnostics.errors.map(error => scrubLine(error, DIAGNOSTIC_LIMITS.error)),
  };
}
