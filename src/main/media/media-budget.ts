import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  findMediaProvider,
  resolveMediaModel,
  resolveMediaProvider,
  type MediaProviderDef,
} from './media-providers';
import { musicCostUsd } from './music-generation';

/**
 * Media spend cap (F-1606, study §5.3 step 14): the operator sets a limit per
 * mission and per day in Ajustes → Serviços de mídia, and every paid media call
 * (image, video, speech, narration, music, alignment) checks it BEFORE calling
 * the provider.
 *
 * The cost of a media call is the list-price estimate the Nexus already shows
 * (`estimateCost`). It is RESERVED before the call, so two calls in parallel
 * cannot pass the cap together, then settled with the result's own estimate,
 * or released when the call fails. Reservations live in one ledger for the
 * whole app (`<userData>/media/media-spend.json`): a day cap counts every
 * project. With a cap set, a call whose cost is unknown is refused — no spend
 * goes past the cap. Without caps nothing changes.
 */

export interface MediaBudgetLimits {
  readonly perMissionUsd: number | null;
  readonly perDayUsd: number | null;
}

export const MEDIA_BUDGET_MAX_USD = 10_000;
const LEDGER_DAYS = 40;
const MAX_ENTRIES = 20_000;

const limitSchema = z.number().finite().min(0).max(MEDIA_BUDGET_MAX_USD).nullable();
export const mediaBudgetLimitsSchema = z
  .object({ perMissionUsd: limitSchema.default(null), perDayUsd: limitSchema.default(null) })
  .strict();

const entrySchema = z
  .object({
    id: z.string().min(1).max(64),
    at: z.number().int().nonnegative(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    usd: z.number().finite().nonnegative(),
    missionId: z.string().min(1).max(256).nullable(),
    tool: z.string().min(1).max(64),
    provider: z.string().min(1).max(64),
    settled: z.boolean(),
  })
  .strict();
type LedgerEntry = z.infer<typeof entrySchema>;

const fileSchema = z
  .object({
    schemaVersion: z.literal(1),
    limits: mediaBudgetLimitsSchema,
    entries: z.array(entrySchema).max(MAX_ENTRIES),
  })
  .strict();

export interface MediaSpendRequest {
  /** Estimated list price in USD; null = unknown. */
  readonly usd: number | null;
  readonly missionId?: string | null;
  readonly tool: string;
  readonly provider: string;
}

export interface MediaSpendRefusal {
  readonly ok: false;
  readonly error: string;
  readonly budget: {
    readonly limit: 'day' | 'mission' | 'unknown-cost';
    readonly limitUsd: number;
    readonly spentUsd: number;
    readonly requestUsd: number | null;
  };
}

export interface MediaSpendReservation {
  readonly ok: true;
  /** Settle with the real estimate of what was generated (defaults to the reservation). */
  settle(actualUsd?: number | null): void;
  /** The call failed or was cancelled: nothing was spent. */
  release(): void;
}

export interface MediaBudgetView {
  readonly limits: MediaBudgetLimits;
  readonly spentTodayUsd: number;
}

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function usd(value: number): string {
  return `US$ ${value.toFixed(2).replace('.', ',')}`;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export class MediaBudget {
  readonly #file: string;
  readonly #now: () => number;
  #limits: MediaBudgetLimits = { perMissionUsd: null, perDayUsd: null };
  #entries: LedgerEntry[] = [];

  constructor(dir: string, now: () => number = Date.now) {
    this.#file = path.join(dir, 'media-spend.json');
    this.#now = now;
    this.#load();
  }

  #load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.#file, 'utf8');
    } catch {
      return; // first run
    }
    const parsed = fileSchema.safeParse((() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })());
    if (!parsed.success) return; // unreadable ledger: start over rather than block every paid call
    this.#limits = parsed.data.limits;
    // A reservation left by a crash is kept: the provider may have charged it.
    this.#entries = parsed.data.entries;
  }

  #persist(): void {
    const cutoff = localDay(this.#now() - LEDGER_DAYS * 24 * 60 * 60 * 1000);
    this.#entries = this.#entries.filter((entry) => entry.day >= cutoff).slice(-MAX_ENTRIES);
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, limits: this.#limits, entries: this.#entries }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.#file);
  }

  limits(): MediaBudgetLimits {
    return { ...this.#limits };
  }

  setLimits(raw: unknown): MediaBudgetLimits {
    this.#limits = mediaBudgetLimitsSchema.parse(raw);
    this.#persist();
    return this.limits();
  }

  spentToday(): number {
    const today = localDay(this.#now());
    return round(this.#entries.filter((entry) => entry.day === today).reduce((sum, entry) => sum + entry.usd, 0));
  }

  spentForMission(missionId: string): number {
    return round(this.#entries.filter((entry) => entry.missionId === missionId).reduce((sum, entry) => sum + entry.usd, 0));
  }

  view(): MediaBudgetView {
    return { limits: this.limits(), spentTodayUsd: this.spentToday() };
  }

  reserve(request: MediaSpendRequest): MediaSpendReservation | MediaSpendRefusal {
    const { perDayUsd, perMissionUsd } = this.#limits;
    const missionId = request.missionId ?? null;
    const missionCap = missionId ? perMissionUsd : null;
    const anyCap = perDayUsd !== null || missionCap !== null;
    if (request.usd === null || !Number.isFinite(request.usd)) {
      if (anyCap) {
        return {
          ok: false,
          error:
            'O custo deste pedido é desconhecido e há um teto de gasto de mídia ligado, então ele não foi feito. ' +
            'Escolha um modelo com preço conhecido (nexus_media_providers) ou ajuste o teto em Ajustes → Serviços de mídia.',
          budget: { limit: 'unknown-cost', limitUsd: perDayUsd ?? missionCap ?? 0, spentUsd: this.spentToday(), requestUsd: null },
        };
      }
    }
    const cost = request.usd !== null && Number.isFinite(request.usd) ? Math.max(0, request.usd) : 0;
    if (perDayUsd !== null) {
      const spent = this.spentToday();
      if (spent + cost > perDayUsd + 1e-9) {
        return {
          ok: false,
          error:
            `Teto diário de mídia: hoje já foram ${usd(spent)} de ${usd(perDayUsd)}, e este pedido custa cerca de ${usd(cost)}. ` +
            'Nada foi cobrado. O operador pode subir o teto em Ajustes → Serviços de mídia, ou o pedido espera o dia seguinte.',
          budget: { limit: 'day', limitUsd: perDayUsd, spentUsd: spent, requestUsd: cost },
        };
      }
    }
    if (missionId && missionCap !== null) {
      const spent = this.spentForMission(missionId);
      if (spent + cost > missionCap + 1e-9) {
        return {
          ok: false,
          error:
            `Teto de mídia por missão: esta missão já gastou ${usd(spent)} de ${usd(missionCap)}, e este pedido custa cerca de ${usd(cost)}. ` +
            'Nada foi cobrado. Peça ao operador para subir o teto em Ajustes → Serviços de mídia.',
          budget: { limit: 'mission', limitUsd: missionCap, spentUsd: spent, requestUsd: cost },
        };
      }
    }
    if (cost === 0) return { ok: true, settle: () => undefined, release: () => undefined };
    const now = this.#now();
    const entry: LedgerEntry = {
      id: randomUUID(),
      at: now,
      day: localDay(now),
      usd: round(cost),
      missionId,
      tool: request.tool.slice(0, 64),
      provider: request.provider.slice(0, 64),
      settled: false,
    };
    this.#entries.push(entry);
    this.#persist();
    let done = false;
    return {
      ok: true,
      settle: (actualUsd) => {
        if (done) return;
        done = true;
        const current = this.#entries.find((item) => item.id === entry.id);
        if (!current) return;
        if (typeof actualUsd === 'number' && Number.isFinite(actualUsd) && actualUsd >= 0) current.usd = round(actualUsd);
        current.settled = true;
        this.#persist();
      },
      release: () => {
        if (done) return;
        done = true;
        this.#entries = this.#entries.filter((item) => item.id !== entry.id);
        this.#persist();
      },
    };
  }
}

let instance: MediaBudget | null = null;

/** Main boot: the app-wide ledger under `<userData>/media`. */
export function configureMediaBudget(budget: MediaBudget | null): void {
  instance = budget;
}

export function getMediaBudget(): MediaBudget | null {
  return instance;
}

/**
 * Runs a paid media call under the cap: reserve → call → settle with the
 * result's estimate, or release on failure. Without a configured ledger
 * (tests, early boot) the call runs as before.
 */
export async function withMediaSpend<T>(
  request: MediaSpendRequest,
  call: () => Promise<T>,
  actualOf: (result: T) => number | null | undefined = () => undefined,
  budget: MediaBudget | null = instance,
): Promise<T | MediaSpendRefusal> {
  if (!budget) return call();
  const reservation = budget.reserve(request);
  if (!reservation.ok) return reservation;
  try {
    const result = await call();
    const failed =
      typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
    if (failed) reservation.release();
    else reservation.settle(actualOf(result));
    return result;
  } catch (error) {
    reservation.release();
    throw error;
  }
}

/** Estimated list price of a paid media tool call, before calling (modal and cap). */
export function estimateMediaToolUsd(
  tool: string,
  args: Record<string, unknown>,
  hasKey: (def: MediaProviderDef) => boolean = () => true,
): { provider: string; usd: number | null } | null {
  const name = tool.replace(/^nexus_/u, '');
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  const kindOf: Record<string, 'image' | 'video' | 'audio'> = {
    image_generate: 'image',
    video_generate: 'video',
    audio_generate: 'audio',
  };
  if (name in kindOf) {
    if (name === 'video_generate' && text('recoverJobId')) return { provider: text('provider') ?? 'replicate-video', usd: 0 };
    try {
      const def = resolveMediaProvider(kindOf[name], text('provider'), hasKey, text('model'));
      const model = resolveMediaModel(def, text('model'));
      const seconds = typeof args.durationSeconds === 'number' ? args.durationSeconds : undefined;
      const chars = name === 'audio_generate' ? (text('text') ?? '').length : undefined;
      return { provider: def.id, usd: def.estimateCost({ model, seconds, resolution: text('resolution'), chars }) };
    } catch {
      return { provider: text('provider') ?? 'unknown', usd: null };
    }
  }
  if (name === 'music_generate') {
    if (args.dryRun === true) return { provider: 'elevenlabs', usd: 0 };
    const lengthMs = typeof args.lengthMs === 'number' && Number.isFinite(args.lengthMs) ? args.lengthMs : null;
    return { provider: 'elevenlabs', usd: lengthMs === null ? null : musicCostUsd(lengthMs) };
  }
  if (name === 'voiceover_generate') {
    if (args.dryRun === true) return { provider: 'elevenlabs', usd: 0 };
    const script = text('script');
    if (script === undefined) return { provider: text('provider') ?? 'elevenlabs', usd: null };
    const def = findMediaProvider('elevenlabs');
    try {
      const model = def ? resolveMediaModel(def, text('model')) : 'eleven_v4';
      return { provider: 'elevenlabs', usd: def ? def.estimateCost({ model, chars: script.length }) : null };
    } catch {
      return { provider: 'elevenlabs', usd: null };
    }
  }
  return null;
}

/** "estimated cost US$ 0,36" for the confirmation modal; unknown says so. */
export function costPhrase(estimate: { usd: number | null } | null): string {
  if (!estimate) return '';
  if (estimate.usd === null) return '; estimated cost: unknown (see dryRun or nexus_media_providers)';
  return `; estimated cost: ${usd(estimate.usd)} (list price, charged to the operator's key)`;
}

const NO_LEDGER: MediaSpendReservation = { ok: true, settle: () => undefined, release: () => undefined };

/** Reserve the estimate of one paid call on the app ledger; a no-op before the ledger exists. */
export function reserveMediaSpend(
  estimate: { provider: string; usd: number | null } | null,
  missionId: string | null | undefined,
  tool: string,
  budget: MediaBudget | null = instance,
): MediaSpendReservation | MediaSpendRefusal {
  if (!budget) return NO_LEDGER;
  return budget.reserve({ usd: estimate?.usd ?? null, missionId, tool, provider: estimate?.provider ?? 'unknown' });
}
