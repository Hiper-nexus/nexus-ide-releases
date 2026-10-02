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
const ANSI = /\u001B\[[0-?]*[ -\/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g;
/** NEL, LS e PS são quebras de linha em Unicode; viram \n antes de qualquer outra coisa. */
const UNICODE_LINE_BREAKS = /\r\n|\r|\u0085|\u2028|\u2029/g;
/**
 * Controle C0 (menos \t e \n) e C1, o Braille em branco, e tudo o que o Unicode marca como formatação ou "ignorável
 * por padrão": hífen suave, largura zero, marcas de direção (bidi: "exe.txt" invertido), seletores de variação,
 * preenchimentos (U+115F, U+3164, U+FFA0…) e o bloco Tag (U+E0000..E007F). Esses invisíveis servem para esconder
 * instruções dentro de um texto aparentemente vazio (e para partir um segredo sem que ele pareça partido).
 */
const INVISIBLE_OR_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2800]|[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/** NFKC pode multiplicar o tamanho (U+33C2 vira "a.m."): o texto é cortado logo depois dele, antes de qualquer regex. */
const NORMALIZED_HEADROOM = 2;

type Replacer = string | ((match: string, ...groups: string[]) => string);
interface Rule { readonly pattern: RegExp; readonly replace: Replacer }

const PREFIXED_TOKEN_BODIES = [
  String.raw`sk-[A-Za-z0-9._-]{8,}`, // OpenAI, Anthropic (sk-ant-…), OpenRouter
  String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{8,}`, // Stripe
  String.raw`whsec_[A-Za-z0-9]{8,}`, // webhook do Stripe
  String.raw`re_[A-Za-z0-9_]{10,}`, // Resend
  String.raw`gh[pousr]_[A-Za-z0-9]{20,}`, // GitHub
  String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`glpat-[A-Za-z0-9_-]{20,}`, // GitLab
  String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`, // Slack
  String.raw`xapp-[A-Za-z0-9-]{10,}`,
  String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`, // AWS
  String.raw`AIza[0-9A-Za-z_-]{35}`, // Google
  String.raw`ya29\.[A-Za-z0-9_-]{16,}`, // OAuth do Google
  String.raw`npm_[A-Za-z0-9]{30,}`,
  String.raw`gsk_[A-Za-z0-9]{20,}`, // Groq
  String.raw`xai-[A-Za-z0-9]{20,}`, // xAI
  String.raw`hf_[A-Za-z0-9]{20,}`, // Hugging Face
  String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`, // SendGrid
  String.raw`key-[0-9a-f]{32}`, // Mailgun
  String.raw`SK[0-9a-f]{32}`, // Twilio
];

const QUOTED = String.raw`"[^"\n]*"|'[^'\n]*'`;
/** `Authorization: Bearer x` vira `Authorization: [oculto]` de uma vez, sem deixar o x para trás. */
const SENSITIVE_VALUE = String.raw`(?:${QUOTED}|(?:Bearer|Basic)\s+\S+|[^\s"',;}]+)`;
/** Com ":" qualquer valor some se o nome é inequívoco (senha, segredo, chave de API). */
const STRONG_NAME = String.raw`(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|passw(?:or)?d|passphrase|pwd|senha)`;
/** Nomes que também aparecem em prosa ("token: expirou"): com ":" só vale valor entre aspas ou com cara de segredo. */
const WEAK_NAME = String.raw`(?:token|bearer|pass(?![a-z])|pw|credential|authorization|auth(?![a-z])|session|refresh|cookie|csrf|verifier|jwt|signature)`;
const STRONG_HEAD = /^(?:api|access|private|secret|passw|pwd|senha)/i;
const LOOKS_LIKE_SECRET = /^[A-Za-z0-9_\-./+=]{12,}$/;
/** Sufixo do nome da chave (`_id`, `Key`, `-prod`): limitado, para a regex não ficar quadrática. */
const NAME_TAIL = String.raw`[A-Za-z0-9_.-]{0,32}`;

const PEM_KIND = String.raw`[A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?`;
const OPAQUE_TOKEN_MIN = 40;

/** Um token opaco (sessão, refresh…) mistura maiúscula, minúscula e dígito; hash em hexa e UUID, não. */
function looksLikeOpaqueToken(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

const RULES: readonly Rule[] = [
  { pattern: new RegExp(String.raw`-{3,5}BEGIN ${PEM_KIND}-{3,5}[\s\S]*?(?:-{3,5}END ${PEM_KIND}-{3,5}|$)`, 'gi'), replace: REDACTED },
  // O resto da linha de um cabeçalho de autorização ou de cookie é credencial, qualquer que seja o esquema.
  { pattern: /(\bauthorization["']?[ \t]{0,8}[=:][ \t]{0,8})[^\n]{1,300}/gi, replace: (_match, head) => `${head}${REDACTED}` },
  { pattern: /(\b(?:set-)?cookie["']?[ \t]{0,8}[=:][ \t]{0,8})[^\n]{1,500}/gi, replace: (_match, head) => `${head}${REDACTED}` },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_match, scheme) => `${scheme} ${REDACTED}` },
  // Todo cabeçalho JWT começa com `{"`, que em base64url é `eyJ`.
  { pattern: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, replace: REDACTED },
  { pattern: new RegExp(String.raw`\b(?:${PREFIXED_TOKEN_BODIES.join('|')})`, 'g'), replace: REDACTED },
  // Código de licença do NexusIDE (NEXUS-XXXX-XXXX-XXXX), com ou sem traços e em qualquer caixa: dá acesso a quem o usar.
  { pattern: /\bNEXUS[- ]?[0-9A-Z]{4}[- ]?[0-9A-Z]{4}[- ]?[0-9A-Z]{4}\b/gi, replace: REDACTED },
  // Senha dentro de uma URL de conexão (esquema://usuario:SENHA@host, redis://:SENHA@host) e token no lugar do usuário.
  { pattern: /(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/]{0,100}:)[^\s@/]{1,200}@/gi, replace: (_match, head) => `${head}${REDACTED}@` },
  { pattern: /(\bhttps?:\/\/)[^\s:@/]{8,100}@/gi, replace: (_match, head) => `${head}${REDACTED}@` },
  // Parâmetros de URL que carregam credencial: ?code=, &key=, X-Amz-Signature=…
  {
    pattern: /([?&][A-Za-z0-9_.-]{0,40}(?:code|state|key|token|signature|sig|secret|passw(?:or)?d|auth|credential|session)[A-Za-z0-9_.-]{0,20}=)[^\s&#"']{1,500}/gi,
    replace: (_match, head) => `${head}${REDACTED}`,
  },
  // Linhas de ambiente: KEY=valor, export KEY=valor, set KEY=valor, $env:KEY=valor. A chave fica, o valor some.
  { pattern: new RegExp(String.raw`\b((?:export\s+)?[A-Z][A-Z0-9_]{2,})\s*=\s*(?:${QUOTED}|[^\s"']+)`, 'g'), replace: (_match, key) => `${key}=${REDACTED}` },
  {
    // Sem prefixo antes do nome sensível e com o sufixo limitado: dois quantificadores gananciosos que se sobrepõem
    // (`[\w.-]*nome[\w.-]*`) davam tempo quadrático em "pwd.pwd.pwd." e afins.
    pattern: new RegExp(String.raw`((?:${STRONG_NAME}|${WEAK_NAME})${NAME_TAIL}["']?\s{0,8}[=:]\s{0,8})(${SENSITIVE_VALUE})`, 'gi'),
    replace: (match, head, value) => {
      const isSure = head.includes('=') || STRONG_HEAD.test(head) || /^["']/.test(value) || LOOKS_LIKE_SECRET.test(value);
      return isSure ? `${head}${REDACTED}` : match;
    },
  },
  // Flags de linha de comando: --token X, --password=X, --api-key X (o valor não pode ser a flag seguinte).
  {
    pattern: /(--[A-Za-z0-9-]{0,30}?(?:token|password|passwd|pwd|secret|api-?key|passphrase)[A-Za-z0-9-]{0,20}(?:=|[ \t]+))(?!-)(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi,
    replace: (_match, head) => `${head}${REDACTED}`,
  },
  { pattern: /(\s(?:-u|--user)[ \t=]+)[^\s:]{1,100}:\S+/g, replace: (_match, head) => `${head}${REDACTED}` },
  // Em prosa: "o token é Zq9Xk2…", "my token is …". Só vale um valor com cara de segredo (letra e dígito, 12 ou mais).
  {
    pattern: /(\b(?:token|senha|password|passphrase|secret|chave|key)[ \t]+(?:is|é|eh|are|=)[ \t]+)([A-Za-z0-9_\-./+=]{12,})/gi,
    replace: (match, head, value) => (/[A-Za-z]/.test(value) && /[0-9]/.test(value) ? `${head}${REDACTED}` : match),
  },
  { pattern: /(\/Users\/)[^/\s]+/g, replace: (_match, head) => `${head}${USER_MASK}` },
  { pattern: /(\/home\/)[^/\s]+/g, replace: (_match, head) => `${head}${USER_MASK}` },
  // No Windows o nome do usuário pode ter espaço ("Maria Silva"): vale até a próxima barra. Com ou sem a unidade (UNC).
  { pattern: /\b([A-Za-z]:[\\/]Users[\\/])[^\\/:*?"<>|\r\n]{1,64}/gi, replace: (_match, head) => `${head}${USER_MASK}` },
  { pattern: /(\\Users\\)[^\\/:*?"<>|\r\n]{1,64}/gi, replace: (_match, head) => `${head}${USER_MASK}` },
  // E-mail com letras de qualquer alfabeto; o último rótulo só com letras, para "react@18.2.0" não virar e-mail.
  { pattern: /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,7}\.\p{L}{2,24}/gu, replace: EMAIL_MASK },
  // Documentos brasileiros já formatados (os sem pontuação são indistinguíveis de qualquer número).
  { pattern: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, replace: '[cnpj]' },
  { pattern: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, replace: '[cpf]' },
  // Último recurso: um token opaco longo (sessão, refresh) que ficou sem nome ao lado.
  { pattern: new RegExp(String.raw`(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{${OPAQUE_TOKEN_MIN},}(?![A-Za-z0-9_-])`, 'g'), replace: match => (looksLikeOpaqueToken(match) ? REDACTED : match) },
];

function stripInvisible(value: string, maxLength: number): string {
  return value.normalize('NFKC')
    .slice(0, maxLength * NORMALIZED_HEADROOM)
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(ANSI, '')
    .replace(UNICODE_LINE_BREAKS, '\n')
    .replace(INVISIBLE_OR_CONTROL, '');
}

/** Só as máscaras de segredo, caminho e e-mail (sem layout nem corte). */
function maskSecrets(value: string): string {
  return RULES.reduce((text, rule) => text.replace(rule.pattern, rule.replace as never), value);
}

/** Corta por pontos de código: nunca deixa um par substituto (emoji) pela metade. */
function capLength(value: string, maxLength: number): string {
  const characters = Array.from(value);
  return characters.length <= maxLength ? value : characters.slice(0, maxLength).join('');
}

/** Uma linha só (título, nome do modelo…): quebras viram espaço e os espaços repetidos colapsam. */
export function scrubLine(value: string, maxLength: number): string {
  const masked = maskSecrets(stripInvisible(value, maxLength));
  return capLength(masked.replace(/\s+/g, ' ').trim(), maxLength);
}

/** Texto de várias linhas (descrição, passos): no máximo uma linha em branco seguida, fim das linhas aparado. */
export function scrubText(value: string, maxLength: number): string {
  const masked = maskSecrets(stripInvisible(value, maxLength));
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
