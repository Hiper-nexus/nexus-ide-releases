import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type {
  GamificationSnapshot,
  StoredXpEvent,
  XpEventInput,
} from '../../shared/gamification-types';
import {
  GAMIFICATION_CHANNELS,
  GAMIFICATION_COPY,
} from '../../shared/gamification-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type {
  ProjectDomainStoreName,
  ProjectDomainStoreRegistry,
  ProjectDomainStoreSuite,
} from '../orch/project-domain-store-registry';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { evaluateAchievements } from './achievements';
import { computePoints, foldAggregate } from './xp-engine';
import {
  countTodaySameBucket,
  dumpMeta,
  getMeta,
  initGamificationStore,
  insertXpEvent,
  listXpEvents,
  replaceProfile,
  setMeta,
} from './gamification-store';
import {
  acceptedHandoffIds,
  bumpExtra,
  countersSchema,
  dayStartOf,
  DELIVERY_KINDS,
  EMPTY_STREAK,
  groupRecentEvents,
  handoffEffort,
  maxTier,
  metaJson,
  metaNumber,
  missionCost,
  missionEffort,
  monthKeyOf,
  sameScope,
  scopeKey,
  streakSchema,
  stringListSchema,
  tierRank,
  tierSchema,
} from './gamification-service-support';
import { advanceStreak, SHIELDS_PER_MONTH } from './streak';
import {
  efficiencyBonus,
  nextTierAt,
  PRESTIGE_THRESHOLD,
  RULE_VERSION,
  tierForPower,
} from './xp-rules';

export { hasGreenEvidence } from './gamification-service-support';

export interface ScopedGamificationSnapshot extends GamificationSnapshot {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly rootRealPath: string;
}

export type ScopedGamificationBroadcast = (
  scope: ProjectExecutionScope,
  channel: string,
  payload?: unknown,
) => void;

export interface ProjectGamificationServiceOptions {
  runtimeManager: ProjectRuntimeManager;
  domainStores: ProjectDomainStoreRegistry;
  broadcast: ScopedGamificationBroadcast;
  now?: () => number;
  soberMode?: (scope: ProjectExecutionScope) => boolean;
  agentCategory?: (agentName: string) => string | null;
}

interface ScopeState {
  readonly scope: ProjectExecutionScope;
  activated: boolean;
  schemaVerified: boolean;
  changedTimer: ReturnType<typeof setTimeout> | null;
  /** Throttle de rescan no read-model (snapshot IPC). */
  lastRescanAt: number;
}

/** Evita rescan+write a cada hydrate em rajada (workspace switch + open profile). */
const SNAPSHOT_RESCAN_MIN_MS = 3_000;

interface ScanResult {
  insertedAny: boolean;
  deliveries: XpEventInput[];
}

interface FinalizedChange {
  before: ScopedGamificationSnapshot;
  after: ScopedGamificationSnapshot;
  retro: boolean;
}

const missionKey = (id: string) => `mission:${id}`;
const handoffKey = (id: string) => `handoff:${id}`;
const taskKey = (id: string) => `task_done:${id}`;

const OBSERVED_STORES: ReadonlySet<ProjectDomainStoreName> = new Set([
  'missions',
  'handoffs',
  'tasks',
]);

export class ProjectGamificationService {
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #domainStores: ProjectDomainStoreRegistry;
  readonly #broadcast: ScopedGamificationBroadcast;
  readonly #now: () => number;
  readonly #soberMode: (scope: ProjectExecutionScope) => boolean;
  readonly #agentCategory: (agentName: string) => string | null;
  readonly #states = new Map<string, ScopeState>();
  readonly #unsubscribes: Array<() => void> = [];
  #started = false;
  #disposed = false;

  constructor(options: ProjectGamificationServiceOptions) {
    this.#runtimeManager = options.runtimeManager;
    this.#domainStores = options.domainStores;
    this.#broadcast = options.broadcast;
    this.#now = options.now ?? Date.now;
    this.#soberMode = options.soberMode ?? (() => false);
    this.#agentCategory = options.agentCategory ?? (() => null);
  }

  start(): void {
    if (this.#disposed) throw new Error('gamification service is disposed');
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribes.push(
      this.#domainStores.onScope((scope) => {
        try {
          this.#activateScope(scope);
        } catch (error) {
          console.warn('[gamification] scope activation failed:', error);
        }
      }),
      this.#domainStores.onChange((scope, store) => {
        if (!OBSERVED_STORES.has(store)) return;
        try {
          const wasActive = this.#state(scope).activated;
          this.#activateScope(scope);
          if (wasActive) this.#scanLive(scope);
        } catch (error) {
          console.warn('[gamification] scoped scan failed:', error);
        }
      }),
    );
  }

  /**
   * Read-model do perfil. Por padrão é só leitura.
   * `rescan: true` (hydrate/perfil) re-escaneia domínio com throttle e só em
   * runtime read-write — nunca em respostas de validação IPC inválida.
   */
  snapshot(
    scope: ProjectExecutionScope,
    options: { rescan?: boolean } = {},
  ): ScopedGamificationSnapshot {
    const state = this.#state(scope);
    const wasActive = state.activated;
    this.#activateScope(scope);
    if (options.rescan === true && wasActive) {
      this.#maybeRescanLive(scope);
    }
    const db = this.#database(scope, false);
    return this.#buildSnapshot(scope, db);
  }

  runRetroReplayOnce(scope: ProjectExecutionScope): void {
    const db = this.#database(scope, true);
    const suite = this.#domainStores.forScope(scope);
    this.#runRetroReplay(db, suite, scope);
    this.#state(scope).activated = true;
  }

  recordMediaGenerated(
    scope: ProjectExecutionScope,
    rawKind: string,
    missionId: string | null,
  ): ScopedGamificationSnapshot {
    const kind = z.string().min(1).max(64).parse(rawKind);
    this.#activateScope(scope);
    const db = this.#database(scope, true);
    const change = db.transaction(() => {
      const before = this.#buildSnapshot(scope, db);
      const extra = metaJson(db, 'counters_extra', countersSchema, {});
      bumpExtra(extra, `media_${kind}`);
      setMeta(db, 'counters_extra', JSON.stringify(extra));
      const input: XpEventInput = {
        kind: 'media_generated',
        entityKey: `media_generated:${randomUUID()}`,
        missionId,
        createdAt: this.#now(),
      };
      const scan: ScanResult = { insertedAny: false, deliveries: [] };
      if (this.#insertEvent(db, input, false)) scan.insertedAny = true;
      const after = this.#finalize(scope, db, scan, false);
      return after ? { before, after, retro: false } : null;
    })();
    if (change) this.#celebrateAndBroadcast(scope, change);
    return this.#buildSnapshot(scope, db);
  }

  recordJarvisAction(
    scope: ProjectExecutionScope,
    rawActionType: string,
    ok: boolean,
  ): ScopedGamificationSnapshot {
    const actionType = z.string().min(1).max(64).parse(rawActionType);
    if (!ok || actionType === 'none') return this.snapshot(scope);
    this.#activateScope(scope);
    const db = this.#database(scope, true);
    const change = db.transaction(() => {
      const before = this.#buildSnapshot(scope, db);
      const input: XpEventInput = {
        kind: 'jarvis_action',
        entityKey: `jarvis_action:${actionType}:${randomUUID()}`,
        createdAt: this.#now(),
      };
      const scan: ScanResult = { insertedAny: false, deliveries: [] };
      if (this.#insertEvent(db, input, false)) scan.insertedAny = true;
      const after = this.#finalize(scope, db, scan, false);
      return after ? { before, after, retro: false } : null;
    })();
    if (change) this.#celebrateAndBroadcast(scope, change);
    return this.#buildSnapshot(scope, db);
  }

  /**
   * Um turno de agente que entregou saída real (chamado pela telemetria de uso
   * quando um turno de Claude/Codex é registrado). XP pequeno e plano por
   * entrega — nunca proporcional a tokens — e conta para o streak, de modo que
   * o uso cotidiano com agentes, sem missões nem voz, faz o XP fluir.
   */
  recordAgentTurn(
    scope: ProjectExecutionScope,
    provider: string,
  ): ScopedGamificationSnapshot {
    const source = z.string().min(1).max(64).parse(provider);
    this.#activateScope(scope);
    const db = this.#database(scope, true);
    const change = db.transaction(() => {
      const before = this.#buildSnapshot(scope, db);
      const input: XpEventInput = {
        kind: 'agent_turn',
        entityKey: `agent_turn:${source}:${randomUUID()}`,
        createdAt: this.#now(),
      };
      const scan: ScanResult = { insertedAny: false, deliveries: [] };
      if (this.#insertEvent(db, input, false)) {
        scan.insertedAny = true;
        // agent_turn ∈ DELIVERY_KINDS → #finalize avança o streak.
        scan.deliveries.push(input);
      }
      const after = this.#finalize(scope, db, scan, false);
      return after ? { before, after, retro: false } : null;
    })();
    if (change) this.#celebrateAndBroadcast(scope, change);
    return this.#buildSnapshot(scope, db);
  }

  prestige(scope: ProjectExecutionScope): ScopedGamificationSnapshot {
    this.#activateScope(scope);
    const db = this.#database(scope, true);
    const result = db.transaction(() => {
      const snapshot = this.#buildSnapshot(scope, db);
      if (!snapshot.prestigeReady) return { snapshot, stars: null };
      const stars = snapshot.prestige + 1;
      setMeta(db, 'prestige', String(stars));
      setMeta(db, 'prestigeBaseline', String(this.#rawPower(db)));
      setMeta(db, 'tierFloor', 'RECRUTA');
      // Reavalia conquistas (ex.: transcendente) e skins no mesmo write.
      return { snapshot: this.#computeAndPersistDerived(scope, db), stars };
    })();
    if (result.stars === null) return result.snapshot;
    if (!this.#soberMode(scope)) {
      this.#broadcast(scope, 'voice:narrate', {
        text: GAMIFICATION_COPY.prestigeUp(result.stars),
      });
    }
    this.#scheduleChangedBroadcast(scope);
    return result.snapshot;
  }

  selectSkin(
    scope: ProjectExecutionScope,
    rawSkin: string | null,
  ): ScopedGamificationSnapshot {
    const skin = z.string().min(1).max(64).nullable().parse(rawSkin);
    this.#activateScope(scope);
    const db = this.#database(scope, true);
    const snapshot = this.#buildSnapshot(scope, db);
    if (skin !== null && !snapshot.skins.includes(skin)) return snapshot;
    setMeta(db, 'selectedSkin', skin ?? '');
    this.#scheduleChangedBroadcast(scope);
    return this.#buildSnapshot(scope, db);
  }

  exportProfile(scope: ProjectExecutionScope): ProfileExport {
    this.#activateScope(scope);
    const db = this.#database(scope, false);
    const events = listXpEvents(db);
    const meta = dumpMeta(db);
    return {
      version: 2,
      ruleVersion: RULE_VERSION,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      events,
      meta,
      checksum: profileChecksum(
        scope.projectId,
        scope.checkoutId,
        events,
        meta,
      ),
    };
  }

  importProfile(
    scope: ProjectExecutionScope,
    raw: unknown,
  ): { ok: boolean; error?: string } {
    this.#activateScope(scope);
    const db = this.#database(scope, true);
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Arquivo de perfil inválido.' };
    }
    const profile = raw as Partial<ProfileExport>;
    if (
      profile.version !== 2 ||
      profile.projectId !== scope.projectId ||
      profile.checkoutId !== scope.checkoutId ||
      !Array.isArray(profile.events) ||
      !profile.meta ||
      typeof profile.meta !== 'object' ||
      typeof profile.checksum !== 'string'
    ) {
      return {
        ok: false,
        error: 'Perfil pertence a outro projeto/checkout ou é inválido.',
      };
    }
    if (
      profileChecksum(
        profile.projectId,
        profile.checkoutId,
        profile.events,
        profile.meta,
      ) !== profile.checksum
    ) {
      return {
        ok: false,
        error: 'Checksum não confere — arquivo alterado ou corrompido.',
      };
    }
    try {
      replaceProfile(
        db,
        profile.events as StoredXpEvent[],
        profile.meta as Record<string, string>,
      );
    } catch {
      return { ok: false, error: 'Falha ao gravar o perfil importado.' };
    }
    this.#scheduleChangedBroadcast(scope);
    return { ok: true };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    for (const state of this.#states.values()) {
      if (state.changedTimer) clearTimeout(state.changedTimer);
    }
    this.#states.clear();
  }

  #activateScope(scope: ProjectExecutionScope): void {
    const state = this.#state(scope);
    if (state.activated) return;
    const runtime = this.#runtimeManager.open(state.scope);
    this.#verifySchema(state, runtime.db);
    if (runtime.mode !== 'read-write') {
      this.#scheduleChangedBroadcast(state.scope);
      return;
    }
    runtime.assertWritable();
    const suite = this.#domainStores.forScope(state.scope);
    this.#runRetroReplay(runtime.db, suite, state.scope);
    this.#scanAndFinalize(runtime.db, suite, state.scope, false);
    state.activated = true;
    state.lastRescanAt = this.#now();
    this.#scheduleChangedBroadcast(state.scope);
  }

  #scanLive(scope: ProjectExecutionScope): void {
    const state = this.#state(scope);
    // Cooldown inclusive em falha — evita martelar hydrate em loop.
    state.lastRescanAt = this.#now();
    const db = this.#database(scope, true);
    const suite = this.#domainStores.forScope(scope);
    this.#scanAndFinalize(db, suite, scope, false);
  }

  #maybeRescanLive(scope: ProjectExecutionScope): void {
    const state = this.#state(scope);
    if (this.#now() - state.lastRescanAt < SNAPSHOT_RESCAN_MIN_MS) return;
    try {
      const runtime = this.#runtimeManager.open(state.scope);
      if (runtime.mode !== 'read-write') return;
      this.#scanLive(scope);
    } catch (error) {
      console.warn('[gamification] snapshot rescan failed:', error);
    }
  }

  #scanAndFinalize(
    db: Database.Database,
    suite: ProjectDomainStoreSuite,
    scope: ProjectExecutionScope,
    retro: boolean,
  ): void {
    const change = db.transaction(() => {
      const before = this.#buildSnapshot(scope, db);
      const after = this.#finalize(
        scope,
        db,
        this.#scanStores(db, suite, retro),
        retro,
      );
      return after ? { before, after, retro } : null;
    })();
    if (change) this.#celebrateAndBroadcast(scope, change);
  }

  #runRetroReplay(
    db: Database.Database,
    suite: ProjectDomainStoreSuite,
    scope: ProjectExecutionScope,
  ): void {
    if (getMeta(db, 'replayDone')) return;
    const change = db.transaction(() => {
      const before = this.#buildSnapshot(scope, db);
      const after = this.#finalize(
        scope,
        db,
        this.#scanStores(db, suite, true),
        true,
      );
      setMeta(db, 'replayDone', '1');
      return after ? { before, after, retro: true } : null;
    })();
    if (change) this.#celebrateAndBroadcast(scope, change);
  }

  #scanStores(
    db: Database.Database,
    suite: ProjectDomainStoreSuite,
    retro: boolean,
  ): ScanResult {
    const result: ScanResult = { insertedAny: false, deliveries: [] };
    const extra = metaJson(db, 'counters_extra', countersSchema, {});
    let extraDirty = false;

    const allHandoffs = suite.handoffs.list({ includeDelivered: true });
    // Index O(n) — evita list(missionId) por missão (N+1 no main thread).
    const handoffsByMission = new Map<string, typeof allHandoffs>();
    for (const handoff of allHandoffs) {
      if (!handoff.missionId) continue;
      const bucket = handoffsByMission.get(handoff.missionId);
      if (bucket) bucket.push(handoff);
      else handoffsByMission.set(handoff.missionId, [handoff]);
    }

    // Evidência nexus-trusted quase nunca existe no fluxo real (operador
    // trabalha com panes): sem o ACK do orquestrador, handoff nenhum pontuava.
    const accepted = acceptedHandoffIds(db);
    for (const handoff of allHandoffs) {
      if (handoff.status !== 'success') continue;
      const trusted = handoff.evidenceTrust === 'nexus-trusted';
      if (!trusted && !accepted.has(handoff.id)) continue;
      const evidence =
        retro || !trusted ? null : handoff.evidenceIds.join(', ');
      const input: XpEventInput = {
        kind: evidence ? 'handoff_green' : 'handoff_success',
        entityKey: handoffKey(handoff.id),
        missionId: handoff.missionId ?? null,
        agentCategory: handoff.fromAgent
          ? this.#agentCategory(handoff.fromAgent)
          : null,
        effort: handoffEffort(suite, handoff),
        evidence,
        retro,
        createdAt: handoff.createdAt,
      };
      if (this.#insertEvent(db, input, retro)) {
        result.insertedAny = true;
        result.deliveries.push(input);
      }
    }

    for (const mission of suite.missions.list()) {
      if (mission.status !== 'done') continue;
      const missionHandoffs = handoffsByMission.get(mission.id) ?? [];
      const greenHandoff = retro
        ? null
        : missionHandoffs.find(
            (handoff) =>
              handoff.status === 'success' &&
              handoff.evidenceTrust === 'nexus-trusted',
          );
      const effort = missionEffort(suite, mission.id);
      const costUsd = missionCost(db, mission.id);
      const input: XpEventInput = {
        kind: greenHandoff ? 'mission_green' : 'mission_done',
        entityKey: missionKey(mission.id),
        missionId: mission.id,
        effort,
        costUsd,
        evidence: greenHandoff
          ? greenHandoff.evidenceIds.join(', ')
          : null,
        retro,
        createdAt: mission.updatedAt,
      };
      if (this.#insertEvent(db, input, retro)) {
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

    for (const task of suite.tasks.list()) {
      if (task.status !== 'done') continue;
      const input: XpEventInput = {
        kind: 'task_done',
        entityKey: taskKey(task.id),
        missionId: task.missionId ?? null,
        retro,
        createdAt: task.updatedAt,
      };
      if (this.#insertEvent(db, input, retro)) {
        result.insertedAny = true;
        result.deliveries.push(input);
      }
    }

    if (extraDirty) setMeta(db, 'counters_extra', JSON.stringify(extra));
    return result;
  }

  #insertEvent(
    db: Database.Database,
    input: XpEventInput,
    retro: boolean,
  ): boolean {
    const prior = retro
      ? 0
      : countTodaySameBucket(
          db,
          input.kind,
          input.effort,
          dayStartOf(this.#now()),
        );
    return insertXpEvent(db, input, computePoints(input, prior));
  }

  #finalize(
    scope: ProjectExecutionScope,
    db: Database.Database,
    scan: ScanResult,
    retro: boolean,
  ): ScopedGamificationSnapshot | null {
    if (!scan.insertedAny) return null;
    if (!retro) {
      let streak = metaJson(db, 'streak', streakSchema, EMPTY_STREAK);
      const deliveries = scan.deliveries
        .filter((delivery) => DELIVERY_KINDS.has(delivery.kind))
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const delivery of deliveries) {
        streak = advanceStreak(streak, new Date(delivery.createdAt));
      }
      setMeta(db, 'streak', JSON.stringify(streak));
    }
    return this.#computeAndPersistDerived(scope, db);
  }

  #celebrateAndBroadcast(
    scope: ProjectExecutionScope,
    change: FinalizedChange,
  ): void {
    if (!change.retro && !this.#soberMode(scope)) {
      if (tierRank(change.after.tier) > tierRank(change.before.tier)) {
        this.#broadcast(scope, 'voice:narrate', {
          text: GAMIFICATION_COPY.levelUp(change.after.tier),
        });
      }
      for (const id of change.after.achievements) {
        if (change.before.achievements.includes(id)) continue;
        const copy = GAMIFICATION_COPY.achievements[id];
        if (copy) {
          this.#broadcast(scope, 'voice:narrate', {
            text: GAMIFICATION_COPY.achievementUnlocked(copy.title),
          });
        }
      }
      if (change.after.branch !== change.before.branch) {
        this.#broadcast(scope, 'voice:narrate', {
          text: GAMIFICATION_COPY.branchEvolved(
            GAMIFICATION_COPY.branches[change.after.branch],
          ),
        });
      }
    }
    this.#scheduleChangedBroadcast(scope);
  }

  #computeAndPersistDerived(
    scope: ProjectExecutionScope,
    db: Database.Database,
  ): ScopedGamificationSnapshot {
    const snapshot = this.#buildSnapshot(scope, db);
    const storedFloor = tierSchema.parse(getMeta(db, 'tierFloor') ?? 'RECRUTA');
    if (tierRank(snapshot.tier) > tierRank(storedFloor)) {
      setMeta(db, 'tierFloor', snapshot.tier);
    }
    const unlocked = metaJson(db, 'achievements', stringListSchema, []);
    const fresh = evaluateAchievements(
      {
        counters: snapshot.counters,
        streakDays: snapshot.streakDays,
        prestige: snapshot.prestige,
        branch: snapshot.branch,
      },
      new Set(unlocked),
    );
    if (fresh.length > 0) {
      setMeta(
        db,
        'achievements',
        JSON.stringify([...unlocked, ...fresh.map((achievement) => achievement.id)]),
      );
      const skins = metaJson(db, 'skins', stringListSchema, []);
      const newSkins = fresh
        .map((achievement) => achievement.skin)
        .filter(
          (skin): skin is string =>
            Boolean(skin) && !skins.includes(skin as string),
        );
      if (newSkins.length > 0) {
        setMeta(db, 'skins', JSON.stringify([...skins, ...newSkins]));
      }
    }
    return this.#buildSnapshot(scope, db);
  }

  #buildSnapshot(
    scope: ProjectExecutionScope,
    db: Database.Database,
  ): ScopedGamificationSnapshot {
    const prestige = metaNumber(db, 'prestige', 0);
    const baseline = metaNumber(db, 'prestigeBaseline', 0);
    const events = listXpEvents(db);
    const aggregate = foldAggregate(events, prestige);
    const counters = { ...aggregate.counters };
    const extra = metaJson(db, 'counters_extra', countersSchema, {});
    for (const [key, value] of Object.entries(extra)) {
      counters[key] = (counters[key] ?? 0) + value;
    }
    const power = Math.max(0, aggregate.powerLevel - baseline);
    const floor = tierSchema.parse(getMeta(db, 'tierFloor') ?? 'RECRUTA');
    const tier = maxTier(tierForPower(power), floor);
    const streak = metaJson(db, 'streak', streakSchema, EMPTY_STREAK);
    const shieldsUsed =
      streak.shieldsUsedMonth === monthKeyOf(this.#now())
        ? streak.shieldsUsed
        : 0;
    const selectedSkinRaw = getMeta(db, 'selectedSkin');
    const selectedSkin =
      selectedSkinRaw === null || selectedSkinRaw === ''
        ? null
        : z.string().min(1).max(64).parse(selectedSkinRaw);
    const todayStart = dayStartOf(this.#now());
    let todayXp = 0;
    for (const event of events) {
      if (event.createdAt >= todayStart) todayXp += event.points;
    }
    return {
      powerLevel: power,
      tier,
      tierFloor: floor,
      nextTierAt: nextTierAt(power),
      prestige,
      prestigeReady: tier === 'LENDA' && power >= PRESTIGE_THRESHOLD,
      branch: aggregate.branch,
      streakDays: streak.streakDays,
      shieldsLeft: Math.max(0, SHIELDS_PER_MONTH - shieldsUsed),
      achievements: metaJson(db, 'achievements', stringListSchema, []),
      skins: metaJson(db, 'skins', stringListSchema, []),
      selectedSkin,
      counters,
      recent: groupRecentEvents(events),
      todayXp,
      ruleVersion: RULE_VERSION,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      rootRealPath: scope.rootRealPath,
    };
  }

  #rawPower(db: Database.Database): number {
    return foldAggregate(listXpEvents(db), 0).powerLevel;
  }

  #scheduleChangedBroadcast(scope: ProjectExecutionScope): void {
    const state = this.#state(scope);
    if (state.changedTimer || this.#disposed) return;
    state.changedTimer = setTimeout(() => {
      state.changedTimer = null;
      if (this.#disposed) return;
      try {
        this.#broadcast(
          state.scope,
          GAMIFICATION_CHANNELS.changed,
          this.#buildSnapshot(
            state.scope,
            this.#database(state.scope, false),
          ),
        );
      } catch (error) {
        console.warn('[gamification] scoped broadcast failed:', error);
      }
    }, 1_000);
    state.changedTimer.unref?.();
  }

  #state(scope: ProjectExecutionScope): ScopeState {
    if (this.#disposed) throw new Error('gamification service is disposed');
    const key = scopeKey(scope);
    const existing = this.#states.get(key);
    if (existing) {
      if (!sameScope(existing.scope, scope)) {
        throw new Error('gamification scope identity collision');
      }
      return existing;
    }
    const state: ScopeState = {
      scope: Object.freeze({ ...scope }),
      activated: false,
      schemaVerified: false,
      changedTimer: null,
      lastRescanAt: 0,
    };
    this.#states.set(key, state);
    return state;
  }

  #database(
    scope: ProjectExecutionScope,
    writable: boolean,
  ): Database.Database {
    const state = this.#state(scope);
    const runtime = this.#runtimeManager.open(state.scope);
    if (writable) runtime.assertWritable();
    this.#verifySchema(state, runtime.db);
    return runtime.db;
  }

  #verifySchema(state: ScopeState, db: Database.Database): void {
    if (state.schemaVerified) return;
    initGamificationStore(db);
    state.schemaVerified = true;
  }
}

export interface ProfileExport {
  version: 2;
  ruleVersion: number;
  projectId: string;
  checkoutId: string;
  events: StoredXpEvent[];
  meta: Record<string, string>;
  checksum: string;
}

function profileChecksum(
  projectId: string,
  checkoutId: string,
  events: unknown,
  meta: unknown,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ projectId, checkoutId, events, meta }))
    .digest('hex');
}

let configuredService: ProjectGamificationService | null = null;

export function configureGamificationService(
  options: ProjectGamificationServiceOptions,
): ProjectGamificationService {
  configuredService?.dispose();
  configuredService = new ProjectGamificationService(options);
  return configuredService;
}

export function requireGamificationService(): ProjectGamificationService {
  if (!configuredService) {
    throw new Error('project-scoped gamification service is not configured');
  }
  return configuredService;
}

export function shutdownGamificationService(): void {
  configuredService?.dispose();
  configuredService = null;
}
