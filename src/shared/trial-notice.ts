/**
 * Aviso de fim do teste, para o app mostrar antes do bloqueio. Puro: o relógio e o fuso entram por
 * parâmetro. Só existe enquanto o acesso é `trial` e faltam até `TRIAL_WARNING_DAYS` dias; depois do
 * fim, quem fala é a tela de acesso (AccessBoundary), não este aviso.
 */
export const TRIAL_WARNING_DAYS = 3;

export interface TrialNoticeInput {
  readonly access?: string | null;
  readonly trialEndsAt?: string | null;
}

export interface TrialNotice {
  /** Dias inteiros que faltam, arredondados para cima (1 = menos de 24 h). */
  readonly daysLeft: number;
  /** Texto curto, para o cartão compacto. */
  readonly label: string;
  /** Frase completa, para o título e a leitura de tela. */
  readonly detail: string;
}

const DAY_MS = 86_400_000;

function civilDay(ms: number, timeZone?: string): number {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  return Date.parse(`${day}T00:00:00Z`);
}

export function trialNotice(
  license: TrialNoticeInput | null | undefined,
  now: number = Date.now(),
  options: { timeZone?: string } = {},
): TrialNotice | null {
  if (license?.access !== 'trial') return null;
  const end = Date.parse(license.trialEndsAt ?? '');
  if (!Number.isFinite(end)) return null;
  const left = end - now;
  if (left <= 0 || left > TRIAL_WARNING_DAYS * DAY_MS) return null;
  const { timeZone } = options;
  const hour = new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(end);
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(end);
  const calendarDays = Math.round((civilDay(end, timeZone) - civilDay(now, timeZone)) / DAY_MS);
  const daysLeft = Math.ceil(left / DAY_MS);
  if (calendarDays <= 0) return { daysLeft, label: 'Termina hoje', detail: `Seu teste termina hoje às ${hour}.` };
  if (calendarDays === 1) return { daysLeft, label: 'Termina amanhã', detail: `Seu teste termina amanhã às ${hour}.` };
  return { daysLeft, label: `Faltam ${calendarDays} dias`, detail: `Seu teste termina em ${calendarDays} dias, em ${date}.` };
}
