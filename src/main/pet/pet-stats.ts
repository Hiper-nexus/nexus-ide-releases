import { promises as asyncFs } from 'node:fs';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PetLifetimeStats, PetTier } from '../../shared/pet-types';
import {
  USAGE_HISTORY_MAX_DAYS,
  type UsageDailyBucket,
  type UsageHistory,
  type UsageSnapshot,
} from '../../shared/usage-types';
import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Contadores de vida útil do companion ("quanto torramos juntos").
 *
 * Cada escopo já acumula totais cumulativos no seu SQLite — o tracker guarda
 * o ÚLTIMO snapshot por escopo e soma. Sem deltas nem watermarks: rebroadcast
 * após restart repõe o valor integral, e um `peak` persistido impede o HUD de
 * regredir entre o boot e a primeira batida de telemetria (ou se um banco de
 * escopo for apagado).
 *
 * USD aqui é o equivalente de API pública — o que o consumo custaria fora da
 * assinatura — que é exatamente o que o usage-store calcula (preço/M tok).
 */

export const PET_STATS_FILENAME = 'pet-stats.json';
/** Teto de ids de pane persistidos (gamificação, não auditoria). */
const PANE_ID_CAP = 8192;

interface PetStatsFile {
  /** Piso monotônico: o maior total já observado por métrica. */
  peak: {
    tokensBurned: number;
    usdEquivalent: number;
    mediaUsd: number;
    turns: number;
    panesServed: number;
  };
  /** Union de paneIds vistos (prefixados por escopo) — sobrevive a restart. */
  paneIds: string[];
  missionsDone: number;
  /**
   * Piso monotônico por tipo de entrega (xp_events): se um checkout é
   * apagado, o total global não regride no HUD.
   */
  peakCounters: Record<string, number>;
  /** Rollup diário limitado (WEB-12); ausente em arquivos anteriores. */
  history?: HistoryFile;
  updatedAt: number;
}

interface HistoryTotals {
  tokens: number;
  usd: number;
  turns: number;
}

interface HistoryFile {
  /**
   * Marca d'água por escopo: o maior total cumulativo já atribuído a algum
   * dia. Só o que passa dela é consumo novo daquele escopo.
   */
  scopeMarks: Record<string, HistoryTotals>;
  days: UsageDailyBucket[];
  since: number;
}

/** Teto de escopos com marca persistida (os mais antigos saem primeiro). */
const HISTORY_SCOPE_CAP = 256;

interface ScopeTotals {
  tokens: number;
  usd: number;
  mediaUsd: number;
  turns: number;
  paneIds: Set<string>;
}

function emptyFile(): PetStatsFile {
  return {
    peak: {
      tokensBurned: 0,
      usdEquivalent: 0,
      mediaUsd: 0,
      turns: 0,
      panesServed: 0,
    },
    paneIds: [],
    missionsDone: 0,
    peakCounters: {},
    updatedAt: 0,
  };
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function petStatsPath(userDataDir: string): string {
  return path.join(userDataDir, PET_STATS_FILENAME);
}

export function loadPetStatsFile(userDataDir: string): PetStatsFile {
  try {
    const raw = readFileSync(petStatsPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PetStatsFile>;
    const base = emptyFile();
    const peak = parsed.peak ?? base.peak;
    const history = sanitizeHistory(parsed.history);
    return {
      peak: {
        tokensBurned: isFiniteNonNegative(peak.tokensBurned)
          ? peak.tokensBurned
          : 0,
        usdEquivalent: isFiniteNonNegative(peak.usdEquivalent)
          ? peak.usdEquivalent
          : 0,
        mediaUsd: isFiniteNonNegative(peak.mediaUsd) ? peak.mediaUsd : 0,
        turns: isFiniteNonNegative(peak.turns) ? peak.turns : 0,
        panesServed: isFiniteNonNegative(peak.panesServed)
          ? peak.panesServed
          : 0,
      },
      paneIds: Array.isArray(parsed.paneIds)
        ? parsed.paneIds
            .filter((id): id is string => typeof id === 'string')
            .slice(0, PANE_ID_CAP)
        : [],
      missionsDone: isFiniteNonNegative(parsed.missionsDone)
        ? parsed.missionsDone
        : 0,
      peakCounters: sanitizeCounters(parsed.peakCounters),
      ...(history ? { history } : {}),
      updatedAt: isFiniteNonNegative(parsed.updatedAt) ? parsed.updatedAt : 0,
    };
  } catch {
    return emptyFile();
  }
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** Dia LOCAL do operador (o gráfico fala no "hoje" do relógio dele). */
export function usageDayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function sanitizeHistory(raw: unknown): HistoryFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<HistoryFile>;
  if (!isFiniteNonNegative(value.since)) return null;
  const scopeMarks: Record<string, HistoryTotals> = {};
  const rawMarks =
    value.scopeMarks && typeof value.scopeMarks === 'object' ? value.scopeMarks : {};
  for (const [key, raw] of Object.entries(rawMarks).slice(-HISTORY_SCOPE_CAP)) {
    const mark = (raw ?? {}) as Partial<HistoryTotals>;
    scopeMarks[key] = {
      tokens: isFiniteNonNegative(mark.tokens) ? mark.tokens : 0,
      usd: isFiniteNonNegative(mark.usd) ? mark.usd : 0,
      turns: isFiniteNonNegative(mark.turns) ? mark.turns : 0,
    };
  }
  const byDay = new Map<string, UsageDailyBucket>();
  for (const entry of Array.isArray(value.days) ? value.days : []) {
    if (!entry || typeof entry !== 'object') continue;
    const bucket = entry as Partial<UsageDailyBucket>;
    if (typeof bucket.day !== 'string' || !DAY_KEY_RE.test(bucket.day)) continue;
    byDay.set(bucket.day, {
      day: bucket.day,
      tokens: isFiniteNonNegative(bucket.tokens) ? bucket.tokens : 0,
      usdEquivalent: isFiniteNonNegative(bucket.usdEquivalent) ? bucket.usdEquivalent : 0,
      turns: isFiniteNonNegative(bucket.turns) ? bucket.turns : 0,
    });
  }
  return {
    scopeMarks,
    days: boundDays([...byDay.values()]),
    since: value.since,
  };
}

/** Ordena por dia e guarda só os últimos 90 — o arquivo nunca cresce sem teto. */
function boundDays(days: readonly UsageDailyBucket[]): UsageDailyBucket[] {
  return [...days]
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-USAGE_HISTORY_MAX_DAYS);
}

function sanitizeCounters(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isFiniteNonNegative(value)) out[key] = value;
  }
  return out;
}

function savePetStatsFile(userDataDir: string, stats: PetStatsFile): void {
  const target = petStatsPath(userDataDir);
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stats)}\n`, 'utf8');
  renameSync(tmp, target);
}

/** XP do companion: entregas pesam mais que consumo — valor, não torra. */
export function petXp(stats: {
  tokensBurned: number;
  turns: number;
  missionsDone: number;
}): number {
  return (
    stats.missionsDone * 40 +
    stats.turns * 3 +
    Math.floor(stats.tokensBurned / 20_000)
  );
}

/** Nível = ⌊√(xp/25)⌋ + 1 → L2 aos 25 xp, L5 aos 400, L11 aos 2500. */
export function petLevelForXp(xp: number): {
  level: number;
  progress: number;
} {
  const safeXp = Math.max(0, xp);
  const level = Math.floor(Math.sqrt(safeXp / 25)) + 1;
  const atLevel = 25 * (level - 1) * (level - 1);
  const nextLevel = 25 * level * level;
  return {
    level,
    progress: Math.min(
      1,
      Math.max(0, (safeXp - atLevel) / Math.max(1, nextLevel - atLevel)),
    ),
  };
}

/** Mesma escala de tier da gamificação de projeto, por faixa de nível. */
export function petTierForLevel(level: number): PetTier {
  if (level >= 11) return 'LENDA';
  if (level >= 9) return 'MAESTRO';
  if (level >= 7) return 'ELITE';
  if (level >= 5) return 'VETERANO';
  if (level >= 3) return 'INICIADO';
  return 'RECRUTA';
}

export interface PetLifetimeTrackerOptions {
  /** Relógio injetável (testes); o dia do rollup sai dele. */
  readonly now?: () => number;
}

export class PetLifetimeTracker {
  readonly #userDataDir: string;
  readonly #now: () => number;
  #file: PetStatsFile;
  #history: HistoryFile;
  readonly #scopes = new Map<string, ScopeTotals>();
  /** Último mapa de entregas por escopo — mesmo padrão last-snapshot-per-scope. */
  readonly #xpScopes = new Map<string, Record<string, number>>();
  #dirty = false;

  constructor(userDataDir: string, options: PetLifetimeTrackerOptions = {}) {
    this.#userDataDir = userDataDir;
    this.#now = options.now ?? Date.now;
    this.#file = loadPetStatsFile(userDataDir);
    this.#history = this.#file.history ?? {
      scopeMarks: {},
      days: [],
      since: this.#now(),
    };
  }

  /** Chave estável do escopo — espelha scopeKey() da gamificação. */
  static scopeKey(scope: ProjectExecutionScope): string {
    return `${scope.installationId}\u0000${scope.projectId}\u0000${scope.checkoutId}\u0000${scope.rootRealPath}`;
  }

  /**
   * Recebe o snapshot cumulativo de um escopo (o mesmo que vai ao renderer).
   * Substitui o estado do escopo — os totais já são de vida inteira nele.
   */
  ingestSnapshot(scope: ProjectExecutionScope, snap: UsageSnapshot): void {
    const paneIds = new Set(
      Object.keys(snap.byPane).map(
        (paneId) => `${PetLifetimeTracker.scopeKey(scope)}::${paneId}`,
      ),
    );
    const key = PetLifetimeTracker.scopeKey(scope);
    const totals = {
      tokens: snap.global.inputTokens + snap.global.outputTokens,
      usd: snap.global.costUsd,
      turns: snap.global.turns,
    };
    this.#scopes.set(key, {
      ...totals,
      mediaUsd: snap.media.costUsd,
      paneIds,
    });
    this.#rollupDay(key, totals);
    this.#dirty = true;
  }

  /**
   * Atribui ao dia de hoje só o que o total cumulativo do escopo passou da
   * marca d'água dele. Depois de um restart o escopo volta com o mesmo total
   * e reencontra a marca: nada é contado duas vezes. Escopo visto pela
   * primeira vez vira linha de base (o histórico de transcripts importado
   * num boot não cai de uma vez no dia de hoje); escopo apagado não trava a
   * contagem dos outros.
   */
  #rollupDay(key: string, totals: HistoryTotals): void {
    const mark = this.#history.scopeMarks[key];
    // Banco do escopo recriado (total encolheu): nova linha de base, senão o
    // consumo dele só voltaria a contar depois de passar o total antigo.
    const shrank =
      mark !== undefined && (totals.tokens < mark.tokens || totals.turns < mark.turns);
    if (!mark || shrank) {
      const scopeMarks = { ...this.#history.scopeMarks, [key]: totals };
      const keys = Object.keys(scopeMarks);
      for (const stale of keys.slice(0, Math.max(0, keys.length - HISTORY_SCOPE_CAP))) {
        delete scopeMarks[stale];
      }
      this.#history = { ...this.#history, scopeMarks };
      return;
    }
    const delta = {
      tokens: Math.max(0, totals.tokens - mark.tokens),
      usd: Math.max(0, totals.usd - mark.usd),
      turns: Math.max(0, totals.turns - mark.turns),
    };
    if (delta.tokens === 0 && delta.usd === 0 && delta.turns === 0) return;
    const day = usageDayKey(this.#now());
    const today = this.#history.days.find((bucket) => bucket.day === day);
    this.#history = {
      scopeMarks: {
        ...this.#history.scopeMarks,
        [key]: {
          tokens: Math.max(totals.tokens, mark.tokens),
          usd: Math.max(totals.usd, mark.usd),
          turns: Math.max(totals.turns, mark.turns),
        },
      },
      days: boundDays([
        ...this.#history.days.filter((bucket) => bucket.day !== day),
        {
          day,
          tokens: (today?.tokens ?? 0) + delta.tokens,
          usdEquivalent: (today?.usdEquivalent ?? 0) + delta.usd,
          turns: (today?.turns ?? 0) + delta.turns,
        },
      ]),
      since: this.#history.since,
    };
  }

  /** Rollup diário para o gráfico de Uso e cotas (cópia, nunca o estado vivo). */
  history(): UsageHistory {
    return {
      days: this.#history.days.map((bucket) => ({ ...bucket })),
      since: this.#history.since,
      updatedAt: this.#now(),
    };
  }

  /**
   * Recebe os `counters` cumulativos do snapshot de gamificação de um escopo
   * (já são totais de vida do checkout — substitui o estado, não soma delta).
   */
  ingestGamificationCounters(
    scope: ProjectExecutionScope,
    counters: Record<string, number>,
  ): void {
    this.#xpScopes.set(
      PetLifetimeTracker.scopeKey(scope),
      sanitizeCounters(counters),
    );
    this.#dirty = true;
  }

  recordMissionDone(): void {
    this.#file = {
      ...this.#file,
      missionsDone: this.#file.missionsDone + 1,
      updatedAt: Date.now(),
    };
    this.#dirty = true;
  }

  /** Snapshot atual para o HUD — nunca abaixo do piso persistido. */
  stats(): PetLifetimeStats {
    let tokens = 0;
    let usd = 0;
    let mediaUsd = 0;
    let turns = 0;
    const livePaneIds = new Set<string>();
    for (const s of this.#scopes.values()) {
      tokens += s.tokens;
      usd += s.usd;
      mediaUsd += s.mediaUsd;
      turns += s.turns;
      for (const id of s.paneIds) livePaneIds.add(id);
    }
    for (const id of this.#file.paneIds) livePaneIds.add(id);

    const tokensBurned = Math.max(tokens, this.#file.peak.tokensBurned);
    const usdEquivalent = Math.max(usd, this.#file.peak.usdEquivalent);
    const media = Math.max(mediaUsd, this.#file.peak.mediaUsd);
    const totalTurns = Math.max(turns, this.#file.peak.turns);
    const panesServed = Math.max(
      livePaneIds.size,
      this.#file.peak.panesServed,
    );
    // Entregas globais: soma do último snapshot de cada escopo + piso
    // persistido por tipo (checkout apagado não derruba o total).
    const counters: Record<string, number> = {};
    for (const scopeCounters of this.#xpScopes.values()) {
      for (const [kind, value] of Object.entries(scopeCounters)) {
        counters[kind] = (counters[kind] ?? 0) + value;
      }
    }
    for (const [kind, peak] of Object.entries(this.#file.peakCounters)) {
      counters[kind] = Math.max(counters[kind] ?? 0, peak);
    }
    const { level, progress } = petLevelForXp(
      petXp({
        tokensBurned,
        turns: totalTurns,
        missionsDone: this.#file.missionsDone,
      }),
    );
    return {
      tokensBurned,
      usdEquivalent,
      mediaUsd: media,
      panesServed,
      turns: totalTurns,
      missionsDone: this.#file.missionsDone,
      counters,
      level,
      levelProgress: progress,
      tier: petTierForLevel(level),
      updatedAt: Date.now(),
    };
  }

  /** Persiste pico + panes + missões. Retorna false se nada mudou. */
  flush(): boolean {
    if (!this.#dirty) return false;
    this.#file = this.#snapshotForSave();
    savePetStatsFile(this.#userDataDir, this.#file);
    this.#dirty = false;
    return true;
  }

  #saveFlight: Promise<boolean> | null = null;

  /** Periodic persistence owns one physical write; mutations during IO remain dirty. */
  flushAsync(): Promise<boolean> {
    if (this.#saveFlight) return this.#saveFlight;
    if (!this.#dirty) return Promise.resolve(false);
    this.#file = this.#snapshotForSave();
    const bytes = `${JSON.stringify(this.#file)}\n`;
    this.#dirty = false;
    const target = petStatsPath(this.#userDataDir);
    const temporary = `${target}.tmp`;
    this.#saveFlight = (async () => {
      try {
        await asyncFs.mkdir(path.dirname(target), { recursive: true });
        await asyncFs.writeFile(temporary, bytes, 'utf8');
        await asyncFs.rename(temporary, target);
        return true;
      } catch (error) { this.#dirty = true; throw error; }
      finally { this.#saveFlight = null; }
    })();
    return this.#saveFlight;
  }

  #snapshotForSave(): PetStatsFile {
    const current = this.stats();
    return {
      peak: {
        tokensBurned: Math.max(current.tokensBurned, this.#file.peak.tokensBurned),
        usdEquivalent: Math.max(
          current.usdEquivalent,
          this.#file.peak.usdEquivalent,
        ),
        mediaUsd: Math.max(current.mediaUsd, this.#file.peak.mediaUsd),
        turns: Math.max(current.turns, this.#file.peak.turns),
        panesServed: Math.max(current.panesServed, this.#file.peak.panesServed),
      },
      paneIds: [...this.#currentPaneUnion()].slice(0, PANE_ID_CAP),
      missionsDone: this.#file.missionsDone,
      peakCounters: Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(current.counters),
            ...Object.keys(this.#file.peakCounters),
          ]),
        ].map((kind) => [
          kind,
          Math.max(
            current.counters[kind] ?? 0,
            this.#file.peakCounters[kind] ?? 0,
          ),
        ]),
      ),
      history: this.#history,
      updatedAt: Date.now(),
    };
  }

  #currentPaneUnion(): Set<string> {
    const out = new Set<string>(this.#file.paneIds);
    for (const s of this.#scopes.values()) {
      for (const id of s.paneIds) out.add(id);
    }
    return out;
  }
}
