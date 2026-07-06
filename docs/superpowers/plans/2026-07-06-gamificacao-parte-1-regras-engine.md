# Gamificação Power-Scaling — Plan (Parte 1/3: tipos, regras, engine)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Sequência: **Parte 1** (esta) → Parte 2 `2026-07-06-gamificacao-parte-2-streak-store.md` → Parte 3 `2026-07-06-gamificacao-parte-3-service-ui.md`.

**Goal:** Tipos compartilhados, regras de XP versionadas e engine puro (pontos + agregado + ramo do mascote).

**Architecture:** Read-model sobre os stores existentes (spec: `docs/superpowers/specs/2026-07-06-gamificacao-power-scaling-design.md`). Esta parte entrega SÓ módulos puros (zero electron), unit-testados.

**Tech Stack:** TypeScript, vitest.

## Global Constraints (valem para as 3 partes)

- **XP = entrega, NUNCA token gasto** (spec §1). Nenhum evento de XP deriva de volume de tokens.
- Tiers: `RECRUTA → INICIADO → VETERANO → ELITE → MAESTRO → LENDA`; curva exponencial; nunca rebaixar tier alcançado (piso, aplicado na Parte 3).
- Módulos testados são **puros (sem import de electron)**; type-only import de `persistence/db.ts` é ok.
- Todo copy vem de tokens (`GAMIFICATION_COPY`), PT-BR primeiro.
- Idempotência: evento tem `entityKey` única com `UNIQUE` no SQLite.
- `RULE_VERSION = 1` acompanha cada evento.
- Mascote/arte/copy 100% originais — nenhuma referência a marcas/IPs de terceiros (nem a concorrentes) em código, copy ou comentários.
- Testes: `npx vitest run <arquivo>`; typecheck: `npm run typecheck`. Commits frequentes (sem atribuição).

---

### Task 1: Tipos compartilhados + regras (xp-rules)

**Files:**
- Create: `src/shared/gamification-types.ts`
- Create: `src/main/gamification/xp-rules.ts`
- Test: `src/main/gamification/xp-rules.test.ts`

**Interfaces:**
- Consumes: nada (puro).
- Produces (Tasks 2+ e Partes 2–3):
  - Tipos: `GamificationTier`, `OperatorBranch = 'base'|'guardiao'|'forja'|'scout'`, `XpEventKind`, `XpEventInput`, `StoredXpEvent`, `GamificationSnapshot`, `GAMIFICATION_CHANNELS`, `GAMIFICATION_COPY` (o campo `achievements` nasce `{}` e é populado na Parte 2 Task 4).
  - Regras: `RULE_VERSION`, `BASE_POINTS`, `effortScale(effort?)`, `diminishingFactor(n)`, `efficiencyBonus(kind, effort, costUsd)`, `TIER_THRESHOLDS`, `tierForPower(p)`, `nextTierAt(p)`, `PRESTIGE_THRESHOLD`.

- [x] **Step 1: Escrever os tipos compartilhados**

```ts
// src/shared/gamification-types.ts
/**
 * Gamificação — contratos main/renderer. Princípio: XP = valor entregue,
 * NUNCA consumo de tokens (custo aparece só como estatística/eficiência).
 */

export type GamificationTier =
  | 'RECRUTA'
  | 'INICIADO'
  | 'VETERANO'
  | 'ELITE'
  | 'MAESTRO'
  | 'LENDA';

export type OperatorBranch = 'base' | 'guardiao' | 'forja' | 'scout';

export type XpEventKind =
  | 'mission_green'
  | 'mission_done'
  | 'handoff_green'
  | 'handoff_success'
  | 'task_done'
  | 'media_generated';

/** Entrada pura do engine (a borda resolve effort/custo/evidência antes). */
export interface XpEventInput {
  kind: XpEventKind;
  /** Chave de idempotência: `${kind}:${entityId}` — UNIQUE no SQLite. */
  entityKey: string;
  missionId?: string | null;
  /** Categoria do agente que entregou (ramificação do mascote). */
  agentCategory?: string | null;
  /** Proxy persistido do tier do router (mission_panes.effort). */
  effort?: string | null;
  /** Custo real da missão (tokens+mídia) p/ bônus de eficiência. */
  costUsd?: number | null;
  /** Evidência de verificação (comando + exit 0), quando houver. */
  evidence?: string | null;
  /** Evento do replay retroativo (peso simples, sem evidência/narração). */
  retro?: boolean;
  createdAt: number;
}

export interface StoredXpEvent extends XpEventInput {
  id: number;
  points: number;
  ruleVersion: number;
}

export interface GamificationSnapshot {
  powerLevel: number;
  tier: GamificationTier;
  /** Piso: nunca rebaixa tier já alcançado, mesmo re-score de regras. */
  tierFloor: GamificationTier;
  nextTierAt: number | null;
  prestige: number;
  prestigeReady: boolean;
  branch: OperatorBranch;
  streakDays: number;
  shieldsLeft: number;
  achievements: string[];
  skins: string[];
  selectedSkin: string | null;
  counters: Record<string, number>;
  ruleVersion: number;
}

export const GAMIFICATION_CHANNELS = {
  snapshot: 'gamification:snapshot',
  changed: 'gamification:changed',
  selectSkin: 'gamification:selectSkin',
  exportProfile: 'gamification:export',
  importProfile: 'gamification:import',
  prestige: 'gamification:prestige',
} as const;

/** Copy em tokens (i18n desde o dia 1 — PT-BR primeiro). */
export const GAMIFICATION_COPY = {
  tiers: {
    RECRUTA: 'RECRUTA',
    INICIADO: 'INICIADO',
    VETERANO: 'VETERANO',
    ELITE: 'ELITE',
    MAESTRO: 'MAESTRO',
    LENDA: 'LENDA',
  } as Record<GamificationTier, string>,
  branches: {
    base: 'Operador',
    guardiao: 'Guardião',
    forja: 'Forja',
    scout: 'Scout',
  } as Record<OperatorBranch, string>,
  levelUp: (tier: GamificationTier) => `Subiu para ${tier}.`,
  prestigeUp: (stars: number) => `Transcendência ${stars} alcançada.`,
  achievementUnlocked: (title: string) => `Conquista desbloqueada: ${title}.`,
  /** id → copy da conquista (renderer nunca importa código do main).
   *  Populado na Parte 2 Task 4. */
  achievements: {} as Record<string, { title: string; description: string }>,
} as const;
```

- [x] **Step 2: Escrever o teste que falha**

```ts
// src/main/gamification/xp-rules.test.ts
import { describe, expect, it } from 'vitest';
import {
  BASE_POINTS,
  diminishingFactor,
  efficiencyBonus,
  effortScale,
  nextTierAt,
  PRESTIGE_THRESHOLD,
  RULE_VERSION,
  TIER_THRESHOLDS,
  tierForPower,
} from './xp-rules';

describe('xp-rules', () => {
  it('pesos: entrega verde vale mais que simples; token NUNCA é fonte', () => {
    expect(BASE_POINTS.mission_green).toBeGreaterThan(BASE_POINTS.mission_done);
    expect(BASE_POINTS.handoff_green).toBeGreaterThan(BASE_POINTS.handoff_success);
    expect(Object.keys(BASE_POINTS)).not.toContain('token_spent');
    expect(RULE_VERSION).toBe(1);
  });

  it('effortScale: low < medium < high; desconhecido = neutro (1)', () => {
    expect(effortScale('low')).toBeLessThan(effortScale('medium'));
    expect(effortScale('medium')).toBeLessThan(effortScale('high'));
    expect(effortScale('medium')).toBe(1);
    expect(effortScale(undefined)).toBe(1);
    expect(effortScale('whatever')).toBe(1);
  });

  it('anti-farm: retorno decrescente por contagem no dia', () => {
    expect(diminishingFactor(0)).toBe(1);
    expect(diminishingFactor(4)).toBe(1);
    expect(diminishingFactor(5)).toBe(0.5);
    expect(diminishingFactor(9)).toBe(0.5);
    expect(diminishingFactor(10)).toBe(0.25);
    expect(diminishingFactor(50)).toBe(0.25);
  });

  it('eficiência: banda fixa por effort, só p/ missão verde, até +50%', () => {
    expect(efficiencyBonus('mission_green', 'medium', 0.3)).toBeCloseTo(0.5);
    expect(efficiencyBonus('mission_green', 'medium', 5)).toBe(0);
    expect(efficiencyBonus('mission_green', undefined, 0.3)).toBe(0);
    expect(efficiencyBonus('mission_green', 'medium', null)).toBe(0);
    expect(efficiencyBonus('handoff_green', 'medium', 0.01)).toBe(0);
  });

  it('tiers: escada exponencial RECRUTA→LENDA com piso em 0', () => {
    expect(TIER_THRESHOLDS[0]).toEqual({ tier: 'RECRUTA', minPower: 0 });
    expect(tierForPower(0)).toBe('RECRUTA');
    expect(tierForPower(100_000)).toBe('INICIADO');
    expect(tierForPower(25_000_000)).toBe('LENDA');
    for (let i = 2; i < TIER_THRESHOLDS.length; i += 1) {
      expect(TIER_THRESHOLDS[i].minPower).toBeGreaterThanOrEqual(
        TIER_THRESHOLDS[i - 1].minPower * 3,
      );
    }
  });

  it('nextTierAt aponta o próximo limiar; LENDA aponta prestígio', () => {
    expect(nextTierAt(0)).toBe(100_000);
    expect(nextTierAt(25_000_000)).toBe(PRESTIGE_THRESHOLD);
  });
});
```

- [x] **Step 3: Rodar e ver falhar**

Run: `npx vitest run src/main/gamification/xp-rules.test.ts`
Expected: FAIL (`Cannot find module './xp-rules'`)

- [x] **Step 4: Implementar as regras**

```ts
// src/main/gamification/xp-rules.ts
import type {
  GamificationTier,
  XpEventKind,
} from '../../shared/gamification-types';

/**
 * Regras de XP v1 — TODAS as constantes calibráveis vivem aqui, versionadas.
 * Rebalancear = subir RULE_VERSION e recomputar o agregado dos eventos
 * (nunca rebaixando tier já alcançado — piso aplicado no fold da borda).
 * Lógica pura (sem electron) — unit-testável.
 */

export const RULE_VERSION = 1;

/** XP base por tipo de entrega. Token gasto NÃO é (e nunca será) um kind. */
export const BASE_POINTS: Record<XpEventKind, number> = {
  mission_green: 25_000,
  mission_done: 10_000,
  handoff_green: 8_000,
  handoff_success: 3_000,
  task_done: 5_000,
  media_generated: 1_000,
};

/**
 * Escala pelo esforço/tier da tarefa (proxy persistido da decisão do router:
 * mission_panes.effort). Anti-farm: migalha rende migalha.
 */
export function effortScale(effort?: string | null): number {
  switch (effort) {
    case 'low':
      return 0.5;
    case 'high':
      return 1.8;
    case 'medium':
    default:
      return 1;
  }
}

/** Retorno decrescente diário: 5 inteiras, 5 pela metade, resto a 1/4. */
export function diminishingFactor(priorTodayCount: number): number {
  if (priorTodayCount < 5) return 1;
  if (priorTodayCount < 10) return 0.5;
  return 0.25;
}

/**
 * Bandas FIXAS de custo eficiente por effort (USD por missão) — comparar com
 * a média do próprio usuário puniria quem melhora e sofre cold start.
 */
const EFFICIENT_COST_BANDS: Record<string, number> = {
  low: 0.1,
  medium: 0.75,
  high: 3.0,
};

const EFFICIENCY_BONUS = 0.5; // até +50% sobre o XP base da missão verde

export function efficiencyBonus(
  kind: XpEventKind,
  effort: string | null | undefined,
  costUsd: number | null | undefined,
): number {
  if (kind !== 'mission_green') return 0;
  if (typeof costUsd !== 'number' || costUsd < 0) return 0;
  const band = effort ? EFFICIENT_COST_BANDS[effort] : undefined;
  if (band === undefined) return 0;
  return costUsd <= band ? EFFICIENCY_BONUS : 0;
}

/** Escada exponencial (~3–4× por banda). */
export const TIER_THRESHOLDS: Array<{
  tier: GamificationTier;
  minPower: number;
}> = [
  { tier: 'RECRUTA', minPower: 0 },
  { tier: 'INICIADO', minPower: 100_000 },
  { tier: 'VETERANO', minPower: 400_000 },
  { tier: 'ELITE', minPower: 1_500_000 },
  { tier: 'MAESTRO', minPower: 6_000_000 },
  { tier: 'LENDA', minPower: 25_000_000 },
];

/** Ao cruzar isto em LENDA o jogador pode transcender (prestígio). */
export const PRESTIGE_THRESHOLD = 100_000_000;

export function tierForPower(power: number): GamificationTier {
  let current: GamificationTier = 'RECRUTA';
  for (const { tier, minPower } of TIER_THRESHOLDS) {
    if (power >= minPower) current = tier;
  }
  return current;
}

export function nextTierAt(power: number): number | null {
  for (const { minPower } of TIER_THRESHOLDS) {
    if (power < minPower) return minPower;
  }
  return PRESTIGE_THRESHOLD;
}
```

- [x] **Step 5: Rodar e ver passar**

Run: `npx vitest run src/main/gamification/xp-rules.test.ts`
Expected: PASS (6 testes)

- [x] **Step 6: Commit**

```bash
git add src/shared/gamification-types.ts src/main/gamification/xp-rules.ts src/main/gamification/xp-rules.test.ts
git commit -m "feat(gamification): tipos compartilhados + regras de XP v1 (pesos, tiers, anti-farm, eficiência)"
```

---

### Task 2: XP engine (evento → pontos; eventos → agregado)

**Files:**
- Create: `src/main/gamification/xp-engine.ts`
- Test: `src/main/gamification/xp-engine.test.ts`

**Interfaces:**
- Consumes (Task 1): regras + tipos.
- Produces (Parte 2 Task 5; Parte 3 Task 7):
  - `computePoints(input: XpEventInput, priorTodayCount: number): number`
  - `foldAggregate(events: StoredXpEvent[], prestige: number): Aggregate` — `Aggregate = { powerLevel: number; tier: GamificationTier; nextTierAt: number | null; branch: OperatorBranch; counters: Record<string, number> }`
  - `branchFor(counters: Record<string, number>): OperatorBranch`
  - `BRANCH_MIN_DELIVERIES = 20`, `BRANCH_DOMINANCE = 0.45`

- [x] **Step 1: Teste que falha**

```ts
// src/main/gamification/xp-engine.test.ts
import { describe, expect, it } from 'vitest';
import type { StoredXpEvent, XpEventInput } from '../../shared/gamification-types';
import { branchFor, computePoints, foldAggregate } from './xp-engine';
import { RULE_VERSION } from './xp-rules';

function input(over: Partial<XpEventInput> = {}): XpEventInput {
  return {
    kind: 'handoff_green',
    entityKey: 'handoff_green:h1',
    effort: 'medium',
    createdAt: 1_000,
    ...over,
  };
}

function stored(points: number, over: Partial<StoredXpEvent> = {}): StoredXpEvent {
  return { id: 1, points, ruleVersion: RULE_VERSION, ...input(), ...over };
}

describe('computePoints', () => {
  it('base × effort × diminishing; retro usa peso simples', () => {
    expect(computePoints(input(), 0)).toBe(8_000);
    expect(computePoints(input({ effort: 'high' }), 0)).toBe(14_400);
    expect(computePoints(input(), 5)).toBe(4_000);
    expect(computePoints(input({ kind: 'mission_green', retro: true }), 0)).toBe(10_000);
  });

  it('bônus de eficiência só em missão verde com custo na banda', () => {
    expect(computePoints(input({ kind: 'mission_green', costUsd: 0.3 }), 0)).toBe(37_500);
    expect(computePoints(input({ kind: 'mission_green', costUsd: 50 }), 0)).toBe(25_000);
  });

  it('pontos são inteiros e nunca negativos', () => {
    const p = computePoints(input({ effort: 'low' }), 10);
    expect(Number.isInteger(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(0);
  });
});

describe('branchFor', () => {
  it('exige volume mínimo E dominância', () => {
    expect(branchFor({ deliveries_reviewer: 5 })).toBe('base');
    expect(branchFor({ deliveries_reviewer: 15, deliveries_executor: 10 })).toBe('guardiao');
    expect(
      branchFor({ deliveries_reviewer: 10, deliveries_executor: 10, deliveries_scout: 10 }),
    ).toBe('base');
    expect(branchFor({ deliveries_scout: 30, deliveries_executor: 5 })).toBe('scout');
    expect(branchFor({ deliveries_executor: 30, deliveries_reviewer: 5 })).toBe('forja');
  });
});

describe('foldAggregate', () => {
  it('soma power, deriva tier e counters por kind/categoria', () => {
    const events: StoredXpEvent[] = [
      stored(25_000, { kind: 'mission_green', entityKey: 'mission_green:m1' }),
      stored(80_000, { kind: 'mission_green', entityKey: 'mission_green:m2' }),
      stored(8_000, { agentCategory: 'reviewer' }),
    ];
    const agg = foldAggregate(events, 0);
    expect(agg.powerLevel).toBe(113_000);
    expect(agg.tier).toBe('INICIADO');
    expect(agg.nextTierAt).toBe(400_000);
    expect(agg.counters.mission_green).toBe(2);
    expect(agg.counters.deliveries_reviewer).toBe(1);
  });

  it('agregado vazio = RECRUTA zerado', () => {
    const agg = foldAggregate([], 0);
    expect(agg.powerLevel).toBe(0);
    expect(agg.tier).toBe('RECRUTA');
    expect(agg.branch).toBe('base');
  });
});
```

- [x] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/gamification/xp-engine.test.ts`
Expected: FAIL (`Cannot find module './xp-engine'`)

- [x] **Step 3: Implementar o engine**

```ts
// src/main/gamification/xp-engine.ts
import type {
  GamificationTier,
  OperatorBranch,
  StoredXpEvent,
  XpEventInput,
} from '../../shared/gamification-types';
import {
  BASE_POINTS,
  diminishingFactor,
  efficiencyBonus,
  effortScale,
  nextTierAt,
  tierForPower,
} from './xp-rules';

/**
 * Engine puro de XP: evento → pontos, eventos → agregado. Sem electron, sem
 * IO — a borda (gamification-service, Parte 3) resolve inputs e persiste.
 */

export const BRANCH_MIN_DELIVERIES = 20;
export const BRANCH_DOMINANCE = 0.45;

export function computePoints(
  input: XpEventInput,
  priorTodayCount: number,
): number {
  // Retro (replay do histórico): entregas antigas não têm evidência —
  // "verde" histórico vale o peso da entrega simples equivalente.
  const kind =
    input.retro && input.kind === 'mission_green'
      ? 'mission_done'
      : input.retro && input.kind === 'handoff_green'
      ? 'handoff_success'
      : input.kind;
  const base = BASE_POINTS[kind];
  const scaled = base * effortScale(input.effort);
  const diminished = scaled * diminishingFactor(priorTodayCount);
  const bonus = input.retro
    ? 0
    : efficiencyBonus(kind, input.effort, input.costUsd);
  return Math.max(0, Math.round(diminished * (1 + bonus)));
}

/** Ramo do mascote a partir dos counters de entrega por categoria. */
export function branchFor(counters: Record<string, number>): OperatorBranch {
  const guardiao = counters.deliveries_reviewer ?? 0;
  const forja = counters.deliveries_executor ?? 0;
  const scout =
    (counters.deliveries_scout ?? 0) + (counters.deliveries_architect ?? 0);
  const total = guardiao + forja + scout;
  if (total < BRANCH_MIN_DELIVERIES) return 'base';
  const shares: Array<[OperatorBranch, number]> = [
    ['guardiao', guardiao / total],
    ['forja', forja / total],
    ['scout', scout / total],
  ];
  shares.sort((a, b) => b[1] - a[1]);
  return shares[0][1] >= BRANCH_DOMINANCE ? shares[0][0] : 'base';
}

export interface Aggregate {
  powerLevel: number;
  tier: GamificationTier;
  nextTierAt: number | null;
  branch: OperatorBranch;
  counters: Record<string, number>;
}

export function foldAggregate(
  events: StoredXpEvent[],
  _prestige: number,
): Aggregate {
  let power = 0;
  const counters: Record<string, number> = {};
  const bump = (key: string) => {
    counters[key] = (counters[key] ?? 0) + 1;
  };
  for (const ev of events) {
    power += ev.points;
    bump(ev.kind);
    if (ev.agentCategory) bump(`deliveries_${ev.agentCategory}`);
  }
  return {
    powerLevel: power,
    tier: tierForPower(power),
    nextTierAt: nextTierAt(power),
    branch: branchFor(counters),
    counters,
  };
}
```

- [x] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/gamification/xp-engine.test.ts`
Expected: PASS (6 testes)

- [x] **Step 5: Commit**

```bash
git add src/main/gamification/xp-engine.ts src/main/gamification/xp-engine.test.ts
git commit -m "feat(gamification): XP engine puro (pontos com anti-farm/eficiência; fold de agregado + ramo)"
```

→ **Continuar na Parte 2:** `docs/superpowers/plans/2026-07-06-gamificacao-parte-2-streak-store.md`
