import type { NoticeKind } from '../db/schema.js';

/**
 * Modelos dos avisos por e-mail. Puro: nada de rede, relógio ou ambiente.
 *
 * A cara é de dev (janela de terminal, `$ nexus trial --status`, barra de progresso em blocos) e a voz é jovial,
 * com piada de programador. O que é regra não mexe: nada de preço escrito (só se quem chama passar), "nada é cobrado
 * sem a sua confirmação", descadastro em todo e-mail e HTML simples (estilo inline, sem imagem, sem script, sem fonte remota).
 */
export const DEFAULT_TRIAL_DAYS = 15;
export const DEFAULT_TRIAL_MAX_AGENTS = 6;

const ACCOUNT_URL = 'https://nexuside.app/conta/';
const PLAN_URL = 'https://nexuside.app/conta/?plano=pro';
const DOWNLOAD_URL = 'https://nexuside.app/#download';
const REASON = 'Você recebeu este aviso porque criou uma conta no NexusIDE.';

const INK = '#080709';
const PANEL = '#131016';
const TERMINAL = '#0d0b10';
const PINK = '#ff4f8b';
const TEXT = '#f4f0f2';
const MUTED = '#a79fa6';
const RULE = '#2a2530';
const GREEN = '#7ee787';
const AMBER = '#ffcf6e';
const CYAN = '#79c0ff';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'SF Mono','JetBrains Mono',ui-monospace,Menlo,Consolas,'Liberation Mono',monospace";

/** Largura da barra de progresso em blocos. */
const BAR_WIDTH = 15;

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

type Tone = 'ok' | 'warn' | 'info' | 'muted';

interface TerminalLine {
  readonly tone: Tone;
  readonly symbol: string;
  readonly text: string;
}

interface Copy {
  readonly subject: string;
  readonly preheader: string;
  readonly headline: string;
  readonly command: string;
  readonly lines: readonly TerminalLine[];
  readonly paragraphs: readonly string[];
  readonly ps: string;
  readonly cta: { readonly label: string; readonly url: string };
  readonly secondary?: { readonly label: string; readonly url: string };
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

function priceSentence(label: string | null | undefined): string {
  const clean = typeof label === 'string' ? oneLine(label) : '';
  return clean === '' ? '' : `O plano Pro custa ${clean}. `;
}

/** `[████░░░░] 4/7`: dias que já passaram do teste. */
function progressBar(elapsed: number, total: number): string {
  const done = Math.min(Math.max(elapsed, 0), total);
  const filled = Math.round((done / total) * BAR_WIDTH);
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}] ${done}/${total}`;
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
        subject: `Bem-vindo ao NexusIDE: ${days(trialDays)} de teste, zero merge conflict`,
        preheader: 'Sua conta está pronta e o build do seu teste passou de primeira.',
        headline: 'Bem-vindo ao NexusIDE. O build do seu teste passou de primeira.',
        command: '$ nexus init',
        lines: [
          { tone: 'ok', symbol: '✓', text: 'conta criada' },
          { tone: 'ok', symbol: '✓', text: date === null ? `teste de ${days(trialDays)} ativado` : `teste de ${days(trialDays)} ativado, até ${date}` },
          { tone: 'ok', symbol: '✓', text: `até ${maxAgents} agentes trabalhando ao mesmo tempo` },
          { tone: 'muted', symbol: ' ', text: progressBar(0, trialDays) },
          { tone: 'info', symbol: '→', text: 'próximo passo: instalar o app e entrar com esta conta' },
        ],
        paragraphs: [
          date === null
            ? `Sua conta está criada e o teste de ${days(trialDays)} já está valendo.`
            : `Sua conta está criada e o teste de ${days(trialDays)} já está valendo, até ${date}.`,
          `Durante o teste você pode usar até ${maxAgents} agentes ao mesmo tempo. No Pro, os agentes simultâneos são ilimitados. O consumo de IA segue os limites e preços dos seus provedores. ${noCharge}`,
        ],
        ps: 'P.S.: funciona na sua máquina. E na nossa também.',
        cta: { label: 'Abrir minha conta', url: ACCOUNT_URL },
        secondary: { label: 'Ainda não instalou? Baixe o NexusIDE', url: DOWNLOAD_URL },
      };
    case 'trial_ending_3d': {
      const left = positiveInteger(input.daysLeft, 3);
      return {
        subject: `Seu teste do NexusIDE termina em ${days(left)} (o relógio não tem hot reload)`,
        preheader: date === null ? 'O relógio não tem hot reload: o teste está chegando ao fim.' : `O relógio não tem hot reload. Seu teste termina em ${date}.`,
        headline: `Faltam ${days(left)}. O relógio não tem hot reload.`,
        command: '$ nexus trial --status',
        lines: [
          { tone: 'warn', symbol: '!', text: `restam: ${days(left)}` },
          ...(date === null ? [] : [{ tone: 'info', symbol: '→', text: `termina em: ${date}` } satisfies TerminalLine]),
          { tone: 'muted', symbol: ' ', text: progressBar(trialDays - left, trialDays) },
        ],
        paragraphs: [
          date === null
            ? 'Seu teste do NexusIDE está chegando ao fim. Até lá, tudo segue funcionando como hoje, sem feature flag escondida e sem surpresa no deploy.'
            : `Seu teste do NexusIDE termina em ${date}. Até lá, tudo segue funcionando como hoje, sem feature flag escondida e sem surpresa no deploy.`,
          `Curtiu? Escolha o plano Pro na sua conta, com agentes simultâneos ilimitados, e siga codando. Não curtiu? Não precisa fazer nada: o teste só termina. ${price}${noCharge}`,
        ],
        ps: 'P.S.: este e-mail saiu de um cron. Ele não tem opinião sobre o seu código, só sobre o calendário.',
        cta: { label: 'Ver o plano Pro', url: PLAN_URL },
      };
    }
    case 'trial_ending_1d':
      return {
        subject: 'Seu teste do NexusIDE termina em 24 horas: hora do último commit',
        preheader: 'Falta menos de um dia para o fim do teste. Hora do último commit.',
        headline: 'Faltam menos de 24 horas. Hora do último commit.',
        command: '$ nexus trial --status',
        lines: [
          { tone: 'warn', symbol: '!', text: 'restam: menos de 24 horas' },
          ...(date === null ? [] : [{ tone: 'info', symbol: '→', text: `termina em: ${date}` } satisfies TerminalLine]),
          { tone: 'muted', symbol: ' ', text: progressBar(trialDays - 1, trialDays) },
        ],
        paragraphs: [
          date === null
            ? 'Seu teste do NexusIDE termina em menos de 24 horas. Hora de decidir se esse teste vai pra produção.'
            : `Seu teste do NexusIDE termina em ${date}, em menos de 24 horas. Hora de decidir se esse teste vai pra produção.`,
          `Depois disso o app pede o plano Pro, com agentes simultâneos ilimitados, para continuar. Escolha na sua conta quando quiser. ${price}${noCharge}`,
        ],
        ps: 'P.S.: a gente sabe que dava pra ter decidido na segunda. Todo mundo deixa o merge pro fim da sprint.',
        cta: { label: 'Ver o plano Pro', url: PLAN_URL },
      };
    case 'trial_ended':
      return {
        subject: 'Seu teste do NexusIDE terminou (seu código continua aí, relaxa)',
        preheader: 'Exit code 0. Seus projetos seguem na sua máquina; para voltar ao app, escolha o plano Pro.',
        headline: 'Teste encerrado. Exit code 0, tudo certo.',
        command: '$ nexus trial --status',
        lines: [
          { tone: 'muted', symbol: '·', text: date === null ? 'status: encerrado' : `status: encerrado em ${date}` },
          { tone: 'ok', symbol: '✓', text: 'conta: ativa' },
          { tone: 'info', symbol: '→', text: 'para voltar ao app: plano Pro' },
        ],
        paragraphs: [
          // Sem "N dias": o administrador pode ter estendido o teste, e a duração configurada deixaria de ser a real.
          date === null
            ? 'O teste do NexusIDE terminou. Sua conta continua existindo, e seus projetos continuam na sua máquina, do jeitinho que você deixou.'
            : `O teste do NexusIDE terminou em ${date}. Sua conta continua existindo, e seus projetos continuam na sua máquina, do jeitinho que você deixou.`,
          `Para voltar a usar o app, escolha o plano Pro na sua conta, com agentes simultâneos ilimitados. ${price}${noCharge}`,
        ],
        ps: 'P.S.: nada de git stash aqui. A gente guarda a sua conta direitinho até você voltar.',
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

const TONE_COLOR: Record<Tone, string> = { ok: GREEN, warn: AMBER, info: CYAN, muted: MUTED };

/** As três bolinhas e o título da janela: só decoração, escondida de leitor de tela. */
function terminalBarHtml(): string {
  const dot = (color: string): string => `<td width="10" height="10" style="width:10px;height:10px;font-size:0;line-height:0;background-color:${color};border-radius:5px;">&nbsp;</td><td width="6" style="width:6px;font-size:0;">&nbsp;</td>`;
  return `<table role="presentation" aria-hidden="true" cellpadding="0" cellspacing="0" border="0"><tr>${dot('#ff5f57')}${dot('#febc2e')}${dot('#28c840')}<td style="padding-left:6px;font-family:${MONO};font-size:12px;line-height:1;color:${MUTED};">nexus — zsh</td></tr></table>`;
}

const BAR_EMPTY = '#5d5560';

/** A barra `[████░░░░] 4/7` com os dias que já passaram em rosa e o resto apagado; qualquer outra linha sai como texto. */
function lineContentHtml(entry: TerminalLine): string {
  const bar = /^\[(█*)(░*)\] (\d+\/\d+)$/.exec(entry.text);
  if (bar === null) return `${escapeHtml(entry.symbol)} ${escapeHtml(entry.text)}`;
  const [, used = '', left = '', count = ''] = bar;
  const span = (color: string, text: string): string => (text === '' ? '' : `<span style="color:${color};">${text}</span>`);
  return `${escapeHtml(entry.symbol)} ${span(MUTED, '[')}${span(PINK, used)}${span(BAR_EMPTY, left)}${span(MUTED, `] ${escapeHtml(count)}`)}`;
}

function terminalHtml(copy: Copy): string {
  const line = (color: string, content: string): string => `<div style="color:${color};white-space:pre-wrap;word-break:break-word;">${content}</div>`;
  const lines = copy.lines.map(entry => line(TONE_COLOR[entry.tone], lineContentHtml(entry))).join('');
  const command = copy.command.startsWith('$ ') ? `<span style="color:${PINK};">$</span> <span style="color:${TEXT};">${escapeHtml(copy.command.slice(2))}</span>` : escapeHtml(copy.command);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${TERMINAL};border:1px solid ${RULE};border-radius:10px;">
<tr><td style="padding:10px 14px;border-bottom:1px solid ${RULE};">${terminalBarHtml()}</td></tr>
<tr><td style="padding:16px 18px;font-family:${MONO};font-size:13px;line-height:1.8;color:${TEXT};">${line(TEXT, command)}${lines}</td></tr>
</table>`;
}

function renderHtml(copy: Copy, greeting: string, unsubscribeUrl: string): string {
  const paragraphs = copy.paragraphs.map(text => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${TEXT};">${escapeHtml(text)}</p>`).join('');
  const cta = `<a href="${escapeHtml(copy.cta.url)}" style="display:inline-block;background-color:${PINK};color:${INK};font-family:${FONT};font-size:16px;font-weight:700;line-height:1;text-decoration:none;padding:15px 24px;border-radius:8px;">${escapeHtml(copy.cta.label)}</a>`;
  const secondary = copy.secondary === undefined ? '' : `<p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:${MUTED};"><a href="${escapeHtml(copy.secondary.url)}" style="color:${CYAN};text-decoration:underline;">${escapeHtml(copy.secondary.label)}</a></p>`;
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
<td style="vertical-align:middle;font-family:${MONO};font-size:17px;font-weight:700;letter-spacing:0.2px;color:${TEXT};">NexusIDE<span style="color:${PINK};">_</span></td>
</tr></table>
</td></tr>
<tr><td style="background-color:${PANEL};border:1px solid ${RULE};border-top:3px solid ${PINK};border-radius:8px;padding:28px 24px;font-family:${FONT};">
${terminalHtml(copy)}
<h1 style="margin:26px 0 18px;font-size:25px;line-height:1.25;font-weight:700;color:${TEXT};">${escapeHtml(copy.headline)}</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${TEXT};">${escapeHtml(greeting)}</p>
${paragraphs}
<p style="margin:26px 0 0;">${cta}</p>
${secondary}
<p style="margin:26px 0 0;font-family:${MONO};font-size:13px;line-height:1.6;color:${MUTED};">${escapeHtml(copy.ps)}</p>
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
    copy.headline,
    '',
    copy.command,
    ...copy.lines.map(entry => `${entry.symbol} ${entry.text}`),
    '',
    ...copy.paragraphs.flatMap(paragraph => [paragraph, '']),
    `${copy.cta.label}: ${copy.cta.url}`,
    ...(copy.secondary === undefined ? [] : [`${copy.secondary.label}: ${copy.secondary.url}`]),
    '',
    copy.ps,
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
