/**
 * Ritmo de cota por CLI: quanto da assinatura sobra em relação ao tempo que
 * falta para o reset. Puro (sem electron).
 *
 * A cota de uma assinatura que expira no reset é custo ZERO se ficar sem uso e
 * custo real se faltar antes dele. O roteador só EXCLUÍA CLI sem conta
 * disponível; entre as com conta, Claude a 80% semanal e Grok a 37% com reset
 * em 1,7 dia pesavam igual. `ratio` = folga restante ÷ fração de tempo
 * restante: > 1 sobra cota que vai expirar, < 1 gasta mais rápido que o
 * tempo, 0 não há como atender agora.
 *
 * Desconhecido NUNCA vira folga nem zero: sem janela medida o adapter fica
 * AUSENTE do mapa e o roteador segue como antes. É desconhecida a leitura velha
 * (QUOTA_ENTRY_MAX_AGE_MS), a janela por modelo (limita só aquele modelo, não a
 * CLI) e a janela cheia cujo reset já passou (a janela já reabriu).
 */
import {
  fullWindowsReopenAt,
  headroomReadings,
  type HeadroomReading,
} from '../quota/account-headroom';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import { windowScope } from './window-scope';

export interface QuotaPace {
  /** folga ÷ fração de tempo restante da janela que limita (0 = sem folga). */
  readonly ratio: number;
  /** Rótulo da janela que limita. */
  readonly window: string;
  readonly resetsInMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Leitura mais velha que isto não fala pelo estado de agora: o snapshot da
 * frota é cache em memória e não expira sozinho.
 */
export const QUOTA_ENTRY_MAX_AGE_MS = 15 * 60 * 1000;

/** Duração nominal por cadência. `credits`/`local`/rótulo livre: sem ritmo. */
const WINDOW_DURATION_MS: Readonly<Record<string, number>> = {
  hours: 5 * HOUR_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

/**
 * `session` não declara cadência (Claude "Sessão" é 5 h, Codex "Sessão" e AGY
 * "Cota Google" não dizem): só o "Diário" que o provedor declarou vale 24 h.
 * ponytail: casa pelo rótulo que kimi/codex/devin-usage emitem; renomeado, o
 * ritmo some (cai em "sem cadência", o lado seguro). Upgrade: o produtor
 * declarar a duração em `QuotaWindow`.
 */
function windowDurationMs(reading: HeadroomReading): number | undefined {
  return reading.key === 'session' && reading.label === 'Diário'
    ? DAY_MS
    : WINDOW_DURATION_MS[reading.key];
}

/** Piso de tempo restante: evita ratio explodir a segundos do reset. */
const MIN_TIME_LEFT_FRAC = 0.02;

/**
 * A leitura que vale agora para a CLI inteira, ou null quando ela é velha ou
 * sem data (desconhecida). Janela por modelo ("Semanal (Fable)", mesmo critério
 * do cooldown confirmado, F-1484) cai fora: a 100% ela esgota aquele modelo, não
 * a CLI, e dividia a chave `weekly` com a geral, mais apertada que ela.
 */
function usableEntry(entry: ProviderQuotaEntry, now: number): ProviderQuotaEntry | null {
  if (!Number.isFinite(entry.updatedAt) || now - entry.updatedAt > QUOTA_ENTRY_MAX_AGE_MS) return null;
  return { ...entry, windows: entry.windows.filter((window) => windowScope(window.label) === undefined) };
}

function accountPace(entry: ProviderQuotaEntry, now: number): QuotaPace | null {
  const readings = headroomReadings(entry);
  // Mesma regra do quotaExhaustedAdapters: janela cheia com reset vencido já
  // reabriu, é leitura velha e não zera o ritmo.
  if (entry.onCooldown || fullWindowsReopenAt(entry, now, 1) !== undefined) {
    // Rótulo da janela cheia; nunca o da conta (pode ser e-mail).
    const full = [...readings.values()].find(
      (reading) => reading.available <= 1e-6 && (reading.resetsAt === null || reading.resetsAt > now),
    );
    return { ratio: 0, window: full?.label ?? 'cooldown' };
  }
  let binding: QuotaPace | null = null;
  for (const reading of readings.values()) {
    // Cheia que chegou aqui tem reset vencido (ver acima): desconhecida.
    if (reading.available <= 1e-6) continue;
    const duration = windowDurationMs(reading);
    const resetsInMs =
      reading.resetsAt === null ? undefined : Math.max(0, reading.resetsAt - now);
    const timeLeftFrac =
      duration === undefined || resetsInMs === undefined
        ? 1
        : Math.min(1, Math.max(MIN_TIME_LEFT_FRAC, resetsInMs / duration));
    const ratio = reading.available / timeLeftFrac;
    if (binding === null || ratio < binding.ratio) {
      binding = {
        ratio,
        window: reading.label,
        ...(resetsInMs !== undefined ? { resetsInMs } : {}),
      };
    }
  }
  return binding;
}

/**
 * Ritmo por adapter: MIN entre as janelas medidas de cada conta (a que
 * limita), MAX entre as contas (o spawn escolhe a de maior folga). Adapter
 * sem nenhuma janela medida não entra no mapa.
 */
export function quotaPaceByAdapter(
  entries: readonly ProviderQuotaEntry[],
  now: number,
): Map<string, QuotaPace> {
  const out = new Map<string, QuotaPace>();
  for (const entry of entries) {
    const usable = usableEntry(entry, now);
    const pace = usable && accountPace(usable, now);
    if (!pace) continue;
    const previous = out.get(entry.adapterId);
    if (!previous || pace.ratio > previous.ratio) out.set(entry.adapterId, pace);
  }
  return out;
}

/** Termo do multi-score: 0 se desconhecido; senão 6·log2(ratio) preso em ±10. */
export function quotaPaceScore(pace: QuotaPace | undefined): number {
  if (!pace) return 0;
  const score = 6 * Math.log2(Math.max(pace.ratio, 0.01));
  return Math.min(10, Math.max(-10, score));
}

/**
 * Adapters cujas contas TODAS têm janela medida cheia e ainda fechada (sem
 * cooldown: o store é a autoridade dele). Conta sem leitura é desconhecida e
 * mantém o adapter; janela cujo reset já passou não conta (snapshot velho).
 */
export function quotaExhaustedAdapters(
  entries: readonly ProviderQuotaEntry[],
  now: number,
): Set<string> {
  const total = new Map<string, number>();
  const full = new Map<string, number>();
  for (const entry of entries) {
    total.set(entry.adapterId, (total.get(entry.adapterId) ?? 0) + 1);
    const usable = usableEntry(entry, now);
    if (usable && fullWindowsReopenAt(usable, now, 1) !== undefined) {
      full.set(entry.adapterId, (full.get(entry.adapterId) ?? 0) + 1);
    }
  }
  return new Set([...full].filter(([id, n]) => n === total.get(id)).map(([id]) => id));
}
