# Gamificação Power-Scaling — Plan (Parte 2/3: streak, conquistas, store)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Sequência: Parte 1 `2026-07-06-gamificacao-parte-1-regras-engine.md` (PRÉ-REQUISITO) → **Parte 2** (esta) → Parte 3 `2026-07-06-gamificacao-parte-3-service-ui.md`.
> **Global Constraints:** ver Parte 1 (valem aqui integralmente).

**Goal:** Streak com dias úteis + escudos, catálogo de conquistas (copy no shared) e store SQLite event-sourced.

**Architecture:** Continuação dos módulos puros. Store testado com better-sqlite3 in-memory (padrão do repo: `describe.skipIf(!sqlite)`).

**Tech Stack:** TypeScript, vitest, better-sqlite3 (type-only `Db` de `persistence/db.ts`).

---

### Task 3: Streak com dias úteis + escudos

**Files:**
- Create: `src/main/gamification/streak.ts`
- Test: `src/main/gamification/streak.test.ts`

**Interfaces:**
- Consumes: nada (puro).
- Produces (Parte 3 Task 7): `SHIELDS_PER_MONTH = 2`; `StreakState = { streakDays: number; lastDeliveryDay: string | null; shieldsUsedMonth: string | null; shieldsUsed: number }`; `advanceStreak(state: StreakState, deliveryDate: Date): StreakState`; `businessDaysBetween(fromDay: string, toDay: string): number` (dias `YYYY-MM-DD` locais).

- [x] **Step 1: Teste que falha**

```ts
// src/main/gamification/streak.test.ts
import { describe, expect, it } from 'vitest';
import {
  advanceStreak,
  businessDaysBetween,
  SHIELDS_PER_MONTH,
  type StreakState,
} from './streak';

const EMPTY: StreakState = {
  streakDays: 0,
  lastDeliveryDay: null,
  shieldsUsedMonth: null,
  shieldsUsed: 0,
};

// 2026-07-06 é segunda; 07-03 é sexta; 07-04/05 = fim de semana.
describe('businessDaysBetween', () => {
  it('conta só dias úteis entre dois dias (exclusivo→inclusivo)', () => {
    expect(businessDaysBetween('2026-07-03', '2026-07-06')).toBe(1);
    expect(businessDaysBetween('2026-07-06', '2026-07-07')).toBe(1);
    expect(businessDaysBetween('2026-07-06', '2026-07-06')).toBe(0);
    expect(businessDaysBetween('2026-07-06', '2026-07-09')).toBe(3);
  });
});

describe('advanceStreak', () => {
  it('primeira entrega inicia streak = 1', () => {
    const s = advanceStreak(EMPTY, new Date('2026-07-06T10:00:00'));
    expect(s.streakDays).toBe(1);
    expect(s.lastDeliveryDay).toBe('2026-07-06');
  });

  it('mesma data não dobra; dia útil seguinte incrementa', () => {
    let s = advanceStreak(EMPTY, new Date('2026-07-06T10:00:00'));
    s = advanceStreak(s, new Date('2026-07-06T18:00:00'));
    expect(s.streakDays).toBe(1);
    s = advanceStreak(s, new Date('2026-07-07T09:00:00'));
    expect(s.streakDays).toBe(2);
  });

  it('fim de semana NÃO quebra (sex → seg mantém)', () => {
    let s = advanceStreak(EMPTY, new Date('2026-07-03T10:00:00'));
    s = advanceStreak(s, new Date('2026-07-06T10:00:00'));
    expect(s.streakDays).toBe(2);
  });

  it('1 dia útil perdido consome escudo e mantém; sem escudo, resseta', () => {
    let s = advanceStreak(EMPTY, new Date('2026-07-06T10:00:00'));
    s = advanceStreak(s, new Date('2026-07-08T10:00:00')); // pulou terça
    expect(s.streakDays).toBe(2);
    expect(s.shieldsUsed).toBe(1);
    s = advanceStreak(s, new Date('2026-07-13T10:00:00')); // pulou qui+sex
    expect(s.streakDays).toBe(1);
  });

  it('escudos zeram na virada do mês (2/mês)', () => {
    expect(SHIELDS_PER_MONTH).toBe(2);
    let s: StreakState = {
      streakDays: 5,
      lastDeliveryDay: '2026-07-30', // quinta
      shieldsUsedMonth: '2026-07',
      shieldsUsed: 2, // esgotados em julho
    };
    // sexta 31 pulada → gap 1 útil → escudo do MÊS NOVO cobre
    s = advanceStreak(s, new Date('2026-08-03T10:00:00')); // segunda
    expect(s.streakDays).toBe(6);
    expect(s.shieldsUsedMonth).toBe('2026-08');
    expect(s.shieldsUsed).toBe(1);
  });
});
```

- [x] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/gamification/streak.test.ts`
Expected: FAIL (`Cannot find module './streak'`)

- [x] **Step 3: Implementar**

```ts
// src/main/gamification/streak.ts
/**
 * Shipping streak com misericórdia: conta DIAS ÚTEIS (fim de semana nunca
 * quebra) e dá 2 escudos/mês — um dia útil perdido consome escudo em vez de
 * zerar (férias/imprevistos não viram punição). Puro e determinístico.
 */

export const SHIELDS_PER_MONTH = 2;

export interface StreakState {
  streakDays: number;
  /** Último dia com entrega, `YYYY-MM-DD` local. */
  lastDeliveryDay: string | null;
  /** Mês (`YYYY-MM`) a que se refere o contador de escudos. */
  shieldsUsedMonth: string | null;
  shieldsUsed: number;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthKey(day: string): string {
  return day.slice(0, 7);
}

function isBusinessDay(d: Date): boolean {
  const dow = d.getDay();
  return dow !== 0 && dow !== 6;
}

/** Dias ÚTEIS no intervalo (fromDay, toDay] — exclusivo no início. */
export function businessDaysBetween(fromDay: string, toDay: string): number {
  const cursor = new Date(`${fromDay}T12:00:00`);
  const end = new Date(`${toDay}T12:00:00`);
  let count = 0;
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor <= end && isBusinessDay(cursor)) count += 1;
  }
  return count;
}

export function advanceStreak(
  state: StreakState,
  deliveryDate: Date,
): StreakState {
  const today = dayKey(deliveryDate);
  const month = monthKey(today);
  // Vira o mês → zera o contador de escudos.
  const shieldsUsed = state.shieldsUsedMonth === month ? state.shieldsUsed : 0;

  if (!state.lastDeliveryDay) {
    return { streakDays: 1, lastDeliveryDay: today, shieldsUsedMonth: month, shieldsUsed };
  }
  if (state.lastDeliveryDay === today) {
    return { ...state, shieldsUsedMonth: month, shieldsUsed };
  }

  const gap = businessDaysBetween(state.lastDeliveryDay, today);
  const missed = Math.max(0, gap - 1); // hoje conta 1; perdidos = gap - 1
  if (missed === 0) {
    return {
      streakDays: state.streakDays + 1,
      lastDeliveryDay: today,
      shieldsUsedMonth: month,
      shieldsUsed,
    };
  }
  const shieldsLeft = SHIELDS_PER_MONTH - shieldsUsed;
  if (missed <= shieldsLeft) {
    return {
      streakDays: state.streakDays + 1,
      lastDeliveryDay: today,
      shieldsUsedMonth: month,
      shieldsUsed: shieldsUsed + missed,
    };
  }
  return { streakDays: 1, lastDeliveryDay: today, shieldsUsedMonth: month, shieldsUsed };
}
```

- [x] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/gamification/streak.test.ts`
Expected: PASS (6 testes)

- [x] **Step 5: Commit**

```bash
git add src/main/gamification/streak.ts src/main/gamification/streak.test.ts
git commit -m "feat(gamification): streak de dias úteis com 2 escudos/mês"
```

---

### Task 4: Conquistas (+ skins; copy no shared)

**Files:**
- Create: `src/main/gamification/achievements.ts`
- Modify: `src/shared/gamification-types.ts` (popular `GAMIFICATION_COPY.achievements`)
- Test: `src/main/gamification/achievements.test.ts`

**Interfaces:**
- Consumes (Parte 1 Task 2): shape de `counters` do fold (`mission_green`, `mission_done`, `handoff_green`, `handoff_success`, `deliveries_*`) + counters extras que a service (Parte 3) mantém em meta: `efficient_mission`, `agentic_mission`, `media_image`, `media_video`, `media_audio`.
- Produces (Parte 3 Tasks 7, 10):
  - `AchievementCtx = { counters: Record<string, number>; streakDays: number; prestige: number; branch: string }`
  - `AchievementDef = { id: string; skin?: string; test(ctx: AchievementCtx): boolean }`
  - `ACHIEVEMENTS: AchievementDef[]` (13 itens)
  - `evaluateAchievements(ctx, unlocked: Set<string>): AchievementDef[]` (só novas)

- [x] **Step 1: Teste que falha**

```ts
// src/main/gamification/achievements.test.ts
import { describe, expect, it } from 'vitest';
import { GAMIFICATION_COPY } from '../../shared/gamification-types';
import {
  ACHIEVEMENTS,
  evaluateAchievements,
  type AchievementCtx,
} from './achievements';

function ctx(over: Partial<AchievementCtx> = {}): AchievementCtx {
  return { counters: {}, streakDays: 0, prestige: 0, branch: 'base', ...over };
}

describe('achievements', () => {
  it('catálogo tem 12–15 conquistas, ids únicos e copy no shared', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(12);
    expect(ACHIEVEMENTS.length).toBeLessThanOrEqual(15);
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) {
      const copy = GAMIFICATION_COPY.achievements[a.id];
      expect(copy?.title.length).toBeGreaterThan(0);
      expect(copy?.description.length).toBeGreaterThan(0);
    }
  });

  it('desbloqueia por marcos de counters e não re-desbloqueia', () => {
    const news = evaluateAchievements(ctx({ counters: { mission_green: 1 } }), new Set());
    expect(news.map((a) => a.id)).toContain('primeira-missao-verde');
    const again = evaluateAchievements(
      ctx({ counters: { mission_green: 5 } }),
      new Set(['primeira-missao-verde']),
    );
    expect(again.map((a) => a.id)).not.toContain('primeira-missao-verde');
  });

  it('centuriao exige 100 handoffs somados (green + success)', () => {
    const quase = ctx({ counters: { handoff_green: 60, handoff_success: 39 } });
    expect(evaluateAchievements(quase, new Set()).map((a) => a.id)).not.toContain('centuriao');
    const cem = ctx({ counters: { handoff_green: 60, handoff_success: 40 } });
    expect(evaluateAchievements(cem, new Set()).map((a) => a.id)).toContain('centuriao');
  });

  it('streak, prestígio e ramo destravam as suas', () => {
    expect(
      evaluateAchievements(ctx({ streakDays: 5 }), new Set()).map((a) => a.id),
    ).toContain('sequencia-5');
    expect(
      evaluateAchievements(ctx({ prestige: 1 }), new Set()).map((a) => a.id),
    ).toContain('transcendente');
    expect(
      evaluateAchievements(ctx({ branch: 'forja' }), new Set()).map((a) => a.id),
    ).toContain('evolucao');
  });

  it('pelo menos 4 conquistas concedem skin', () => {
    expect(ACHIEVEMENTS.filter((a) => a.skin).length).toBeGreaterThanOrEqual(4);
  });
});
```

- [x] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/gamification/achievements.test.ts`
Expected: FAIL (`Cannot find module './achievements'`)

- [x] **Step 3: Implementar catálogo + popular copy no shared**

Em `src/shared/gamification-types.ts`, substituir o `achievements: {}` da
Task 1 por:

```ts
  achievements: {
    'primeira-missao': { title: 'Primeiro Deploy', description: 'Concluiu a primeira missão.' },
    'primeira-missao-verde': { title: 'Luz Verde', description: 'Primeira missão concluída com verificação passando.' },
    'primeira-agentica': { title: 'Arquiteto de Times', description: 'Primeira missão criada no modo Agêntico.' },
    'primeira-imagem': { title: 'Pintor Pixel', description: 'Primeira imagem gerada por um agente.' },
    'primeiro-video': { title: 'Diretor', description: 'Primeiro vídeo gerado por um agente.' },
    'primeiro-audio': { title: 'Locutor', description: 'Primeira locução gerada por um agente.' },
    centuriao: { title: 'Centurião', description: '100 handoffs entregues com sucesso.' },
    economico: { title: 'Eficiência de Elite', description: '10 missões fechadas na banda de custo eficiente.' },
    'sequencia-5': { title: 'Ritmo', description: 'Streak de 5 dias úteis entregando.' },
    'sequencia-20': { title: 'Imparável', description: 'Streak de 20 dias úteis entregando.' },
    evolucao: { title: 'Metamorfose', description: 'O mascote evoluiu para um ramo de especialização.' },
    maratona: { title: 'Maratonista', description: '50 missões verdes concluídas.' },
    transcendente: { title: 'Transcendente', description: 'Primeiro prestígio: a jornada recomeça com estrela.' },
  } as Record<string, { title: string; description: string }>,
```

```ts
// src/main/gamification/achievements.ts
/**
 * Conquistas v1 — avaliáveis a partir do agregado (counters/streak/prestígio/
 * ramo). Puro. Copy vive em GAMIFICATION_COPY.achievements (shared) para o
 * renderer não importar código do main. `skin` = paleta desbloqueada.
 */

export interface AchievementCtx {
  counters: Record<string, number>;
  streakDays: number;
  prestige: number;
  branch: string;
}

export interface AchievementDef {
  id: string;
  /** Skin (paleta) desbloqueada junto, quando houver. */
  skin?: string;
  test(ctx: AchievementCtx): boolean;
}

const c = (ctx: AchievementCtx, key: string) => ctx.counters[key] ?? 0;

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'primeira-missao', test: (x) => c(x, 'mission_done') + c(x, 'mission_green') >= 1 },
  { id: 'primeira-missao-verde', test: (x) => c(x, 'mission_green') >= 1 },
  { id: 'primeira-agentica', test: (x) => c(x, 'agentic_mission') >= 1 },
  { id: 'primeira-imagem', test: (x) => c(x, 'media_image') >= 1 },
  { id: 'primeiro-video', test: (x) => c(x, 'media_video') >= 1 },
  { id: 'primeiro-audio', test: (x) => c(x, 'media_audio') >= 1 },
  {
    id: 'centuriao',
    skin: 'centurion',
    test: (x) => c(x, 'handoff_green') + c(x, 'handoff_success') >= 100,
  },
  { id: 'economico', skin: 'gold', test: (x) => c(x, 'efficient_mission') >= 10 },
  { id: 'sequencia-5', test: (x) => x.streakDays >= 5 },
  { id: 'sequencia-20', skin: 'flame', test: (x) => x.streakDays >= 20 },
  { id: 'evolucao', test: (x) => x.branch !== 'base' },
  { id: 'maratona', test: (x) => c(x, 'mission_green') >= 50 },
  { id: 'transcendente', skin: 'prestige', test: (x) => x.prestige >= 1 },
];

export function evaluateAchievements(
  ctx: AchievementCtx,
  unlocked: Set<string>,
): AchievementDef[] {
  return ACHIEVEMENTS.filter((a) => !unlocked.has(a.id) && a.test(ctx));
}
```

- [x] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/gamification/achievements.test.ts`
Expected: PASS (5 testes)

- [x] **Step 5: Commit**

```bash
git add src/main/gamification/achievements.ts src/main/gamification/achievements.test.ts src/shared/gamification-types.ts
git commit -m "feat(gamification): 13 conquistas com skins; copy centralizado no shared (i18n)"
```

---

### Task 5: gamification-store (SQLite event-sourced)

**Files:**
- Create: `src/main/gamification/gamification-store.ts`
- Test: `src/main/gamification/gamification-store.test.ts`

**Interfaces:**
- Consumes: `Db` (type-only de `persistence/db.ts`); tipos Parte 1; `RULE_VERSION`.
- Produces (Parte 3 Task 7):
  - `initGamificationStore(db: Db): void`
  - `insertXpEvent(db: Db, input: XpEventInput, points: number): boolean` (false = duplicado)
  - `listXpEvents(db: Db): StoredXpEvent[]`
  - `countTodaySameBucket(db: Db, kind: XpEventKind, effort: string | null | undefined, dayStart: number): number`
  - `getMeta(db: Db, key: string): string | null` / `setMeta(db: Db, key: string, value: string): void`

- [x] **Step 1: Teste que falha**

```ts
// src/main/gamification/gamification-store.test.ts
import { describe, expect, it } from 'vitest';
import type { Db } from '../persistence/db';
import type { XpEventInput } from '../../shared/gamification-types';
import {
  countTodaySameBucket,
  getMeta,
  initGamificationStore,
  insertXpEvent,
  listXpEvents,
  setMeta,
} from './gamification-store';

// better-sqlite3 é módulo nativo; rebuildado p/ Electron não carrega no node
// do vitest — os testes de SQL viram skip, não falha (padrão do repo).
let sqlite: (new (file: string) => Db) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sqlite = require('better-sqlite3') as new (file: string) => Db;
  new sqlite(':memory:').close();
} catch {
  sqlite = null;
}

function ev(over: Partial<XpEventInput> = {}): XpEventInput {
  return {
    kind: 'handoff_green',
    entityKey: 'handoff_green:h1',
    effort: 'medium',
    createdAt: 1_000,
    ...over,
  };
}

describe.skipIf(!sqlite)('gamification-store (SQLite real)', () => {
  function makeDb(): Db {
    const db = new (sqlite as new (file: string) => Db)(':memory:');
    initGamificationStore(db);
    return db;
  }

  it('insere evento e lista com pontos e ruleVersion', () => {
    const db = makeDb();
    expect(insertXpEvent(db, ev(), 8_000)).toBe(true);
    const events = listXpEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].points).toBe(8_000);
    expect(events[0].ruleVersion).toBe(1);
    db.close();
  });

  it('idempotência: mesma entityKey não insere duas vezes', () => {
    const db = makeDb();
    expect(insertXpEvent(db, ev(), 8_000)).toBe(true);
    expect(insertXpEvent(db, ev(), 8_000)).toBe(false);
    expect(listXpEvents(db)).toHaveLength(1);
    db.close();
  });

  it('countTodaySameBucket conta só o mesmo dia + mesmo bucket de effort', () => {
    const db = makeDb();
    insertXpEvent(db, ev({ entityKey: 'handoff_green:a', createdAt: 100 }), 1);
    insertXpEvent(db, ev({ entityKey: 'handoff_green:b', createdAt: 200 }), 1);
    insertXpEvent(
      db,
      ev({ entityKey: 'handoff_green:c', createdAt: 300, effort: 'high' }),
      1,
    );
    expect(countTodaySameBucket(db, 'handoff_green', 'medium', 0)).toBe(2);
    expect(countTodaySameBucket(db, 'handoff_green', 'high', 0)).toBe(1);
    db.close();
  });

  it('meta: get/set roundtrip com overwrite', () => {
    const db = makeDb();
    expect(getMeta(db, 'streak')).toBeNull();
    setMeta(db, 'streak', JSON.stringify({ streakDays: 3 }));
    expect(JSON.parse(getMeta(db, 'streak')!)).toEqual({ streakDays: 3 });
    setMeta(db, 'streak', 'x');
    expect(getMeta(db, 'streak')).toBe('x');
    db.close();
  });
});
```

- [x] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/gamification/gamification-store.test.ts`
Expected: FAIL (`Cannot find module './gamification-store'`)

- [x] **Step 3: Implementar**

```ts
// src/main/gamification/gamification-store.ts
import type { Db } from '../persistence/db';
import type {
  StoredXpEvent,
  XpEventInput,
  XpEventKind,
} from '../../shared/gamification-types';
import { RULE_VERSION } from './xp-rules';

/**
 * Persistência da gamificação — event-sourced no SQLite compartilhado:
 * `xp_events` é a verdade (auditável, UNIQUE por entity_key = idempotência);
 * o agregado é derivável (recompute barato). Estado pequeno (streak,
 * prestígio, conquistas, skins, counters extras) vive em `gamification_meta`
 * como JSON. Funções puras sobre Db — testáveis in-memory.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS xp_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_key     TEXT    NOT NULL UNIQUE,
  kind           TEXT    NOT NULL,
  mission_id     TEXT,
  agent_category TEXT,
  effort         TEXT,
  cost_usd       REAL,
  evidence       TEXT,
  retro          INTEGER NOT NULL DEFAULT 0,
  points         INTEGER NOT NULL,
  rule_version   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_events_day ON xp_events(created_at);
CREATE TABLE IF NOT EXISTS gamification_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function initGamificationStore(db: Db): void {
  db.exec(SCHEMA);
}

export function insertXpEvent(
  db: Db,
  input: XpEventInput,
  points: number,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO xp_events
         (entity_key, kind, mission_id, agent_category, effort, cost_usd,
          evidence, retro, points, rule_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.entityKey,
      input.kind,
      input.missionId ?? null,
      input.agentCategory ?? null,
      input.effort ?? null,
      input.costUsd ?? null,
      input.evidence ?? null,
      input.retro ? 1 : 0,
      points,
      RULE_VERSION,
      input.createdAt,
    ) as { changes: number };
  return result.changes > 0;
}

interface XpRow {
  id: number;
  entity_key: string;
  kind: string;
  mission_id: string | null;
  agent_category: string | null;
  effort: string | null;
  cost_usd: number | null;
  evidence: string | null;
  retro: number;
  points: number;
  rule_version: number;
  created_at: number;
}

export function listXpEvents(db: Db): StoredXpEvent[] {
  const rows = db
    .prepare('SELECT * FROM xp_events ORDER BY created_at, id')
    .all() as XpRow[];
  return rows.map((r) => ({
    id: r.id,
    entityKey: r.entity_key,
    kind: r.kind as XpEventKind,
    missionId: r.mission_id,
    agentCategory: r.agent_category,
    effort: r.effort,
    costUsd: r.cost_usd,
    evidence: r.evidence,
    retro: r.retro === 1,
    points: r.points,
    ruleVersion: r.rule_version,
    createdAt: r.created_at,
  }));
}

/** Entregas de HOJE no mesmo bucket (kind + effort) — retorno decrescente. */
export function countTodaySameBucket(
  db: Db,
  kind: XpEventKind,
  effort: string | null | undefined,
  dayStart: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM xp_events
       WHERE kind = ? AND created_at >= ? AND retro = 0
         AND COALESCE(effort, 'medium') = COALESCE(?, 'medium')`,
    )
    .get(kind, dayStart, effort ?? null) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function getMeta(db: Db, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM gamification_meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO gamification_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
```

- [x] **Step 4: Rodar e ver passar + typecheck**

Run: `npx vitest run src/main/gamification && npm run typecheck`
Expected: PASS (todas as suites da pasta) + typecheck limpo

- [x] **Step 5: Commit**

```bash
git add src/main/gamification/gamification-store.ts src/main/gamification/gamification-store.test.ts
git commit -m "feat(gamification): store SQLite event-sourced (idempotência, buckets diários, meta)"
```

→ **Continuar na Parte 3:** `docs/superpowers/plans/2026-07-06-gamificacao-parte-3-service-ui.md`
