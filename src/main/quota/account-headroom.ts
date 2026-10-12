/**
 * F-995: folga entre contas da MESMA CLI, comparada só entre janelas
 * comparáveis. Puro.
 *
 * Em 07/10 a escolha pôs lado a lado a janela Semanal de uma conta (19% usado,
 * 5 Horas sem leitura) e a de 5 Horas da outra (0% usado, Semanal sem
 * leitura): o escore escalar (1 − pior janela conhecida) tratava a janela sem
 * leitura como folga e o recibo chamou de "menos folga" a conta que estava
 * livre. A de 5 Horas era justamente a que esgotou horas depois.
 *
 * Regras:
 *  1. Conta esgotada (cooldown, ou alguma janela medida em 100%) perde para
 *     qualquer conta que não esteja.
 *  2. Janelas medidas nas DUAS contas (mesma `kind`) decidem pela mais
 *     apertada delas — a janela que limita de fato.
 *  3. Janela que só uma das contas mediu: quem não leu NÃO tem mais folga nela.
 *     A primeira janela nessa condição, da mais curta para a mais longa (a
 *     de 5 Horas morde antes da Semanal), dá a vantagem a quem a mediu.
 *  4. Empate = 0 (quem chama desempata, ex.: pela idade da conta).
 */
import type {
  ProviderQuotaEntry,
  QuotaWindow,
  QuotaWindowKind,
} from '../../shared/quota-types';

/** Janelas de cota, da que limita primeiro à que limita por último. */
const WINDOW_ORDER: readonly QuotaWindowKind[] = [
  'session',
  'hours',
  'weekly',
  'monthly',
  'credits',
];

const EPSILON = 1e-6;

export interface HeadroomInput {
  readonly windows: ReadonlyArray<
    Pick<QuotaWindow, 'label' | 'usedRatio'> & {
      readonly kind?: QuotaWindowKind;
      readonly resetsAt?: number;
      readonly confidence?: QuotaWindow['confidence'];
    }
  >;
  readonly onCooldown?: boolean;
}

export interface HeadroomReading {
  /** Chave comparável: a cadência (`hours`, `weekly`…) ou o rótulo. */
  readonly key: string;
  readonly label: string;
  /** Fração usada (0..1) da janela. */
  readonly usedRatio: number;
  /** Folga = 1 − usedRatio, presa em 0..1. */
  readonly available: number;
  readonly resetsAt: number | null;
}

const EMPTY: HeadroomInput = Object.freeze({ windows: [] });

/** Cadência conhecida compara por `kind`; o resto só com o mesmo rótulo. */
function windowKey(window: HeadroomInput['windows'][number]): string {
  return window.kind && WINDOW_ORDER.includes(window.kind)
    ? window.kind
    : `label:${window.label}`;
}

/** Ordem de comparação: cadências da mais curta à mais longa, depois o resto. */
function orderedKeys(...maps: ReadonlyArray<ReadonlyMap<string, unknown>>): string[] {
  const keys = new Set<string>();
  for (const map of maps) for (const key of map.keys()) keys.add(key);
  const rank = (key: string) => {
    const index = WINDOW_ORDER.indexOf(key as QuotaWindowKind);
    return index >= 0 ? index : WINDOW_ORDER.length;
  };
  return [...keys].sort((left, right) => rank(left) - rank(right));
}

/** Leitura por janela comparável (a mais apertada quando aparece 2×). */
export function headroomReadings(
  input: HeadroomInput | undefined,
): Map<string, HeadroomReading> {
  const out = new Map<string, HeadroomReading>();
  for (const window of (input ?? EMPTY).windows) {
    if (window.usedRatio === null || !Number.isFinite(window.usedRatio)) continue;
    // F-1417: número que não foi medido desta credencial (ex.: Token Plan
    // lido da sessão `bl` da máquina) não é folga medida desta conta.
    if (window.confidence === 'low') continue;
    const usedRatio = Math.min(1, Math.max(0, window.usedRatio));
    const key = windowKey(window);
    const reading: HeadroomReading = {
      key,
      label: window.label,
      usedRatio,
      available: 1 - usedRatio,
      resetsAt:
        typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)
          ? window.resetsAt
          : null,
    };
    const previous = out.get(key);
    if (!previous || reading.available < previous.available) {
      out.set(key, reading);
    }
  }
  return out;
}

/** Cooldown ou alguma janela medida cheia. */
export function isHeadroomExhausted(input: HeadroomInput | undefined): boolean {
  if (input?.onCooldown) return true;
  for (const reading of headroomReadings(input).values()) {
    if (reading.available <= EPSILON) return true;
  }
  return false;
}

/**
 * A janela que limita a conta: a medida mais apertada (empate → a mais
 * curta). `null` quando nenhuma janela foi lida.
 */
export function bindingHeadroomWindow(
  input: HeadroomInput | undefined,
): HeadroomReading | null {
  let binding: HeadroomReading | null = null;
  const readings = headroomReadings(input);
  for (const key of orderedKeys(readings)) {
    const reading = readings.get(key)!;
    if (!binding || reading.available < binding.available - EPSILON) {
      binding = reading;
    }
  }
  return binding;
}

/**
 * Janela que `a` não leu e `b` mediu com folga — `a` não pode alegar folga
 * nela. `null` quando não há (a cobre todas as janelas que `b` mediu).
 */
export function unreadWindowWithProvenHeadroom(
  a: HeadroomInput | undefined,
  b: HeadroomInput | undefined,
): HeadroomReading | null {
  const readA = headroomReadings(a);
  const readB = headroomReadings(b);
  for (const key of orderedKeys(readB)) {
    const proven = readB.get(key)!;
    if (proven.available > EPSILON && !readA.has(key)) return proven;
  }
  return null;
}

/** > 0: `a` tem mais folga; < 0: `b`; 0: empate. */
export function compareAccountHeadroom(
  a: HeadroomInput | undefined,
  b: HeadroomInput | undefined,
): number {
  const exhaustedA = isHeadroomExhausted(a);
  const exhaustedB = isHeadroomExhausted(b);
  if (exhaustedA !== exhaustedB) return exhaustedA ? -1 : 1;
  if (exhaustedA) return 0;

  const readA = headroomReadings(a);
  const readB = headroomReadings(b);
  const keys = orderedKeys(readA, readB);
  let bindA = Infinity;
  let bindB = Infinity;
  for (const key of keys) {
    const left = readA.get(key);
    const right = readB.get(key);
    if (!left || !right) continue;
    bindA = Math.min(bindA, left.available);
    bindB = Math.min(bindB, right.available);
  }
  if (Number.isFinite(bindA) && Math.abs(bindA - bindB) > EPSILON) {
    return bindA > bindB ? 1 : -1;
  }

  for (const key of keys) {
    const left = readA.has(key);
    const right = readB.has(key);
    if (left !== right) return left ? 1 : -1;
  }
  return 0;
}

/**
 * Janelas medidas de cada conta do adapter no snapshot da frota. `undefined`
 * quando nenhuma conta do adapter tem linha (quem chama segue o caminho sem
 * medição: a ativa fica).
 */
export function headroomInputsByAccount(
  entries: readonly ProviderQuotaEntry[],
  adapterId: string,
): Map<string, HeadroomInput> | undefined {
  const out = new Map<string, HeadroomInput>();
  for (const entry of entries) {
    if (entry.adapterId !== adapterId || !entry.accountId) continue;
    // Mesmo critério do escore antigo (quotaAvailabilityScore): conta em
    // cooldown não tem folga, seja qual for o motivo.
    out.set(entry.accountId, { windows: entry.windows, onCooldown: entry.onCooldown });
  }
  return out.size > 0 ? out : undefined;
}
