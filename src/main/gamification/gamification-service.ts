import { randomUUID } from 'node:crypto';
import type { Db } from '../persistence/db';
import type {
  GamificationSnapshot,
  GamificationTier,
  XpEventInput,
  XpEventKind,
} from '../../shared/gamification-types';
import {
  GAMIFICATION_CHANNELS,
  GAMIFICATION_COPY,
} from '../../shared/gamification-types';
import { efficiencyBonus, PRESTIGE_THRESHOLD, RULE_VERSION, TIER_THRESHOLDS, tierForPower, nextTierAt } from './xp-rules';
import { computePoints, foldAggregate } from './xp-engine';
import { advanceStreak, SHIELDS_PER_MONTH, type StreakState } from './streak';
import { evaluateAchievements } from './achievements';
import {
  countTodaySameBucket,
  getMeta,
  initGamificationStore,
  insertXpEvent,
  listXpEvents,
  setMeta,
} from './gamification-store';
import { listHandoffs, onHandoffsChange } from '../orch/handoff-store';
import { listMissions, onMissionsChange } from '../orch/mission-store';
import { listTasks, onTasksChange } from '../orch/task-store';
import { listMissionPanes } from '../orch/mission-pane-store';
import { findAgent } from '../orch/squad-store';
import { usageTotalsByMission } from '../usage/usage-store';
import { mediaUsageTotalsByMission } from '../usage/media-usage-store';
import type { Handoff } from '../../shared/orch-types';

/**
 * Borda da gamificação — read-model sobre os stores REAIS (handoff/missão/
 * task/mídia): resolve evidência, effort e custo, delega pontos ao engine
 * puro (Partes 1–2) e mantém o estado derivado (streak, piso de tier,
 * conquistas, skins, prestígio) no gamification_meta. Broadcast coalescido
 * (padrão usage-service) + narração via 'voice:narrate' (jarvis-narrator).
 *
 * Electron/settings ficam atrás de lazy require nos defaults — o módulo em si
 * permanece puro e unit-testável com deps injetadas.
 */

export interface ServiceDeps {
  db: Db | null;
  broadcast(channel: string, payload?: unknown): void;
  now(): number;
  soberMode(): boolean;
}

/** Chave de idempotência ESTÁVEL por entidade (não por kind): a mesma missão
 *  re-varrida como verde depois de contada como simples NÃO pode pontuar de
 *  novo — o kind vive na coluna, a chave prende a entidade. */
const missionKey = (id: string) => `mission:${id}`;
const handoffKey = (id: string) => `handoff:${id}`;
const taskKey = (id: string) => `task_done:${id}`;

const DELIVERY_KINDS: ReadonlySet<XpEventKind> = new Set([
  'mission_green',
  'mission_done',
  'handoff_green',
  'handoff_success',
  'task_done',
]);

const EMPTY_STREAK: StreakState = {
  streakDays: 0,
  lastDeliveryDay: null,
  shieldsUsedMonth: null,
  shieldsUsed: 0,
};

let deps: ServiceDeps | null = null;
let unsubscribes: Array<() => void> = [];
let changedTimer: ReturnType<typeof setTimeout> | null = null;

function defaultDeps(): ServiceDeps {
  return {
    db: (() => {
      try {
        // Lazy require: persistence/db importa electron — manter fora do topo
        // preserva este módulo importável em unit tests (padrão do repo).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getDb } = require('../persistence/db') as typeof import('../persistence/db');
        return getDb();
      } catch {
        return null;
      }
    })(),
    broadcast: (channel, payload) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { BrowserWindow } = require('electron') as typeof import('electron');
        for (const win of BrowserWindow.getAllWindows()) {
          const wc = win.webContents;
          if (!wc.isDestroyed() && !wc.isCrashed()) wc.send(channel, payload);
        }
      } catch {
        // sem janelas/electron (teste) — silencioso
      }
    },
    now: () => Date.now(),
    soberMode: () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getOrchSettings } =
          require('../persistence/settings-store') as typeof import('../persistence/settings-store');
        return (getOrchSettings() as { soberMode?: boolean }).soberMode === true;
      } catch {
        return false;
      }
    },
  };
}

// ── Meta helpers ─────────────────────────────────────────────────────────────

function metaJson<T>(db: Db, key: string, fallback: T): T {
  const raw = getMeta(db, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function metaNumber(db: Db, key: string, fallback: number): number {
  const raw = getMeta(db, key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const TIER_ORDER: GamificationTier[] = TIER_THRESHOLDS.map((t) => t.tier);

function tierRank(tier: GamificationTier): number {
  const i = TIER_ORDER.indexOf(tier);
  return i < 0 ? 0 : i;
}

function maxTier(a: GamificationTier, b: GamificationTier): GamificationTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

function monthKeyOf(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function dayStartOf(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── Evidência / effort / custo ───────────────────────────────────────────────

/** Artifact {kind:'verification', command, exitCode:0} → "cmd (exit 0)". */
export function hasGreenEvidence(artifacts: unknown[]): string | null {
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') continue;
    const rec = artifact as Record<string, unknown>;
    if (
      rec.kind === 'verification' &&
      typeof rec.command === 'string' &&
      rec.exitCode === 0
    ) {
      return `${rec.command} (exit 0)`;
    }
  }
  return null;
}

const EFFORT_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

/** Maior effort entre os panes da missão (proxy do tier do router). */
function missionEffort(missionId: string): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const pane of listMissionPanes(missionId)) {
    const rank = pane.effort ? EFFORT_RANK[pane.effort] ?? 0 : 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = pane.effort ?? null;
    }
  }
  return best;
}

/** Effort do pane do agente que entregou (fallback: 1º pane worker). */
function handoffEffort(handoff: Handoff): string | null {
  if (!handoff.missionId) return null;
  const panes = listMissionPanes(handoff.missionId);
  if (handoff.fromAgent) {
    const own = panes.find((p) => p.agentName === handoff.fromAgent);
    if (own?.effort) return own.effort;
  }
  return panes.find((p) => p.role === 'worker')?.effort ?? null;
}

/** Custo real da missão (tokens + mídia); null quando não medido. */
function missionCost(db: Db, missionId: string): number | null {
  try {
    const total =
      usageTotalsByMission(db, missionId).costUsd +
      mediaUsageTotalsByMission(db, missionId).costUsd;
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

// ── Varredura (read-model) ───────────────────────────────────────────────────

interface ScanResult {
  insertedAny: boolean;
  deliveries: XpEventInput[];
}

function insertEvent(db: Db, input: XpEventInput, retro: boolean): boolean {
  const prior = retro
    ? 0
    : countTodaySameBucket(db, input.kind, input.effort, dayStartOf(depsOf().now()));
  const points = computePoints(input, prior);
  return insertXpEvent(db, input, points);
}

function bumpExtra(extra: Record<string, number>, key: string): void {
  extra[key] = (extra[key] ?? 0) + 1;
}

function scanStores(db: Db, retro: boolean): ScanResult {
  const result: ScanResult = { insertedAny: false, deliveries: [] };
  const extra = metaJson<Record<string, number>>(db, 'counters_extra', {});
  let extraDirty = false;

  for (const handoff of listHandoffs({ includeDelivered: true })) {
    if (handoff.status !== 'success') continue;
    // Verde histórico não existe: evidência só vale em eventos ao vivo.
    const evidence = retro ? null : hasGreenEvidence(handoff.artifacts);
    const input: XpEventInput = {
      kind: evidence ? 'handoff_green' : 'handoff_success',
      entityKey: handoffKey(handoff.id),
      missionId: handoff.missionId ?? null,
      agentCategory: handoff.fromAgent
        ? findAgent(handoff.fromAgent)?.agent.category ?? null
        : null,
      effort: handoffEffort(handoff),
      evidence,
      retro,
      createdAt: handoff.createdAt,
    };
    if (insertEvent(db, input, retro)) {
      result.insertedAny = true;
      result.deliveries.push(input);
    }
  }

  for (const mission of listMissions()) {
    if (mission.status !== 'done') continue;
    const greenHandoff = retro
      ? null
      : listHandoffs({ missionId: mission.id, includeDelivered: true }).find(
          (h) => h.status === 'success' && hasGreenEvidence(h.artifacts),
        );
    const effort = missionEffort(mission.id);
    const costUsd = missionCost(db, mission.id);
    const input: XpEventInput = {
      kind: greenHandoff ? 'mission_green' : 'mission_done',
      entityKey: missionKey(mission.id),
      missionId: mission.id,
      effort,
      costUsd,
      evidence: greenHandoff ? hasGreenEvidence(greenHandoff.artifacts) : null,
      retro,
      createdAt: mission.updatedAt,
    };
    if (insertEvent(db, input, retro)) {
      result.insertedAny = true;
      result.deliveries.push(input);
      if (efficiencyBonus(input.kind, effort, costUsd) > 0) {
        bumpExtra(extra, 'efficient_mission');
        extraDirty = true;
      }
      if (mission.squadId?.startsWith('agentic-')) {
        bumpExtra(extra, 'agentic_mission');
        extraDirty = true;
      }
    }
  }

  for (const task of listTasks()) {
    if (task.status !== 'done') continue;
    const input: XpEventInput = {
      kind: 'task_done',
      entityKey: taskKey(task.id),
      missionId: task.missionId ?? null,
      retro,
      createdAt: task.updatedAt,
    };
    if (insertEvent(db, input, retro)) {
      result.insertedAny = true;
      result.deliveries.push(input);
    }
  }

  if (extraDirty) setMeta(db, 'counters_extra', JSON.stringify(extra));
  return result;
}

// ── Estado derivado + celebração ─────────────────────────────────────────────

function rawPower(db: Db): number {
  return foldAggregate(listXpEvents(db), 0).powerLevel;
}

/** `before` DEVE ser capturado antes de inserir eventos — o diff de tier/ramo
 *  compara snapshots pré/pós-varredura. */
function finalize(
  db: Db,
  scan: ScanResult,
  retro: boolean,
  before: GamificationSnapshot,
): void {
  if (!scan.insertedAny) return;

  // Streak: só entregas ao vivo movem o ritmo (replay não é hábito).
  if (!retro) {
    let streak = metaJson<StreakState>(db, 'streak', EMPTY_STREAK);
    const deliveries = scan.deliveries
      .filter((d) => DELIVERY_KINDS.has(d.kind))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const delivery of deliveries) {
      streak = advanceStreak(streak, new Date(delivery.createdAt));
    }
    setMeta(db, 'streak', JSON.stringify(streak));
  }

  celebrateAndBroadcast(db, before, retro);
}

/** Recalcula piso/conquistas/skins, narra o que mudou e agenda o broadcast. */
function celebrateAndBroadcast(
  db: Db,
  before: GamificationSnapshot,
  retro: boolean,
): void {
  const d = depsOf();
  const after = computeAndPersistDerived(db);

  if (!retro && !d.soberMode()) {
    if (tierRank(after.tier) > tierRank(before.tier)) {
      d.broadcast('voice:narrate', { text: GAMIFICATION_COPY.levelUp(after.tier) });
    }
    for (const id of after.achievements) {
      if (before.achievements.includes(id)) continue;
      const copy = GAMIFICATION_COPY.achievements[id];
      if (copy) {
        d.broadcast('voice:narrate', {
          text: GAMIFICATION_COPY.achievementUnlocked(copy.title),
        });
      }
    }
    if (after.branch !== before.branch) {
      d.broadcast('voice:narrate', {
        text: GAMIFICATION_COPY.branchEvolved(GAMIFICATION_COPY.branches[after.branch]),
      });
    }
  }
  scheduleChangedBroadcast();
}

/** Aplica piso de tier e desbloqueios ao meta; retorna o snapshot novo. */
function computeAndPersistDerived(db: Db): GamificationSnapshot {
  const snap = buildSnapshot();

  const storedFloor = (getMeta(db, 'tierFloor') as GamificationTier | null) ?? 'RECRUTA';
  if (tierRank(snap.tier) > tierRank(storedFloor)) {
    setMeta(db, 'tierFloor', snap.tier);
  }

  const unlocked = metaJson<string[]>(db, 'achievements', []);
  const fresh = evaluateAchievements(
    {
      counters: snap.counters,
      streakDays: snap.streakDays,
      prestige: snap.prestige,
      branch: snap.branch,
    },
    new Set(unlocked),
  );
  if (fresh.length > 0) {
    setMeta(db, 'achievements', JSON.stringify([...unlocked, ...fresh.map((a) => a.id)]));
    const skins = metaJson<string[]>(db, 'skins', []);
    const newSkins = fresh
      .map((a) => a.skin)
      .filter((s): s is string => Boolean(s) && !skins.includes(s as string));
    if (newSkins.length > 0) {
      setMeta(db, 'skins', JSON.stringify([...skins, ...newSkins]));
    }
  }
  return buildSnapshot();
}

/** Broadcast coalescido (máx. 1/s) — padrão usage-service. */
function scheduleChangedBroadcast(): void {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    depsOf().broadcast(GAMIFICATION_CHANNELS.changed, buildSnapshot());
  }, 1000);
  changedTimer.unref?.();
}

function depsOf(): ServiceDeps {
  if (!deps) throw new Error('gamification-service não inicializado');
  return deps;
}

// ── API pública (IPC/borda) ──────────────────────────────────────────────────

export function buildSnapshot(): GamificationSnapshot {
  const db = deps?.db ?? null;
  const now = deps?.now() ?? Date.now();
  if (!db) {
    return {
      powerLevel: 0,
      tier: 'RECRUTA',
      tierFloor: 'RECRUTA',
      nextTierAt: nextTierAt(0),
      prestige: 0,
      prestigeReady: false,
      branch: 'base',
      streakDays: 0,
      shieldsLeft: SHIELDS_PER_MONTH,
      achievements: [],
      skins: [],
      selectedSkin: null,
      counters: {},
      ruleVersion: RULE_VERSION,
    };
  }
  const prestige = metaNumber(db, 'prestige', 0);
  const baseline = metaNumber(db, 'prestigeBaseline', 0);
  const agg = foldAggregate(listXpEvents(db), prestige);
  const counters = { ...agg.counters };
  const extra = metaJson<Record<string, number>>(db, 'counters_extra', {});
  for (const [key, value] of Object.entries(extra)) {
    counters[key] = (counters[key] ?? 0) + value;
  }
  const power = Math.max(0, agg.powerLevel - baseline);
  const floor = (getMeta(db, 'tierFloor') as GamificationTier | null) ?? 'RECRUTA';
  const tier = maxTier(tierForPower(power), floor);
  const streak = metaJson<StreakState>(db, 'streak', EMPTY_STREAK);
  const shieldsUsed =
    streak.shieldsUsedMonth === monthKeyOf(now) ? streak.shieldsUsed : 0;
  return {
    powerLevel: power,
    tier,
    tierFloor: floor,
    nextTierAt: nextTierAt(power),
    prestige,
    prestigeReady: tier === 'LENDA' && power >= PRESTIGE_THRESHOLD,
    branch: agg.branch,
    streakDays: streak.streakDays,
    shieldsLeft: Math.max(0, SHIELDS_PER_MONTH - shieldsUsed),
    achievements: metaJson<string[]>(db, 'achievements', []),
    skins: metaJson<string[]>(db, 'skins', []),
    selectedSkin: getMeta(db, 'selectedSkin') || null,
    counters,
    ruleVersion: RULE_VERSION,
  };
}

/** Replay do histórico existente (uma vez): a estreia nasce com o power do
 *  jogador. Peso simples, sem narração — spec §4 "Estreia". */
export function runRetroReplayOnce(): void {
  const db = deps?.db;
  if (!db) return;
  if (getMeta(db, 'replayDone')) return;
  const before = buildSnapshot();
  const scan = scanStores(db, true);
  finalize(db, scan, true, before);
  setMeta(db, 'replayDone', '1');
}

/** Mídia gerada (tap do media-usage-store): evento leve + counter por tipo. */
export function recordMediaGeneratedForGamification(
  kind: string,
  missionId: string | null,
): void {
  const db = deps?.db;
  if (!db) return;
  const extra = metaJson<Record<string, number>>(db, 'counters_extra', {});
  bumpExtra(extra, `media_${kind}`);
  setMeta(db, 'counters_extra', JSON.stringify(extra));
  const before = buildSnapshot();
  const input: XpEventInput = {
    kind: 'media_generated',
    entityKey: `media_generated:${randomUUID()}`,
    missionId,
    createdAt: depsOf().now(),
  };
  const scan: ScanResult = { insertedAny: false, deliveries: [] };
  if (insertEvent(db, input, false)) {
    scan.insertedAny = true;
  }
  finalize(db, scan, false, before);
}

/** Transcender: só em LENDA com o limiar cruzado. Reseta a jornada (baseline)
 *  e ganha estrela permanente; piso volta ao início da nova jornada. */
export function doPrestige(): GamificationSnapshot {
  const db = deps?.db;
  if (!db) return buildSnapshot();
  const snap = buildSnapshot();
  if (!snap.prestigeReady) return snap;
  const stars = snap.prestige + 1;
  setMeta(db, 'prestige', String(stars));
  setMeta(db, 'prestigeBaseline', String(rawPower(db)));
  setMeta(db, 'tierFloor', 'RECRUTA');
  const d = depsOf();
  if (!d.soberMode()) {
    d.broadcast('voice:narrate', { text: GAMIFICATION_COPY.prestigeUp(stars) });
  }
  scheduleChangedBroadcast();
  return buildSnapshot();
}

/** Skin ativa ('' persistido = padrão/null). Validação de posse fica no IPC. */
export function selectSkin(skin: string | null): GamificationSnapshot {
  const db = deps?.db;
  if (db) {
    setMeta(db, 'selectedSkin', skin ?? '');
    scheduleChangedBroadcast();
  }
  return buildSnapshot();
}

export function initGamificationService(over?: Partial<ServiceDeps>): void {
  shutdownGamificationService();
  const base = defaultDeps();
  deps = { ...base, ...over };
  const db = deps.db;
  if (!db) return;
  try {
    initGamificationStore(db);
  } catch (err) {
    console.warn('[gamification] schema falhou — serviço desativado:', err);
    deps = { ...deps, db: null };
    return;
  }
  runRetroReplayOnce();
  const scanLive = () => {
    try {
      const before = buildSnapshot();
      finalize(db, scanStores(db, false), false, before);
    } catch (err) {
      console.warn('[gamification] varredura falhou:', err);
    }
  };
  // Varredura de partida: cobre entregas perdidas entre o último scan e o boot.
  scanLive();
  unsubscribes = [
    onHandoffsChange(scanLive),
    onMissionsChange(scanLive),
    onTasksChange(scanLive),
  ];
}

export function shutdownGamificationService(): void {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
  if (changedTimer) {
    clearTimeout(changedTimer);
    changedTimer = null;
  }
  deps = null;
}
