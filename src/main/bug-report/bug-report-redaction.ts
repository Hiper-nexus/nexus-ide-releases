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

/** `Authorization: <esquema> <credencial>` em qualquer caixa. */
const AUTHORIZATION_HEADER =
  /(authorization\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"']+/gi;

/** `esquema://usuario:senha@host` — o host e o caminho ficam. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/**
 * Token opaco: 40+ caracteres do alfabeto de tokens com letra E dígito. Pega a
 * sessão do Nexus e chaves de formato desconhecido; hash git completo também
 * cai aqui (os curtos de 7–12 caracteres, que são os que as pessoas citam, não).
 */
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * `C:\Users\Nome Sobrenome\…` — nome de usuário do Windows pode ter espaço.
 * Até 3 palavras, e só quando há separador depois; sem separador cai na forma
 * de uma palavra, para não engolir a frase que vem em seguida.
 */
const WINDOWS_HOME_SPACED =
  /[A-Za-z]:[\\/]+Users[\\/]+[^\\/:*?"<>|\r\n\s]+(?: [^\\/:*?"<>|\r\n\s]+){0,2}(?=[\\/])/gi;
const WINDOWS_HOME = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/:*?"<>|\r\n\s]+/gi;
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
      new RegExp(`(?<![\\w.~-])${escapeRegExp(trimmed)}(?=$|[\\\\/\\s"'])`, 'g'),
      '~',
    );
  }
  return out;
}

export function redactBugReportText(text: string, context: RedactionContext = {}): string {
  let out = redactSecrets(text);
  for (const pattern of EXTRA_SECRET_PATTERNS) out = out.replace(pattern, MASK);
  out = out.replace(AUTHORIZATION_HEADER, `$1${MASK}`);
  out = out.replace(SHORT_BEARER, `Bearer ${MASK}`);
  out = out.replace(URL_CREDENTIALS, `$1${MASK}@`);
  out = out.replace(OPAQUE_TOKEN, MASK);
  out = out.replace(EMAIL, EMAIL_MASK);
  out = collapseLiteralHome(out, currentHomeDir(context));
  out = out.replace(WINDOWS_HOME_SPACED, '~').replace(WINDOWS_HOME, '~');
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
