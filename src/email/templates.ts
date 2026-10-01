import type { NoticeKind } from '../db/schema.js';

/** Modelos dos avisos por e-mail. Puro: nada de rede, relógio ou ambiente. */
export const DEFAULT_TRIAL_DAYS = 15;
export const DEFAULT_TRIAL_MAX_AGENTS = 2;

const ACCOUNT_URL = 'https://nexuside.app/conta/';
const PLAN_URL = 'https://nexuside.app/conta/?plano=pro';
const REASON = 'Você recebeu este aviso porque criou uma conta no NexusIDE.';

const INK = '#080709';
const PANEL = '#131016';
const PINK = '#ff4f8b';
const TEXT = '#f4f0f2';
const MUTED = '#a79fa6';
const RULE = '#2a2530';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export interface NoticeTemplateInput {
  readonly name: string | null;
  /** ISO 8601 do fim do teste; nulo ou inválido omite a data. */
  readonly trialEndsAt: string | null;
  readonly daysLeft: number;
  readonly unsubscribeUrl: string;
  /** Texto de preço opcional. O modelo nunca escreve um valor por conta própria. */
  readonly priceLabel?: string | null;
  readonly trialDays?: number;
  readonly maxAgents?: number;
}

export interface RenderedNotice {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface Copy {
  readonly subject: string;
  readonly preheader: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly cta: { readonly label: string; readonly url: string };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Valor dinâmico numa linha só: quebra de linha num assunto ou cabeçalho seria injeção de cabeçalho. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Só https, e a forma normalizada da URL (aspas e sinais de marcação saem codificados). */
function safeHttpsUrl(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('unsubscribeUrl deve ser uma URL https');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError('unsubscribeUrl deve ser uma URL https válida'); }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') throw new TypeError('unsubscribeUrl deve ser uma URL https sem credenciais');
  return parsed.href;
}

function firstName(name: string | null): string {
  if (name === null) return '';
  return oneLine(name).split(' ')[0] ?? '';
}

const DATE_FORMAT = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: 'numeric', month: 'long', year: 'numeric' });

function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? DATE_FORMAT.format(new Date(time)) : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function days(count: number): string {
  return count === 1 ? '1 dia' : `${count} dias`;
}

function priceSentence(label: string | null | undefined): readonly string[] {
  const clean = typeof label === 'string' ? oneLine(label) : '';
  return clean === '' ? [] : [`O plano Pro custa ${clean}.`];
}

function copyFor(kind: NoticeKind, input: NoticeTemplateInput): Copy {
  const trialDays = positiveInteger(input.trialDays, DEFAULT_TRIAL_DAYS);
  const maxAgents = positiveInteger(input.maxAgents, DEFAULT_TRIAL_MAX_AGENTS);
  const date = formatDate(input.trialEndsAt);
  const price = priceSentence(input.priceLabel);
  const noCharge = 'Nada é cobrado sem a sua confirmação.';

  switch (kind) {
    case 'welcome':
      return {
        subject: `Bem-vindo ao NexusIDE: seu teste de ${days(trialDays)} começou`,
        preheader: 'Sua conta está pronta e o teste já está valendo.',
        title: 'Bem-vindo ao NexusIDE',
        paragraphs: [
          date === null
            ? `Sua conta está criada e o teste de ${days(trialDays)} já está valendo.`
            : `Sua conta está criada e o teste de ${days(trialDays)} já está valendo, até ${date}.`,
          `Durante o teste você pode usar até ${maxAgents} agentes ao mesmo tempo. ${noCharge}`,
        ],
        cta: { label: 'Abrir minha conta', url: ACCOUNT_URL },
      };
    case 'trial_ending_3d': {
      const left = positiveInteger(input.daysLeft, 3);
      return {
        subject: `Seu teste do NexusIDE termina em ${days(left)}`,
        preheader: date === null ? 'Seu teste está chegando ao fim.' : `Seu teste termina em ${date}.`,
        title: `Seu teste termina em ${days(left)}`,
        paragraphs: [
          date === null ? 'Seu teste do NexusIDE está chegando ao fim. Até lá, tudo segue funcionando como hoje.' : `Seu teste do NexusIDE termina em ${date}. Até lá, tudo segue funcionando como hoje.`,
          `Para continuar depois, escolha o plano Pro na sua conta. ${[...price, noCharge].join(' ')}`,
        ],
        cta: { label: 'Ver o plano Pro', url: PLAN_URL },
      };
    }
    case 'trial_ending_1d':
      return {
        subject: 'Seu teste do NexusIDE termina em 24 horas',
        preheader: 'Falta menos de um dia para o fim do teste.',
        title: 'Seu teste termina em 24 horas',
        paragraphs: [
          date === null ? 'Seu teste do NexusIDE termina em menos de 24 horas.' : `Seu teste do NexusIDE termina em ${date}, em menos de 24 horas.`,
          `Para continuar depois, escolha o plano Pro na sua conta. ${[...price, noCharge].join(' ')}`,
        ],
        cta: { label: 'Ver o plano Pro', url: PLAN_URL },
      };
    case 'trial_ended':
      return {
        subject: 'Seu teste do NexusIDE terminou',
        preheader: 'Para voltar a usar o app, escolha o plano Pro.',
        title: 'Seu teste terminou',
        paragraphs: [
          // Sem "N dias": o administrador pode ter estendido o teste, e a duração configurada deixaria de ser a real.
          date === null ? 'O teste do NexusIDE terminou. Sua conta continua existindo.' : `O teste do NexusIDE terminou em ${date}. Sua conta continua existindo.`,
          `Para voltar a usar o app, escolha o plano Pro na sua conta. ${[...price, noCharge].join(' ')}`,
        ],
        cta: { label: 'Ver o plano Pro', url: PLAN_URL },
      };
  }
}

/** O "N" pixel da marca (grade 4×4 do favicon), desenhado com células de tabela: nada de imagem remota. */
const MARK_ROWS = ['#..#', '##.#', '#.##', '#..#'] as const;

function markHtml(): string {
  const rows = MARK_ROWS.map(row => {
    const cells = [...row].map(cell => `<td width="6" height="6" style="width:6px;height:6px;font-size:0;line-height:0;background-color:${cell === '#' ? PINK : INK};">&nbsp;</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table role="presentation" aria-hidden="true" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>`;
}

function renderHtml(copy: Copy, greeting: string, unsubscribeUrl: string): string {
  const paragraphs = copy.paragraphs.map(text => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${TEXT};">${escapeHtml(text)}</p>`).join('');
  const cta = `<a href="${escapeHtml(copy.cta.url)}" style="display:inline-block;background-color:${PINK};color:${INK};font-family:${FONT};font-size:16px;font-weight:700;line-height:1;text-decoration:none;padding:15px 24px;border-radius:6px;">${escapeHtml(copy.cta.label)}</a>`;
  const unsubscribe = escapeHtml(unsubscribeUrl);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${INK};font-size:1px;line-height:1px;">${escapeHtml(copy.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INK};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
<tr><td style="padding:0 0 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">${markHtml()}</td>
<td style="vertical-align:middle;font-family:${FONT};font-size:18px;font-weight:700;letter-spacing:0.2px;color:${TEXT};">NexusIDE</td>
</tr></table>
</td></tr>
<tr><td style="background-color:${PANEL};border:1px solid ${RULE};border-top:3px solid ${PINK};border-radius:8px;padding:32px 28px;font-family:${FONT};">
<h1 style="margin:0 0 20px;font-size:26px;line-height:1.25;font-weight:700;color:${TEXT};">${escapeHtml(copy.title)}</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${TEXT};">${escapeHtml(greeting)}</p>
${paragraphs}
<p style="margin:28px 0 0;">${cta}</p>
</td></tr>
<tr><td style="padding:24px 4px 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">
<p style="margin:0 0 8px;">${escapeHtml(REASON)}</p>
<p style="margin:0;">Não quer mais receber estes avisos? <a href="${unsubscribe}" style="color:${PINK};text-decoration:underline;">Cancelar o recebimento</a>.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** O texto simples não carrega sinais de marcação nem de valores dinâmicos: nenhum nome legítimo os tem. */
function renderText(copy: Copy, greeting: string, unsubscribeUrl: string): string {
  const body = [
    greeting,
    '',
    copy.title,
    '',
    ...copy.paragraphs.flatMap(paragraph => [paragraph, '']),
    `${copy.cta.label}: ${copy.cta.url}`,
    '',
    'Equipe NexusIDE',
    '',
    '--',
    REASON,
    `Para não receber mais estes avisos: ${unsubscribeUrl}`,
    '',
  ].join('\n');
  return body.replace(/[<>]/g, '');
}

export function renderNotice(kind: NoticeKind, input: NoticeTemplateInput): RenderedNotice {
  const unsubscribeUrl = safeHttpsUrl(input.unsubscribeUrl);
  const copy = copyFor(kind, input);
  const first = firstName(input.name);
  const greeting = first === '' ? 'Olá,' : `Olá, ${first},`;
  return {
    subject: copy.subject,
    html: renderHtml(copy, greeting, unsubscribeUrl),
    text: renderText(copy, greeting, unsubscribeUrl),
  };
}
