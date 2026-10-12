/**
 * Redact secrets from shell command lines before history persistence.
 * Fail-closed: denylisted patterns replace the whole command.
 *
 * Puro (sem Node): vive em `shared/` para o pacote de continuidade do failover
 * redigir no próprio builder, no Main e no renderer (F-999).
 * `main/terminal/command-redaction.ts` reexporta este módulo.
 */

const REDACTED = '[REDACTED]';

const SECRET_VALUE_RE =
  /\b(Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9_]{16,}|AIza[0-9A-Za-z_-]{35}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|figd_[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AGE-SECRET-KEY-1[0-9A-Z]{20,})\b/gi;

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
const SECRET_FLAG_NAME =
  '(?:token|secret|password|pass|api[-_]?key|authorization|cookie|credential|bearer)';
const FLAG_SECRET_RE = new RegExp(
  `(--?${SECRET_FLAG_NAME}(?:=|\\s+))(\\S+)`,
  'gi',
);

/**
 * Exact credential flag with the value in the NEXT argv item (`--token VALOR`).
 * Same flag list as FLAG_SECRET_RE — single source, so a new credential flag
 * name covers both the inline (`--flag=value`) and the split form.
 */
export const CREDENTIAL_FLAG_RE = new RegExp(`^--?${SECRET_FLAG_NAME}$`, 'i');

const ENV_ASSIGN_RE =
  /\b((?=[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|CREDENTIAL|AUTH|BEARER))[A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g;

/**
 * F-1016: `STRIPE_KEY=<opaco>` / `SIGNING_KEY=<base64>` — o nome tem `KEY` como
 * segmento (`_KEY`, `KEY_`), fora da lista acima de propósito: `SORT_KEY=2` e
 * `CACHE_KEY=user-profile` são comuns. Aqui só sai o valor com cara de
 * segredo (`looksLikeSecretFragment`); o nome é conferido no callback.
 * Nome limitado (≤ 64): sem `=` não reescaneia a linha inteira; o valor vai
 * inteiro (cortar deixaria a cauda de um blob longo à mostra).
 */
const ENV_KEY_ASSIGN_RE = /\b([A-Z][A-Z0-9_]{0,63})=(["']?)([A-Za-z0-9_.\/+~=-]{16,})/g;
const KEY_NAME_SEGMENT_RE = /(?:^|_)KEY(?:_|$)/;

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

  const { text: command, hits: secretHits } = applySecretPatterns(input, () => REDACTED);

  return {
    command,
    redacted: secretHits > 0 || hasControlCharacters,
    denylisted: false,
    secretHits,
  };
}

/**
 * Os padrões de segredo em ordem. `replace` recebe só o trecho secreto (a
 * senha da URL, o valor do header/flag/variável): o redator troca por
 * `[REDACTED]`; o modo máscara (F-999) devolve o mesmo comprimento para
 * mapear as posições de volta ao texto.
 */
function applySecretPatterns(
  input: string,
  replace: (secret: string) => string,
): { readonly text: string; readonly hits: number } {
  let hits = 0;
  const whole = (match: string): string => {
    hits += 1;
    return replace(match);
  };
  let text = input.replace(SECRET_VALUE_RE, whole).replace(GLM_KEY_RE, whole);
  for (const pattern of [
    AWS_KEY_RE,
    JWT_RE,
    SLACK_TOKEN_RE,
    GOOGLE_REFRESH_RE,
  ]) {
    text = text.replace(pattern, whole);
  }
  // Mask only the password half of a connection string so the scheme/host stay
  // readable for diagnosis.
  text = text.replace(
    URL_CREDENTIAL_RE,
    (_m, scheme: string, user: string, password: string) => {
      hits += 1;
      return `${scheme}${user}:${replace(password)}@`;
    },
  );
  // Header values run after the value patterns so a "Authorization: Bearer <t>"
  // is fully redacted by SECRET_VALUE_RE first; this catches opaque header
  // secrets with no recognizable value prefix (e.g. x-api-key: <opaque>).
  text = text.replace(HEADER_SECRET_RE, (_m, prefix: string, value: string) => {
    hits += 1;
    return `${prefix}${replace(value)}`;
  });
  text = text.replace(FLAG_SECRET_RE, (_m, prefix: string, value: string) => {
    hits += 1;
    return `${prefix}${replace(value)}`;
  });
  text = text.replace(ENV_ASSIGN_RE, (_m, key: string, value: string) => {
    hits += 1;
    return `${key}=${replace(value)}`;
  });
  text = text.replace(ENV_KEY_ASSIGN_RE, (match: string, key: string, quote: string, value: string) => {
    if (!KEY_NAME_SEGMENT_RE.test(key) || !looksLikeSecretFragment(value, 16)) return match;
    hits += 1;
    return `${key}=${quote}${replace(value)}`;
  });
  return { text, hits };
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

/* ------------------------------------------------------------------------ *
 * F-999: texto de TERMINAL (cauda do PTY / do xterm) que sai num prompt.
 *
 * O redator acima é ancorado em prefixo (sk-, ghp_, Bearer, eyJ, NOME=) e
 * olha uma linha por vez; uma TUI Ink emite "\n" por linha visual, então a
 * chave que a quebra partiu vazava a continuação, e a cauda cortada no meio
 * de uma chave (sem o prefixo) vazava inteira.
 * ------------------------------------------------------------------------ */

/** Marca de posição secreta no modo máscara (a entrada não tem controle). */
const SECRET_MASK = '\u0000';
/** Caractere que um segredo partido pela quebra pode ter dos dois lados. */
const WRAP_TOKEN_CHAR = /[A-Za-z0-9_.\/+=~%:@-]/;
/** Corrida de token com charset de segredo (base62/64/url, hex, JWT). */
const FRAGMENT_RUN_RE = /[A-Za-z0-9_.\/+=~-]+/y;
/** Moldura à esquerda (recuo, borda de caixa, "⎿" da saída de ferramenta). */
const LINE_GUTTER_RE = /^[ \t│┃|⎿]*/;
const PEM_BEGIN_RE = /-----BEGIN (?:[A-Z0-9 ]*)?PRIVATE KEY-----/;
const PEM_END_RE = /-----END (?:[A-Z0-9 ]*)?PRIVATE KEY-----/;
/** 1ª linha de cauda cortada: só token longo conta (hash curto e palavra ficam). */
const HEAD_FRAGMENT_MIN = 20;
/** Continuação de segredo que chegou ao fim da linha de cima. */
const CONTINUATION_FRAGMENT_MIN = 8;

/**
 * Fragmento solto com cara de segredo: base62/64 sorteado (caixa alternando a
 * todo instante, ou dígitos no meio) ou hex/base36 longo. Caminho de arquivo,
 * data ISO, CONSTANTE, `NOME=valor` e identificador CamelCase não são.
 */
export function looksLikeSecretFragment(run: string, minLength = HEAD_FRAGMENT_MIN): boolean {
  if (run.length < minLength) return false;
  if (/^\.{0,2}\//.test(run) || /\/[^/]*\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(run)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(run)) return false;
  let upper = 0;
  let lower = 0;
  let digits = 0;
  let flips = 0;
  let lastUpper: boolean | null = null;
  for (const char of run) {
    const isUpper = char >= 'A' && char <= 'Z';
    const isLower = char >= 'a' && char <= 'z';
    if (char >= '0' && char <= '9') digits += 1;
    if (!isUpper && !isLower) continue;
    if (isUpper) upper += 1;
    else lower += 1;
    if (lastUpper !== null && lastUpper !== isUpper) flips += 1;
    lastUpper = isUpper;
  }
  const alnum = upper + lower + digits;
  if (alnum < minLength * 0.75) return false;
  const digitShare = digits / alnum;
  if (upper > 0 && lower > 0) {
    // CamelCase vira a caixa ~2× por palavra; "NOME_postgres", 1× no total;
    // base62 sorteado, perto de metade das vezes.
    return digitShare >= 0.2 || flips / (upper + lower - 1) >= 0.3;
  }
  // Uma caixa só (hex, base36): longo e com dígitos no meio — hash curto fica.
  return run.length >= HEAD_FRAGMENT_MIN && digits < alnum && digitShare >= 0.2;
}

/** Posições secretas de uma linha: o mesmo redator, trocando pelo mesmo comprimento. */
function secretMask(line: string): Uint8Array {
  const { text } = applySecretPatterns(line.replace(/[\x00-\x1f\x7f]/g, ' '), (secret) =>
    SECRET_MASK.repeat(secret.length),
  );
  const mask = new Uint8Array(line.length);
  for (let at = 0; at < text.length; at += 1) {
    if (text.charCodeAt(at) === 0) mask[at] = 1;
  }
  return mask;
}

/** Fim útil da linha: sem brancos nem borda de caixa à direita. */
function contentEnd(line: string): number {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  if (end > 0 && '│┃|'.includes(line[end - 1]!)) {
    end -= 1;
    while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  }
  return end;
}

/**
 * Mascara a corrida de token que começa em `from`, se tiver cara de segredo.
 * `NOME=` na frente é nome de variável (a linha seguinte de um `.env`): só o
 * valor é avaliado.
 */
function maskLeadingFragment(line: string, mask: Uint8Array, start: number, minLength: number): void {
  const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(line.slice(start, start + 128));
  const from = start + (name?.[0].length ?? 0);
  if (from >= line.length || mask[from]) return;
  FRAGMENT_RUN_RE.lastIndex = from;
  const run = FRAGMENT_RUN_RE.exec(line)?.[0] ?? '';
  let length = 0;
  while (length < run.length && !mask[from + length]) length += 1;
  if (looksLikeSecretFragment(run.slice(0, length), minLength)) mask.fill(1, from, from + length);
}

/**
 * A quebra de linha da TUI no meio de um segredo: (a) o segredo chegou ao fim
 * da linha de cima e a de baixo abre com fragmento com cara de segredo — é a
 * continuação, em cadeia; (b) o prefixo ficou curto demais na linha de cima
 * ("…sk-pr" / "ghp_" + 15) e só casa juntando as duas pontas, colado ou com
 * o espaço que a quebra por palavra comeu ("Bearer" ⏎ token).
 */
function maskAcrossBreak(
  above: string,
  aboveMask: Uint8Array,
  below: string,
  belowMask: Uint8Array,
): void {
  const end = contentEnd(above);
  const start = LINE_GUTTER_RE.exec(below)![0].length;
  if (end === 0 || start >= below.length) return;
  if (aboveMask[end - 1]) {
    maskLeadingFragment(below, belowMask, start, CONTINUATION_FRAGMENT_MIN);
    return;
  }
  if (!WRAP_TOKEN_CHAR.test(above[end - 1]!) || !WRAP_TOKEN_CHAR.test(below[start]!)) return;
  for (const glue of ['', ' ']) {
    const joined = `${above.slice(0, end)}${glue}${below.slice(start)}`;
    const mask = secretMask(joined);
    const resume = end + glue.length;
    if (!mask[end - 1] || !mask[resume]) continue;
    for (let at = 0; at < end; at += 1) if (mask[at]) aboveMask[at] = 1;
    for (let at = start; at < below.length; at += 1) {
      if (mask[resume + at - start]) belowMask[at] = 1;
    }
  }
}

function renderMasked(line: string, mask: Uint8Array): string {
  if (!mask.includes(1)) return line;
  let out = '';
  let at = 0;
  while (at < line.length) {
    const from = at;
    while (at < line.length && !mask[at]) at += 1;
    out += line.slice(from, at);
    if (at >= line.length) break;
    while (at < line.length && mask[at]) at += 1;
    out += REDACTED;
  }
  return out;
}

export interface TerminalRedactionOptions {
  /**
   * Cauda cortada: a 1ª linha pode começar no meio de um token. Token longo
   * com cara de segredo no começo sai (o prefixo que o identificaria ficou
   * antes do corte).
   */
  readonly partialHead?: boolean;
}

/**
 * Redige texto de terminal que vai para um prompt: blocos PEM (inclusive a
 * cauda que começa no meio da chave — END sem BEGIN), segredos por linha e
 * segredos partidos pela quebra de linha da TUI. Comprimento livre: cortar é
 * do chamador, sempre DEPOIS daqui (achatar antes juntaria a chave partida com
 * um espaço e o resto vazaria).
 */
export function redactTerminalText(raw: string, options: TerminalRedactionOptions = {}): string {
  let text = raw.replace(/\r\n?/g, '\n');
  const end = PEM_END_RE.exec(text);
  if (end) {
    const begin = PEM_BEGIN_RE.exec(text);
    if (!begin || begin.index > end.index) {
      text = `${REDACTED}${text.slice(end.index + end[0].length)}`;
    }
  }
  text = text.replace(ARMOURED_BLOCK_RE, REDACTED);
  if (DANGLING_BLOCK_RE.test(text)) text = text.replace(DANGLING_BLOCK_RE, REDACTED);

  const lines = text.split('\n');
  const masks = lines.map(secretMask);
  if (options.partialHead && lines.length > 0) {
    const first = lines[0]!;
    maskLeadingFragment(first, masks[0]!, /^[ \t]*/.exec(first)![0].length, HEAD_FRAGMENT_MIN);
  }
  for (let index = 1; index < lines.length; index += 1) {
    maskAcrossBreak(lines[index - 1]!, masks[index - 1]!, lines[index]!, masks[index]!);
  }
  return lines.map((line, index) => renderMasked(line, masks[index]!)).join('\n');
}
