import os from 'node:os';
import { redactSecrets } from '../decision-models/decision-redaction';
import { BUG_REPORT_LIMITS, type BugReportPayload } from '../../shared/bug-report';

/**
 * Redator do reporte de problema. TUDO o que sai do processo passa por aqui —
 * o texto digitado pela pessoa e o diagnóstico montado pelo Main — porque quem
 * escreve "meu token é …" ou cola um caminho com o nome de usuário não está
 * pensando em privacidade. A redação é por padrão (`[REDACTED]`, `[email]`,
 * `~`), nunca por aviso: o que a prévia mostra já está limpo.
 *
 * Reaproveita `redactSecrets` (formatos de chave conhecidos e atribuições
 * `KEY=valor`) e acrescenta o que um relato de bug traz e um state de agente
 * não: e-mails, caminhos de HOME, credenciais em URL e tokens opacos longos.
 */

export interface RedactionContext {
  /** Diretório HOME desta máquina. Padrão: `os.homedir()`. */
  homeDir?: string;
}

const MASK = '[REDACTED]';
const EMAIL_MASK = '[email]';

/** Formatos de credencial que o `redactSecrets` compartilhado não cobre. */
const EXTRA_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
];

/** `Bearer` curto (o compartilhado exige 16+): o esquema fica, o valor some. */
const SHORT_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Cabeçalhos de credencial: o valor INTEIRO da linha some, seja qual for o
 * esquema (`Bearer`, `Negotiate`, `ApiKey`…) ou o formato do cookie.
 */
const CREDENTIAL_HEADER =
  /((?:proxy-)?authorization\s*[:=]\s*|(?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi;

/** Palavras que nomeiam credencial. `token` não casa `tokens`/`tokenizer`. */
const CREDENTIAL_WORD =
  '(?:api[_-]?key|access[_-]?key|secret|token(?![a-z])|password|passwd|pwd|credential)';

/** `"password": "x"` / `'secret': 'x'` — a aspas já diz que é valor, sem piso de tamanho. */
const QUOTED_ASSIGNMENT = new RegExp(
  `(["'])([\\w.-]{0,40}${CREDENTIAL_WORD}[\\w.-]{0,40})\\1(\\s*[:=]\\s*)(["'])(.*?)\\4`,
  'gi',
);

/** `password=valor`, `?access_token=valor`: `=` sem espaço não é prosa. */
const EQUALS_ASSIGNMENT = new RegExp(
  `([\\w.-]{0,40}${CREDENTIAL_WORD}[\\w.-]{0,40}=)[^\\s&"']+`,
  'gi',
);

/** `--password valor`, `--api-key valor` (o `--token=valor` já cai na regra do `=`). */
const CREDENTIAL_FLAG = new RegExp(
  `(--[\\w-]{0,40}${CREDENTIAL_WORD}[\\w-]{0,40}\\s+)(?!-)\\S+`,
  'gi',
);

/** `esquema://usuario:senha@host` — o host e o caminho ficam. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/**
 * Token opaco: 40+ caracteres do alfabeto de tokens com letra E dígito. Pega a
 * sessão do Nexus e chaves de formato desconhecido; hash git completo também
 * cai aqui (os curtos de 7–12 caracteres, que são os que as pessoas citam, não).
 * Tudo limitado a 200: sem isso a busca é quadrática em texto longo, e uma
 * sequência maior é mascarada em blocos consecutivos (não sobra cauda).
 */
const OPAQUE_TOKEN =
  /(?=[A-Za-z0-9_-]{0,200}\d)(?=[A-Za-z0-9_-]{0,200}[A-Za-z])[A-Za-z0-9_-]{40,200}/g;

/** Local part e rótulos de domínio limitados: sem isso o casamento é quadrático. */
const EMAIL =
  /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;

/**
 * `C:\Users\Nome Sobrenome\…` — nome de usuário do Windows pode ter espaço.
 * Até 3 palavras, e só quando há separador depois; sem separador cai na forma
 * de uma palavra, para não engolir a frase que vem em seguida. A letra do
 * drive não pode ser o fim de outra palavra (`file:///Users/…`).
 */
const WINDOWS_HOME_SPACED =
  /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+Users[\\/]+[^\\/:*?"<>|\r\n\s]+(?: [^\\/:*?"<>|\r\n\s]+){0,2}(?=[\\/])/gi;
const WINDOWS_HOME = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+Users[\\/]+[^\\/:*?"<>|\r\n\s]+/gi;
/** Git Bash/MSYS: `/c/Users/Nome`. */
const MSYS_HOME = /(?<![\w.~-])\/[A-Za-z]\/Users\/[^/\s"'\\]+/g;
/** WSL por UNC: `\\wsl$\Distro\home\nome`. */
const WSL_HOME = /\\\\wsl(?:\$|\.localhost)\\[^\\\s]+\\home\\[^\\\s"']+/gi;
const POSIX_HOME = /(?<![\w.~-])\/(?:Users|home)\/[^/\s"'\\]+/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function currentHomeDir(context: RedactionContext): string | null {
  if (context.homeDir !== undefined) return context.homeDir;
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

/** Troca o HOME literal desta máquina por `~` (cobre homes fora do padrão). */
function collapseLiteralHome(text: string, home: string | null): string {
  if (!home || home.replace(/[\\/]+/g, '').length < 3) return text;
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
  let out = text;
  for (const variant of variants) {
    const trimmed = variant.replace(/[\\/]+$/, '');
    if (!trimmed) continue;
    out = out.replace(
      new RegExp(`(?<![\\w.~-])${escapeRegExp(trimmed)}(?![A-Za-z0-9_-])`, 'g'),
      '~',
    );
  }
  return out;
}

export function redactBugReportText(text: string, context: RedactionContext = {}): string {
  let out = redactSecrets(text);
  for (const pattern of EXTRA_SECRET_PATTERNS) out = out.replace(pattern, MASK);
  out = out.replace(CREDENTIAL_HEADER, `$1${MASK}`);
  out = out.replace(SHORT_BEARER, `Bearer ${MASK}`);
  out = out.replace(QUOTED_ASSIGNMENT, `$1$2$1$3$4${MASK}$4`);
  out = out.replace(EQUALS_ASSIGNMENT, `$1${MASK}`);
  out = out.replace(CREDENTIAL_FLAG, `$1${MASK}`);
  out = out.replace(URL_CREDENTIALS, `$1${MASK}@`);
  out = out.replace(OPAQUE_TOKEN, MASK);
  out = out.replace(EMAIL, EMAIL_MASK);
  out = collapseLiteralHome(out, currentHomeDir(context));
  out = out.replace(WSL_HOME, '~');
  out = out.replace(WINDOWS_HOME_SPACED, '~').replace(WINDOWS_HOME, '~');
  out = out.replace(MSYS_HOME, '~');
  return out.replace(POSIX_HOME, '~');
}

/** Corta em `max` unidades UTF-16 sem deixar meio par substituto no fim. */
function capLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1);
  const splitsPair = end >= 0xd800 && end <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max);
}

/**
 * Redige e limita todo texto livre do corpo. Devolve um objeto NOVO: o corpo
 * de entrada não é tocado. Campos estruturais (enums, números, booleanos)
 * passam como estão; strings de `app`, `context` e `diagnostics` também são
 * redigidas — defesa em profundidade contra um valor inesperado do trace.
 */
export function redactBugReportPayload(
  payload: BugReportPayload,
  context: RedactionContext = {},
): BugReportPayload {
  const text = (value: string, max: number): string =>
    capLength(redactBugReportText(value, context), max);
  const steps = payload.steps === undefined ? '' : text(payload.steps, BUG_REPORT_LIMITS.stepsMax);
  const { app, context: fleet, diagnostics } = payload;
  return {
    title: text(payload.title, BUG_REPORT_LIMITS.titleMax),
    description: text(payload.description, BUG_REPORT_LIMITS.descriptionMax),
    ...(steps ? { steps } : {}),
    category: payload.category,
    impact: payload.impact,
    app: {
      version: text(app.version, 40),
      platform: app.platform,
      arch: text(app.arch, 20),
      ...(app.osVersion === undefined ? {} : { osVersion: text(app.osVersion, 64) }),
    },
    ...(fleet === undefined
      ? {}
      : {
          context: {
            ...(fleet.adapter === undefined ? {} : { adapter: text(fleet.adapter, 64) }),
            ...(fleet.model === undefined ? {} : { model: text(fleet.model, 80) }),
            paneCount: fleet.paneCount,
            missionActive: fleet.missionActive,
          },
        }),
    consent: { diagnostics: payload.consent.diagnostics },
    ...(diagnostics === undefined
      ? {}
      : {
          diagnostics: {
            events: diagnostics.events.map((event) => ({
              t: event.t,
              kind: text(event.kind, BUG_REPORT_LIMITS.kindMax),
              ...(event.code === undefined
                ? {}
                : { code: text(event.code, BUG_REPORT_LIMITS.codeMax) }),
            })),
            errors: diagnostics.errors.map((error) => text(error, BUG_REPORT_LIMITS.errorMax)),
          },
        }),
  };
}
