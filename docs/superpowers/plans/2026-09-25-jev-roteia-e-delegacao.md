# Jev roteia os spawns + delegação automática — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Os panes que os agentes do operador abrem passam sempre pelo Jev + tabela de rota (com queda visível e desempate por diversidade), e todo pane da mão do operador aprende a delegar — doutrina no nascimento, conselho do Jev por mensagem e trilhos no Main.

**Architecture:** Parte A mexe no roteamento: `judge()` expõe o motivo da falha, `jev-task-routing` devolve classificação ou motivo, o `routeTask` ganha um desempate puro (`tieBreakByUse`) e o `nexus_pane_spawn` força o roteamento no caminho `operatorHand`, levando a origem da rota até o renderer (chip + toast). Parte C adiciona `instructions` ao `initialize` do MCP, uma superfície Jev `delegation` servida por `POST /hook/delegate` a partir do hook `UserPromptSubmit`, e trilhos no Main: fila de writers delegados, auto-close no sucesso, helper nascendo na aba do pai e teto de panes duro para spawn de agente.

**Tech Stack:** Electron (main/preload/renderer), TypeScript, React 19 + zustand, vitest (jsdom nos testes de componente), zod.

**Spec:** `docs/superpowers/specs/2026-09-25-jev-roteia-spawn-design.md` (A) e `docs/superpowers/specs/2026-09-25-delegacao-automatica-design.md` (C). Leia as duas antes de começar.

## Global Constraints

- Só o caminho `operatorHand` (`ctx.role === 'user' && !ctx.missionId`, sem `missionId` nos args) muda. Missões (orquestrador, worker, roster, `routeReservationId`, worktree por task) ficam byte a byte iguais.
- `operatorParentSessionId` nunca vai ao renderer: o Main converte em `parentPaneId` (`main-owned-pane-runtime.ts:98`: "never copied into the renderer request").
- Toda superfície Jev é FAIL-OPEN: sem chave, desligada, timeout ou erro → comportamento de hoje, nunca exceção.
- Hooks nunca bloqueiam a CLI: endpoint responde `{}` com 200 em qualquer falha lógica; comando termina em `|| true`.
- Constantes nomeadas, valores exatos da spec: `TIE_MARGIN = 8`, `DELEGATE_MIN_PROMPT_CHARS = 40`, `DELEGATE_MIN_CONFIDENCE = 0.6`, `DELEGATE_TIMEOUT_MS = 2_500`, doutrina ≤ 1 536 bytes, texto injetado ≤ 400 caracteres.
- Texto voltado ao operador em pt-BR; identificadores em inglês, como o resto do código.
- Commits: `git add` por arquivo (nunca `-A`/`.`), mensagem `<tipo>(<escopo>): <descrição>` em pt-BR, sem linha de co-autoria.
- `src/main/orch/` e `src/main/pty/` são fronteira sensível (`AGENTS.md`): nenhuma tarefa amplia autoridade de pane; as novas regras só recusam.
- Cada arquivo de código tem teste irmão `.test.ts`; rode o teste do arquivo depois de editar.

## Review Focus

1. **Segredo colado na mensagem** (operador cola uma `sk-ant-…` no pane) → o texto vai ao Jev pelo hook; esperado: `redactState` mascara antes de sair. Teste na Task 12.
2. **Mensagem gigante** (log de 200 KB colado) → corpo acima de 64 KB; esperado: 400, nenhuma chamada ao Jev, CLI segue. Teste na Task 13.
3. **Pai fechado antes do helper nascer** → `parentPaneId` não acha o pane; esperado: helper nasce onde nasce hoje, sem erro. Teste na Task 9.
4. **`resume` de pane estacionado** com o agente mandando `adapterId` de outra CLI → esperado: a CLI do pane retomado vence (senão a conversa não é copiada). Teste na Task 7.
5. **Writer delegado estacionado/encerrado** segurando a fila para sempre → esperado: só `spawning|busy|idle|unknown` bloqueia. Teste na Task 15.

---

## Estrutura de arquivos

**Novos**
- `src/shared/spawn-route.ts` — tipos `JevUnavailableReason`, `SpawnRouteInfo`, rótulos pt-BR.
- `src/main/orch/operator-spawn-route.ts` — funções puras do roteamento forçado (tarefa, args ignorados, contagem de uso por pai, `spawnRouteFrom`, `parentPaneIdFor`).
- `src/main/orch/delegated-writer-gate.ts` — `decideDelegatedWriterSpawn` + fatos dos panes delegados.
- `src/main/orch/operator-delegation-doctrine.ts` — doutrina e `operatorDelegationInstructions`.
- `src/main/jev/jev-delegation.ts` — superfície Jev `delegation`.
- `src/main/orch/hook-http.ts` — encanamento HTTP comum aos hooks (extraído do triage).
- `src/main/orch/hook-delegate-endpoint.ts` — `POST /hook/delegate`.
- `src/main/orch/hook-delegate-command.ts` — comando do hook `UserPromptSubmit`.
- `src/renderer/orch/jev-route-notice.ts` — toast uma vez por motivo.
- Testes irmãos de cada um.

**Modificados**
- `src/main/jev/jev-client.ts` (`onNoAnswer`), `src/main/orch/jev-task-routing.ts`, `src/main/orch/route-pipeline.ts`, `src/main/orch/task-router.ts`, `src/main/orch/route-log.ts`, `src/main/orch/tools-domain.ts`, `src/main/orch/tools-panes.ts`, `src/main/orch/tool-util.ts`, `src/main/orch/main-owned-pane-runtime.ts`, `src/main/orch/pane-registry.ts`, `src/shared/orch-types.ts`, `src/shared/surface-payload-types.ts`, `src/renderer/state/layout-store.ts`, `src/renderer/orch/orch-bridge.ts`, `src/renderer/components/PaneToolbar.tsx`, `src/main/orch/mcp-protocol.ts`, `src/main/jev/jev-autopilot.ts`, `src/shared/settings-types.ts`, `src/renderer/components/settings/ModuleSections.tsx`, `src/main/orch/hook-triage-endpoint.ts`, `src/main/orch/mcp-server.ts`, `src/main/orch/hook-status-config.ts`, `src/main/orch/pane-admission.ts`, `src/main/pty/pty-manager.ts`.

---

# Parte A — Jev roteia os spawns

### Task 1: `judge()` informa o motivo da falha

**Files:**
- Modify: `src/main/jev/jev-client.ts` (interface `JudgeInput` ~linha 171; bloco de falha no fim de `judge`, ~linha 318)
- Test: `src/main/jev/jev-client.test.ts`

**Interfaces:**
- Produces: `JudgeInput.onNoAnswer?: (reason: JevNoAnswerReason) => void` — chamado uma vez quando a consulta termina sem resposta (mesmo ponto do `recordJevNoAnswer`), com ou sem `surface`. Não é chamado sem chave (retorno antecipado) nem no sucesso. Retorno de `judge` continua `JevResult | null`.

- [ ] **Step 1: Write the failing test** — acrescente ao `describe('judge — registro central de consultas sem resposta', …)`:

```ts
  it('onNoAnswer recebe o motivo categórico, com ou sem surface', async () => {
    const onNoAnswer = vi.fn();
    const mockFetch = vi.fn(async () => jsonResponse(500, { message: 'oops' }));
    const result = await judge(
      { state: 'x', questions: { q: question }, onNoAnswer },
      { fetch: mockFetch as unknown as typeof fetch, resolveKey: () => 'k' },
    );
    expect(result).toBeNull();
    expect(onNoAnswer).toHaveBeenCalledTimes(1);
    expect(onNoAnswer).toHaveBeenCalledWith('server-error');
  });

  it('onNoAnswer não é chamado no sucesso nem sem chave', async () => {
    const onNoAnswer = vi.fn();
    const ok = vi.fn(async () => jsonResponse(200, okBody));
    await judge(
      { state: 'x', questions: { q: question }, onNoAnswer },
      { fetch: ok as unknown as typeof fetch, resolveKey: () => 'k' },
    );
    await judge(
      { state: 'x', questions: { q: question }, onNoAnswer },
      { fetch: ok as unknown as typeof fetch, resolveKey: () => undefined },
    );
    expect(onNoAnswer).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/jev/jev-client.test.ts -t onNoAnswer`
Expected: FAIL — TS reclama de `onNoAnswer` desconhecido em `JudgeInput` ou o mock não é chamado.

- [ ] **Step 3: Write minimal implementation**

Em `JudgeInput`, depois de `missionId?: string;`:

```ts
  /**
   * Chamado uma vez quando a consulta termina sem resposta, com o motivo
   * categórico (o mesmo que vai ao diário). Permite à superfície dizer POR QUE
   * caiu no caminho determinístico sem mudar o retorno `null`.
   */
  onNoAnswer?: (reason: JevNoAnswerReason) => void;
```

No fim de `judge`, logo depois de `stats.failures += 1;`:

```ts
  try {
    input.onNoAnswer?.(lastReason);
  } catch {
    // callback do chamador nunca derruba o contrato fail-open
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/jev/jev-client.test.ts`
Expected: PASS (todos os testes do arquivo).

- [ ] **Step 5: Commit**

```bash
git add src/main/jev/jev-client.ts src/main/jev/jev-client.test.ts
git commit -m "feat(jev): judge informa o motivo da consulta sem resposta"
```

---

### Task 2: classificação de rota devolve o motivo quando o Jev não responde

**Files:**
- Create: `src/shared/spawn-route.ts`, `src/shared/spawn-route.test.ts`
- Modify: `src/main/orch/jev-task-routing.ts` (função `classifyTaskWithJev`, ~linha 116)
- Test: `src/main/orch/jev-task-routing.test.ts`

**Interfaces:**
- Consumes: `JudgeInput.onNoAnswer` (Task 1).
- Produces (shared):
  ```ts
  export type JevUnavailableReason = 'disabled' | 'no-key' | 'invalid-answer' | 'timeout' | 'rate-limited' | 'client-error' | 'server-error' | 'network' | 'malformed' | 'aborted';
  export type SpawnRouteSource = 'jev' | 'mixed' | 'heuristic';
  export interface SpawnRouteInfo { readonly source: SpawnRouteSource; readonly jevUnavailable?: JevUnavailableReason }
  export const JEV_UNAVAILABLE_LABEL: Readonly<Record<JevUnavailableReason, string>>;
  export function isJevUnavailableReason(value: unknown): value is JevUnavailableReason;
  ```
- Produces (main):
  ```ts
  export type JevTaskRoutingResult =
    | { readonly kind: 'classified'; readonly classification: JevTaskClassification }
    | { readonly kind: 'unavailable'; readonly reason: JevUnavailableReason }
    | { readonly kind: 'skipped' }; // tarefa em branco: nada a classificar, sem aviso
  export async function classifyTaskForRouting(task: string, deps?: ClassifyTaskDeps): Promise<JevTaskRoutingResult>;
  ```
  `classifyTaskWithJev` continua existindo com o mesmo contrato (`JevTaskClassification | null`), agora como embrulho — os testes atuais seguem valendo. (Ajuste consciente sobre a spec, que dizia "passa a devolver": o embrulho evita quebrar os chamadores e testes existentes.)

- [ ] **Step 1: Write the failing tests**

`src/shared/spawn-route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { JEV_UNAVAILABLE_LABEL, isJevUnavailableReason } from './spawn-route';

describe('spawn-route', () => {
  it('reconhece só motivos conhecidos', () => {
    expect(isJevUnavailableReason('no-key')).toBe(true);
    expect(isJevUnavailableReason('timeout')).toBe(true);
    expect(isJevUnavailableReason('whatever')).toBe(false);
    expect(isJevUnavailableReason(undefined)).toBe(false);
  });

  it('tem rótulo pt-BR para todo motivo', () => {
    expect(JEV_UNAVAILABLE_LABEL['no-key']).toBe('sem chave');
    for (const label of Object.values(JEV_UNAVAILABLE_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
```

Em `src/main/orch/jev-task-routing.test.ts`, troque o import para incluir `classifyTaskForRouting` e acrescente:

```ts
describe('classifyTaskForRouting', () => {
  it('classified quando o Jev responde', async () => {
    const judge = vi.fn<JudgeMock>(async () => answer('hard', 0.8, 'bug', 0.7));
    const out = await classifyTaskForRouting('corrigir race', { judge });
    expect(out).toMatchObject({ kind: 'classified', classification: { tier: 'hard' } });
  });

  it('unavailable com o motivo: desligado, sem chave, resposta inválida e falha do judge', async () => {
    const judge = vi.fn<JudgeMock>(async () => answer('easy', 0.9, 'doc', 0.9));
    expect(await classifyTaskForRouting('x', { judge, enabled: () => false })).toEqual({
      kind: 'unavailable',
      reason: 'disabled',
    });
    expect(await classifyTaskForRouting('x', { judge, hasKey: () => false })).toEqual({
      kind: 'unavailable',
      reason: 'no-key',
    });
    expect(
      await classifyTaskForRouting('x', {
        judge: vi.fn<JudgeMock>(async () => answer('galactic', 0.9, 'bug', 0.9)),
      }),
    ).toEqual({ kind: 'unavailable', reason: 'invalid-answer' });
    const timingOut = vi.fn<JudgeMock>(async (input) => {
      input.onNoAnswer?.('timeout');
      return null;
    });
    expect(await classifyTaskForRouting('x', { judge: timingOut })).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    });
  });

  it('judge null sem callback vira network; tarefa em branco é skipped', async () => {
    expect(
      await classifyTaskForRouting('x', { judge: vi.fn<JudgeMock>(async () => null) }),
    ).toEqual({ kind: 'unavailable', reason: 'network' });
    expect(await classifyTaskForRouting('   ', {})).toEqual({ kind: 'skipped' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/spawn-route.test.ts src/main/orch/jev-task-routing.test.ts`
Expected: FAIL — módulo `./spawn-route` inexistente e `classifyTaskForRouting` não exportado.

- [ ] **Step 3: Write minimal implementation**

`src/shared/spawn-route.ts`:

```ts
/**
 * Origem da rota de um pane aberto por agente do operador (A, 25/09) — o que
 * o recibo, o chip do cabeçalho e o toast dizem quando o Jev não respondeu.
 * Vive em shared porque Main produz e renderer exibe.
 */
export type JevUnavailableReason =
  | 'disabled'
  | 'no-key'
  | 'invalid-answer'
  | 'timeout'
  | 'rate-limited'
  | 'client-error'
  | 'server-error'
  | 'network'
  | 'malformed'
  | 'aborted';

export type SpawnRouteSource = 'jev' | 'mixed' | 'heuristic';

export interface SpawnRouteInfo {
  readonly source: SpawnRouteSource;
  readonly jevUnavailable?: JevUnavailableReason;
}

export const JEV_UNAVAILABLE_LABEL: Readonly<Record<JevUnavailableReason, string>> = {
  disabled: 'desligado nas Configurações',
  'no-key': 'sem chave',
  'invalid-answer': 'resposta inválida',
  timeout: 'tempo esgotado',
  'rate-limited': 'limite de uso',
  'client-error': 'requisição recusada',
  'server-error': 'serviço fora',
  network: 'sem rede',
  malformed: 'resposta malformada',
  aborted: 'cancelado',
};

export function isJevUnavailableReason(value: unknown): value is JevUnavailableReason {
  return typeof value === 'string' && Object.hasOwn(JEV_UNAVAILABLE_LABEL, value);
}
```

Em `src/main/orch/jev-task-routing.ts`, adicione o import `import type { JevUnavailableReason } from '../../shared/spawn-route';` e substitua `classifyTaskWithJev` por:

```ts
export type JevTaskRoutingResult =
  | { readonly kind: 'classified'; readonly classification: JevTaskClassification }
  | { readonly kind: 'unavailable'; readonly reason: JevUnavailableReason }
  | { readonly kind: 'skipped' };

/**
 * Classificação para o roteador COM o motivo quando o Jev não respondeu — o
 * spawn da mão do operador mostra "sem Jev: <motivo>" em vez de cair calado na
 * heurística. `skipped` = tarefa em branco, nada a julgar e nada a avisar.
 */
export async function classifyTaskForRouting(
  task: string,
  deps: ClassifyTaskDeps = {},
): Promise<JevTaskRoutingResult> {
  if (!task.trim()) return { kind: 'skipped' };
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('taskRouting'));
  const hasKey = deps.hasKey ?? hasJevCredential;
  if (!enabled()) return { kind: 'unavailable', reason: 'disabled' };
  if (!hasKey()) return { kind: 'unavailable', reason: 'no-key' };

  let noAnswer: JevUnavailableReason | undefined;
  const judgeFn = deps.judge ?? judge;
  const result = await judgeFn({
    state: { task: capText(task, TASK_MAX_CHARS) },
    questions: TASK_ROUTING_QUESTIONS,
    timeoutMs: TASK_ROUTING_TIMEOUT_MS,
    surface: 'taskRouting',
    onNoAnswer: (reason) => {
      noAnswer = reason;
    },
  });
  if (!result) return { kind: 'unavailable', reason: noAnswer ?? 'network' };

  const tierAnswer = result.answers.tier;
  const specialtyAnswer = result.answers.specialty;
  const escalateAnswer = result.answers.escalate;
  if (
    tierAnswer?.type !== 'choice' ||
    specialtyAnswer?.type !== 'choice' ||
    !isTier(tierAnswer.choice) ||
    !isSpecialty(specialtyAnswer.choice)
  ) {
    return { kind: 'unavailable', reason: 'invalid-answer' };
  }

  const classification: JevTaskClassification = {
    tier: tierAnswer.choice,
    tierConfidence: tierAnswer.confidence,
    specialty: specialtyAnswer.choice,
    specialtyConfidence: specialtyAnswer.confidence,
    escalate: escalateAnswer?.type === 'noul' ? escalateAnswer.noul : 0,
    model: result.model,
  };
  recordJevDecision({
    surface: 'taskRouting',
    model: result.model,
    questions: Object.keys(TASK_ROUTING_QUESTIONS),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: `tier:${classification.tier}/${classification.specialty}`,
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });
  return { kind: 'classified', classification };
}

/** Contrato antigo (classificação ou null) — mantido para os chamadores atuais. */
export async function classifyTaskWithJev(
  task: string,
  deps: ClassifyTaskDeps = {},
): Promise<JevTaskClassification | null> {
  const result = await classifyTaskForRouting(task, deps);
  return result.kind === 'classified' ? result.classification : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/spawn-route.test.ts src/main/orch/jev-task-routing.test.ts src/main/orch/task-router-mimo.test.ts`
Expected: PASS (inclusive os testes antigos de `classifyTaskWithJev`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/spawn-route.ts src/shared/spawn-route.test.ts src/main/orch/jev-task-routing.ts src/main/orch/jev-task-routing.test.ts
git commit -m "feat(rota): classificação Jev diz por que não respondeu"
```

---

### Task 3: desempate por uso (`tieBreakByUse`)

**Files:**
- Modify: `src/main/orch/route-pipeline.ts` (depois de `multiScoreRerank`)
- Test: `src/main/orch/route-pipeline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TIE_MARGIN = 8;
  export interface TieBreakInput {
    readonly ranked: RankedRouteEntry[];
    readonly useCounts: ReadonlyMap<string, number>;
    readonly tier: TaskTier;
    readonly modelCatalog: ModelCatalog;
    readonly context?: RouteContext;
    readonly circuitOpen?: MultiScoreInput['circuitOpen'];
    readonly margin?: number;
  }
  export function tieBreakByUse(input: TieBreakInput): { ranked: RankedRouteEntry[]; note: string };
  ```
  Nunca promove candidato abaixo de `total(ranked[0]) − margin`; sem mudança devolve o MESMO array e `note: ''`.

- [ ] **Step 1: Write the failing test** — acrescente a `src/main/orch/route-pipeline.test.ts` (inclua `tieBreakByUse, TIE_MARGIN` no import de `./route-pipeline` e `import type { ModelCatalog } from '../adapters/model-catalog';`):

```ts
describe('tieBreakByUse', () => {
  // Catálogo vazio: qualidade e custo iguais para todos, então o total só
  // difere pela posição na tabela (60, 56, 52, 48…).
  const flat = { adapters: {} } as ModelCatalog;
  const ranked = [entry('grok'), entry('agy'), entry('kimi'), entry('codex')];
  const run = (counts: Record<string, number>) =>
    tieBreakByUse({
      ranked,
      useCounts: new Map(Object.entries(counts)),
      tier: 'medium',
      modelCatalog: flat,
    });

  it('dentro da margem vence a CLI menos usada', () => {
    const out = run({ grok: 1 });
    expect(out.ranked[0]!.c.adapterId).toBe('agy');
    expect(out.note).toContain('desempate');
  });

  it('pula para o terceiro quando o segundo também já está aberto', () => {
    expect(run({ grok: 1, agy: 1 }).ranked[0]!.c.adapterId).toBe('kimi');
  });

  it('fora da margem o melhor vence mesmo repetindo', () => {
    // codex está a 12 pontos do topo (> TIE_MARGIN = 8).
    expect(TIE_MARGIN).toBe(8);
    const out = run({ grok: 1, agy: 1, kimi: 1 });
    expect(out.ranked[0]!.c.adapterId).toBe('grok');
    expect(out.note).toBe('');
  });

  it('sem contagem ou topo ainda não usado: ordem intacta, mesmo array', () => {
    expect(run({}).ranked).toBe(ranked);
    expect(run({ agy: 2 }).ranked).toBe(ranked);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/orch/route-pipeline.test.ts -t tieBreakByUse`
Expected: FAIL — `tieBreakByUse` não exportado.

- [ ] **Step 3: Write minimal implementation** — em `route-pipeline.ts`, importe `RouteContext` junto de `RankedRouteEntry`/`TaskTier` (`import type { RankedRouteEntry, RouteContext, TaskTier } from './task-router';` — já importa os dois primeiros) e adicione depois de `multiScoreRerank`:

```ts
/**
 * Faixa de empate do desempate por uso (spawn da mão do operador, 25/09):
 * ~2 posições da tabela, que desce 4 pontos por posição.
 */
export const TIE_MARGIN = 8;

export interface TieBreakInput {
  readonly ranked: RankedRouteEntry[];
  /** CLI → quantos panes do mesmo agente pai (e ele próprio) já a usam. */
  readonly useCounts: ReadonlyMap<string, number>;
  readonly tier: TaskTier;
  readonly modelCatalog: ModelCatalog;
  readonly context?: RouteContext;
  readonly circuitOpen?: MultiScoreInput['circuitOpen'];
  readonly margin?: number;
}

/**
 * "Melhor por tarefa, espalha no empate": entre os candidatos a até `margin`
 * pontos do topo, vence o menos usado; fora da faixa ninguém sobe. Diferente
 * da atenuação de missão (−18 por uso), nunca troca um vencedor claro.
 */
export function tieBreakByUse(input: TieBreakInput): {
  ranked: RankedRouteEntry[];
  note: string;
} {
  if (input.ranked.length < 2 || input.useCounts.size === 0) {
    return { ranked: input.ranked, note: '' };
  }
  const margin = input.margin ?? TIE_MARGIN;
  const scoreInput: Omit<MultiScoreInput, 'ranked'> = {
    tier: input.tier,
    modelCatalog: input.modelCatalog,
    circuitOpen: input.circuitOpen,
    // Sem histórico de missão: o total aqui é "qualidade da escolha", não
    // diversidade — a diversidade é justamente o que este passo decide.
    context: input.context
      ? { ...input.context, missionUsedAdapters: undefined, missionUseCounts: undefined }
      : undefined,
  };
  const totals = input.ranked.map(
    (candidate, index) => scoreRouteCandidate(candidate, index, scoreInput).total,
  );
  const floor = totals[0]! - margin;
  const uses = (adapterId: string): number => input.useCounts.get(adapterId) ?? 0;
  let best = 0;
  for (let index = 1; index < input.ranked.length; index += 1) {
    if (totals[index]! < floor) continue;
    if (uses(input.ranked[index]!.c.adapterId) < uses(input.ranked[best]!.c.adapterId)) {
      best = index;
    }
  }
  if (best === 0) return { ranked: input.ranked, note: '' };
  const head = input.ranked[0]!;
  const chosen = input.ranked[best]!;
  return {
    ranked: [chosen, ...input.ranked.filter((_, index) => index !== best)],
    note:
      `; desempate: ${chosen.c.adapterId} (${uses(chosen.c.adapterId)} aberto(s)) ` +
      `no lugar de ${head.c.adapterId} (${uses(head.c.adapterId)} aberto(s))`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/orch/route-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orch/route-pipeline.ts src/main/orch/route-pipeline.test.ts
git commit -m "feat(rota): desempate por uso que nunca troca vencedor claro"
```

---

### Task 4: `routeTask` aplica o desempate quando recebe contagens

**Files:**
- Modify: `src/main/orch/task-router.ts` (`RouteContext` ~linha 61; bloco multi-score ~linha 620; montagem do `reason` ~linha 679)
- Test: `src/main/orch/task-router.test.ts`

**Interfaces:**
- Consumes: `tieBreakByUse`, `TIE_MARGIN` (Task 3).
- Produces: `RouteContext.tieBreakUseCounts?: ReadonlyMap<string, number>`. Sem o campo, `routeTask` devolve exatamente o de hoje.

- [ ] **Step 1: Write the failing test** — em `task-router.test.ts` (o arquivo já tem o helper `adapters(...installed)`; importe `DEFAULT_ROUTING_TABLE` de `./task-router` se ainda não estiver importado e `import type { ModelCatalog } from '../adapters/model-catalog';`):

```ts
describe('routeTask — desempate por uso (tieBreakUseCounts)', () => {
  const flat = { adapters: {} } as ModelCatalog;
  const installed = adapters('grok', 'agy', 'kimi', 'codex', 'claude');

  it('sem contagens a decisão é idêntica à de hoje', () => {
    const base = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE, 'trivial', false, flat, {});
    const same = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE, 'trivial', false, flat, {
      tieBreakUseCounts: new Map(),
    });
    expect(same).toEqual(base);
  });

  it('com o topo já aberto, a alternativa dentro da margem vence e o motivo diz', () => {
    const base = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE, 'trivial', false, flat, {})!;
    const runnerUp = base.alternatives.find((alt) => alt.adapterId !== base.adapterId)!;
    const tie = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE, 'trivial', false, flat, {
      tieBreakUseCounts: new Map([[base.adapterId, 1]]),
    })!;
    expect(tie.adapterId).toBe(runnerUp.adapterId);
    expect(tie.reason).toContain('desempate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/orch/task-router.test.ts -t tieBreakUseCounts`
Expected: FAIL — o segundo teste escolhe o topo (campo ignorado) e TS reclama do campo desconhecido.

- [ ] **Step 3: Write minimal implementation**

Em `RouteContext`, depois de `specialtyOverride`:

```ts
  /**
   * Spawn da mão do operador (25/09): CLIs já abertas pelo mesmo agente pai.
   * Só desempata dentro de TIE_MARGIN (route-pipeline.tieBreakByUse); ausente
   * = decisão de hoje. Nunca vem de argumento MCP.
   */
  tieBreakUseCounts?: ReadonlyMap<string, number>;
```

Troque o import `import { multiScoreRerank } from './route-pipeline';` por `import { multiScoreRerank, tieBreakByUse } from './route-pipeline';`.

Logo depois do bloco `if (runMultiScore && ranked.length > 1) { … }`:

```ts
  let tieBreakNote = '';
  if (context.tieBreakUseCounts && ranked.length > 1) {
    const tie = tieBreakByUse({
      ranked,
      useCounts: context.tieBreakUseCounts,
      tier,
      modelCatalog,
      context,
      circuitOpen: (id) => adapterCircuitBreakers.isOpen(id),
    });
    ranked = tie.ranked;
    tieBreakNote = tie.note;
  }
```

No `reason` do retorno, acrescente `${tieBreakNote}` logo depois de `${multiScoreNote}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/task-router.test.ts src/main/orch/task-router-matrix.test.ts src/main/orch/task-router-quality.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orch/task-router.ts src/main/orch/task-router.test.ts
git commit -m "feat(rota): routeTask desempata por uso quando o spawn pede"
```

---

### Task 5: route log registra origem da classificação e motivo da queda

**Files:**
- Modify: `src/main/orch/route-log.ts`
- Test: `src/main/orch/route-log.test.ts`

**Interfaces:**
- Produces: `RouteLogInput`/`RouteLogEntry` ganham `classifierSource?: string` e `jevUnavailable?: string` (opcionais — chamadores atuais não mudam).

- [ ] **Step 1: Write the failing test**

```ts
  it('guarda classifierSource e jevUnavailable quando informados', () => {
    clearRouteLog();
    recordRouteLog({
      task: 't',
      tier: 'medium',
      adapterId: 'codex',
      reason: 'r',
      classifierSource: 'heuristic',
      jevUnavailable: 'no-key',
    });
    expect(recentRouteLog()[0]).toMatchObject({
      classifierSource: 'heuristic',
      jevUnavailable: 'no-key',
    });
  });
```

(Garanta `clearRouteLog, recordRouteLog, recentRouteLog` no import do teste.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/orch/route-log.test.ts`
Expected: FAIL — campos ausentes na entrada.

- [ ] **Step 3: Write minimal implementation** — nas duas interfaces, depois de `reason: string;`:

```ts
  /** jev | mixed | heuristic — de onde veio tier/especialidade. */
  classifierSource?: string;
  /** Motivo da queda para a heurística quando o Jev não respondeu. */
  jevUnavailable?: string;
```

Em `recordRouteLog`, no objeto `entry`, depois de `reason: input.reason,`:

```ts
    ...(input.classifierSource ? { classifierSource: input.classifierSource } : {}),
    ...(input.jevUnavailable ? { jevUnavailable: input.jevUnavailable } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/orch/route-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orch/route-log.ts src/main/orch/route-log.test.ts
git commit -m "feat(rota): route log mostra se a escolha veio do Jev"
```

---

### Task 6: `nexus_route_task` expõe `jevUnavailable` e aceita contagens internas

**Files:**
- Modify: `src/main/orch/tools-domain.ts` (`routeTaskTool` ~linha 1410; `setOperatorRouteResolver` ~linha 1709)
- Modify: `src/main/orch/tools-panes.ts` (tipo `OperatorRouteResolver` ~linha 369)
- Test: `src/main/orch/route-tools.test.ts`

**Interfaces:**
- Consumes: `classifyTaskForRouting` (Task 2), `RouteContext.tieBreakUseCounts` (Task 4), campos do route log (Task 5).
- Produces (tools-panes):
  ```ts
  export interface OperatorRouteInternal { readonly tieBreakUseCounts?: ReadonlyMap<string, number> }
  export type OperatorRouteResolver = (task: string, ctx: AgentGateContext, internal: OperatorRouteInternal) => Promise<Record<string, unknown>>;
  ```
- Produces (tools-domain): `export async function routeTaskForCaller(args: Record<string, unknown>, ctx: AgentGateContext, internal?: OperatorRouteInternal): Promise<Record<string, unknown>>` — o corpo atual do handler. Resultado ganha `jevUnavailable?: JevUnavailableReason`.

- [ ] **Step 1: Write the failing test** — em `route-tools.test.ts`, adicione ao `vi.hoisted`: `classifyTaskForRouting: vi.fn(async (): Promise<unknown> => ({ kind: 'skipped' })),` e o mock:

```ts
vi.mock('./jev-task-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-task-routing')>()),
  classifyTaskForRouting: mocks.classifyTaskForRouting,
}));
```

No `beforeEach`: `mocks.classifyTaskForRouting.mockReset(); mocks.classifyTaskForRouting.mockResolvedValue({ kind: 'skipped' });`. Importe `routeTaskForCaller` de `./tools-domain`. Testes:

```ts
describe('nexus_route_task — Jev fora e desempate interno', () => {
  const providers = [
    { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
  ];

  it('devolve jevUnavailable e grava origem + motivo no route log', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    mocks.classifyTaskForRouting.mockResolvedValue({ kind: 'unavailable', reason: 'timeout' });
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa média' },
      context(),
    )) as Record<string, unknown>;
    expect(decision.jevUnavailable).toBe('timeout');
    expect(decision.classifierSource).toBe('heuristic');
    expect(recentRouteLog()[0]).toMatchObject({
      classifierSource: 'heuristic',
      jevUnavailable: 'timeout',
    });
  });

  it('Jev respondeu: sem jevUnavailable', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    mocks.classifyTaskForRouting.mockResolvedValue({
      kind: 'classified',
      classification: {
        tier: 'medium', tierConfidence: 0.9, specialty: 'feature',
        specialtyConfidence: 0.9, escalate: 0.1, model: 'jev-test',
      },
    });
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa média' },
      context(),
    )) as Record<string, unknown>;
    expect(decision.jevUnavailable).toBeUndefined();
    expect(decision.classifierSource).toBe('jev');
  });

  it('argumento MCP não injeta contagens; parâmetro interno sim', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    const base = (await routeTaskForCaller({ task: 'tarefa média' }, context())) as {
      adapterId: string;
      alternatives: Array<{ adapterId: string }>;
    };
    const spoofed = (await tool('nexus_route_task').handler(
      { task: 'tarefa média', tieBreakUseCounts: { [base.adapterId]: 9 } },
      context(),
    )) as { adapterId: string };
    expect(spoofed.adapterId).toBe(base.adapterId);
    const internal = (await routeTaskForCaller({ task: 'tarefa média' }, context(), {
      tieBreakUseCounts: new Map([[base.adapterId, 1]]),
    })) as { adapterId: string; reason: string };
    // Pode ou não trocar (depende da margem real do catálogo); se trocar, o
    // motivo tem que dizer. Nunca pode escolher algo fora das alternativas.
    if (internal.adapterId !== base.adapterId) {
      expect(internal.reason).toContain('desempate');
      expect(base.alternatives.map((alt) => alt.adapterId)).toContain(internal.adapterId);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/orch/route-tools.test.ts`
Expected: FAIL — `routeTaskForCaller` não exportado; `jevUnavailable` ausente.

- [ ] **Step 3: Write minimal implementation**

Em `tools-panes.ts`, troque o tipo do resolver:

```ts
/** Parâmetros internos do roteamento do spawn — nunca vêm de argumento MCP. */
export interface OperatorRouteInternal {
  readonly tieBreakUseCounts?: ReadonlyMap<string, number>;
}

export type OperatorRouteResolver = (
  task: string,
  ctx: AgentGateContext,
  internal: OperatorRouteInternal,
) => Promise<Record<string, unknown>>;
```

Em `tools-domain.ts`:
1. Imports: troque `classifyTaskWithJev,` por `classifyTaskForRouting,` e adicione `type JevTaskRoutingResult,` no mesmo import de `./jev-task-routing`; adicione `type OperatorRouteInternal` ao import que já traz `setOperatorRouteResolver` de `./tools-panes`.
2. Mova o corpo inteiro do `handler: async (args, ctx) => { … }` de `routeTaskTool` para uma função exportada declarada ANTES de `const routeTaskTool`:

```ts
/**
 * Corpo do nexus_route_task. `internal` só é preenchido pelo resolver do spawn
 * da mão do operador (contagens de uso para o desempate) — o handler MCP nunca
 * repassa argumentos para cá.
 */
export async function routeTaskForCaller(
  args: Record<string, unknown>,
  ctx: AgentGateContext,
  internal: OperatorRouteInternal = {},
): Promise<Record<string, unknown>> {
  // … corpo movido verbatim, com as 4 mudanças abaixo …
}
```

   e o handler vira `handler: (args, ctx) => routeTaskForCaller(args, ctx),`.
3. Mudança 1 — troque o bloco da classificação Jev (`let jevClassification … catch { console.warn(…) }`) por:

```ts
    let jevRouting: JevTaskRoutingResult = { kind: 'skipped' };
    try {
      jevRouting = await classifyTaskForRouting(task);
    } catch (error) {
      console.warn('[route_task] classificação Jev falhou (ignorada):', error);
      jevRouting = { kind: 'unavailable', reason: 'network' };
    }
    const jevClassification =
      jevRouting.kind === 'classified' ? jevRouting.classification : null;
    const jevUnavailable =
      jevRouting.kind === 'unavailable' ? jevRouting.reason : undefined;
```

4. Mudança 2 — no objeto de contexto do `routeTask(…)`, depois de `specialtyOverride: routing.specialtyOverride,`:

```ts
        ...(internal.tieBreakUseCounts
          ? { tieBreakUseCounts: internal.tieBreakUseCounts }
          : {}),
```

5. Mudança 3 — no `recordRouteLog({ … })`, depois de `reason: decision.reason,`:

```ts
      classifierSource: routing.classifierSource,
      ...(jevUnavailable ? { jevUnavailable } : {}),
```

6. Mudança 4 — no `const provenance = { … }`, acrescente `...(jevUnavailable ? { jevUnavailable } : {}),`.
7. Troque o registro do resolver:

```ts
setOperatorRouteResolver((task, ctx, internal) =>
  routeTaskForCaller({ task }, ctx, internal),
);
```

   (Se `tools-domain.ts` ainda não importa `AgentGateContext`, adicione `import type { AgentGateContext } from './gate';`.)
8. Em `tools-panes.ts`, a chamada atual do resolver (`autoRoute = await operatorRouteResolver(task, ctx);`, ramo ad-hoc) passa o novo parâmetro obrigatório: `autoRoute = await operatorRouteResolver(task, ctx, {});`. A Task 7 substitui esse trecho inteiro.
9. Em `tools-panes-operator-child.test.ts`, o teste `'sem adapterId roteia task/prompt pelo resolver do operador'` passa a esperar 3 argumentos:

```ts
    expect(resolver).toHaveBeenCalledWith('implemente X', ctx, expect.any(Object));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/route-tools.test.ts src/main/orch/route-tools-reservation.test.ts src/main/orch/tools-panes-operator-child.test.ts && npx tsc --noEmit`
Expected: PASS e typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/main/orch/tools-domain.ts src/main/orch/tools-panes.ts src/main/orch/route-tools.test.ts src/main/orch/tools-panes-operator-child.test.ts
git commit -m "feat(rota): route_task diz quando o Jev caiu e aceita desempate interno"
```

---

### Task 7: spawn da mão do operador sempre roteado

**Files:**
- Create: `src/main/orch/operator-spawn-route.ts`, `src/main/orch/operator-spawn-route.test.ts`
- Modify: `src/main/orch/tools-panes.ts` (handler do `paneSpawnTool`: ramo `agentRef` ~linha 545–625, ramo ad-hoc ~linha 625–750, recibo ~linha 1112; descrição e schema ~linha 426–452)
- Modify: `src/main/orch/tool-util.ts` (`SpawnToolOptions` ~linha 1000)
- Test: `src/main/orch/tools-panes-operator-child.test.ts`

**Interfaces:**
- Consumes: `OperatorRouteResolver` com `internal` (Task 6), `SpawnRouteInfo`/`isJevUnavailableReason` (Task 2).
- Produces (`operator-spawn-route.ts`):
  ```ts
  export function operatorRouteTask(args: Record<string, unknown>): string | null;
  export function ignoredRouteChoice(args: Record<string, unknown>): { adapterId?: string; model?: string; effort?: string } | null;
  export interface UseCountPane { readonly sessionId: string | null; readonly adapterId?: string; readonly state: PaneRuntimeState }
  export function operatorChildUseCounts(parentSessionId: string | undefined, parentAdapterId: string | undefined, panes: readonly UseCountPane[], parentOf: (sessionId: string) => string | undefined): Map<string, number>;
  export function spawnRouteFrom(route: Record<string, unknown> | undefined): SpawnRouteInfo | undefined;
  export function routeString(route: Record<string, unknown> | undefined, key: 'adapterId' | 'model' | 'effort'): string | undefined;
  ```
- Produces: `SpawnToolOptions.spawnRoute?: SpawnRouteInfo` (lido pela Task 8).

- [ ] **Step 1: Write the failing tests**

`src/main/orch/operator-spawn-route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ignoredRouteChoice,
  operatorChildUseCounts,
  operatorRouteTask,
  routeString,
  spawnRouteFrom,
} from './operator-spawn-route';

describe('operator-spawn-route', () => {
  it('tarefa vem de task, depois prompt, depois title', () => {
    expect(operatorRouteTask({ task: 'a', prompt: 'b', title: 'c' })).toBe('a');
    expect(operatorRouteTask({ prompt: 'b', title: 'c' })).toBe('b');
    expect(operatorRouteTask({ title: 'c' })).toBe('c');
    expect(operatorRouteTask({ task: '   ' })).toBeNull();
  });

  it('lista só o que o agente mandou e será ignorado', () => {
    expect(ignoredRouteChoice({ adapterId: 'claude', effort: 'high' })).toEqual({
      adapterId: 'claude',
      effort: 'high',
    });
    expect(ignoredRouteChoice({ task: 'x' })).toBeNull();
  });

  it('conta a CLI do pai e dos filhos vivos dele, nunca de outro pai', () => {
    const parentOf = (sid: string) =>
      ({ c1: 'parent', c2: 'parent', c3: 'parent', other: 'someone' })[sid];
    const counts = operatorChildUseCounts('parent', 'claude', [
      { sessionId: 'c1', adapterId: 'claude', state: 'busy' },
      { sessionId: 'c2', adapterId: 'codex', state: 'idle' },
      { sessionId: 'c3', adapterId: 'kimi', state: 'exited' },
      { sessionId: 'other', adapterId: 'grok', state: 'busy' },
    ], parentOf);
    expect(Object.fromEntries(counts)).toEqual({ claude: 2, codex: 1 });
  });

  it('sem sessão do pai não há contagem', () => {
    expect(operatorChildUseCounts(undefined, 'claude', [], () => undefined).size).toBe(0);
  });

  it('spawnRouteFrom normaliza origem e motivo', () => {
    expect(spawnRouteFrom(undefined)).toBeUndefined();
    expect(spawnRouteFrom({ classifierSource: 'jev' })).toEqual({ source: 'jev' });
    expect(spawnRouteFrom({ classifierSource: 'heuristic', jevUnavailable: 'no-key' })).toEqual({
      source: 'heuristic',
      jevUnavailable: 'no-key',
    });
    expect(spawnRouteFrom({ classifierSource: 'lol', jevUnavailable: 'lol' })).toEqual({
      source: 'heuristic',
    });
  });

  it('routeString só aceita string não vazia', () => {
    expect(routeString({ model: 'm' }, 'model')).toBe('m');
    expect(routeString({ model: '' }, 'model')).toBeUndefined();
    expect(routeString(undefined, 'model')).toBeUndefined();
  });
});
```

Em `src/main/orch/tools-panes-operator-child.test.ts`:
1. Troque o `vi.mock('./pane-registry', …)` por uma versão que também controla os panes vivos e a busca de pane:

```ts
vi.mock('./pane-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-registry')>()),
  takePendingPaneSpawnResult: harness.takePendingPaneSpawnResult,
  listPaneSnapshots: vi.fn(() => harness.snapshots),
  getPaneRuntimeAuthorityBySession: vi.fn((sessionId: string) =>
    harness.parentBySession[sessionId]
      ? { operatorParentSessionId: harness.parentBySession[sessionId] }
      : null,
  ),
  findPane: vi.fn((ref: string) => harness.panesByRef[ref] ?? null),
}));
```

   e adicione ao `vi.hoisted`: `snapshots: [] as Array<Record<string, unknown>>, parentBySession: {} as Record<string, string>, panesByRef: {} as Record<string, { paneId: string; adapterId?: string }>,`. No `beforeEach`, zere os três (`harness.snapshots = []; harness.parentBySession = {}; harness.panesByRef = {};`).
2. **Aperte** o teste existente `'sem adapterId roteia task/prompt pelo resolver do operador'` (a Task 6 deixou `expect.any(Object)` no 3º argumento):

```ts
    expect(resolver).toHaveBeenCalledWith(
      'implemente X',
      ctx,
      expect.objectContaining({ tieBreakUseCounts: expect.any(Map) }),
    );
```

3. **Substitua** o teste `'com adapterId explícito o resolver não é chamado'` (o comportamento inverte por decisão do operador em 25/09) por:

```ts
  it('adapterId/model/effort do agente são ignorados: o resolver decide e o recibo diz', async () => {
    const resolver = vi.fn(async () => ({
      adapterId: 'kimi', model: 'kimi-code/k3', effort: 'low', classifierSource: 'jev',
    }));
    setOperatorRouteResolver(resolver);
    const result = (await paneSpawnTool.handler(
      { adapterId: 'claude', model: 'claude-opus-5-5', effort: 'high', prompt: 'revise X' },
      userPane(),
    )) as Record<string, unknown>;
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'kimi',
      model: 'kimi-code/k3',
      effort: 'low',
      spawnRoute: { source: 'jev' },
    });
    expect(result).toMatchObject({
      harness: { source: 'auto-route' },
      route: {
        ignored: { adapterId: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      },
    });
  });

  it('Jev fora: rota heurística com o motivo no recibo e nas opções do pane', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', classifierSource: 'heuristic', jevUnavailable: 'no-key',
    })));
    const result = (await paneSpawnTool.handler({ prompt: 'implemente X' }, userPane())) as Record<string, unknown>;
    expect(result).toMatchObject({ route: { jevUnavailable: 'no-key' } });
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({
      spawnRoute: { source: 'heuristic', jevUnavailable: 'no-key' },
    });
  });

  it('desempate recebe as CLIs do pai e dos filhos vivos dele', async () => {
    harness.snapshots = [
      { paneId: 'p1', sessionId: 'c1', adapterId: 'codex', state: 'busy', title: 'a', kind: 'cli-agent' },
    ];
    harness.parentBySession = { c1: 'session-user' };
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ prompt: 'x' }, userPane({ providerId: 'claude' }));
    const internal = (resolver.mock.calls[0] as unknown[])[2] as {
      tieBreakUseCounts: Map<string, number>;
    };
    expect(Object.fromEntries(internal.tieBreakUseCounts)).toEqual({ claude: 1, codex: 1 });
  });

  it('resume mantém a CLI do pane retomado e não roteia', async () => {
    harness.panesByRef = { 'pane-old': { paneId: 'pane-old', adapterId: 'codex' } };
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ resume: 'pane-old', adapterId: 'claude', prompt: 'ajuste' }, userPane());
    expect(resolver).not.toHaveBeenCalled();
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'codex',
      resumeFromPaneId: 'pane-old',
    });
  });

  it('sem task, prompt nem title o spawn roteado pede a tarefa', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'kimi' })));
    await expect(paneSpawnTool.handler({ adapterId: 'claude' }, userPane())).rejects.toThrow(/task/);
    expect(harness.spawnPaneAndMaybePrompt).not.toHaveBeenCalled();
  });
```

   E, no mesmo arquivo, o caso `agentName` da mão do operador. `Executor` é agente do roster embutido (o mesmo que `tools-panes-user-spawn.test.ts` usa sem mock), então o store real resolve:

```ts
  it('agentName: título e agente do roster, CLI e modelo da rota', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex', model: 'gpt-5.6-luna' })));
    await paneSpawnTool.handler({ agentName: 'Executor', prompt: 'tela de login' }, userPane());
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'codex',
      model: 'gpt-5.6-luna',
      title: 'Executor',
      agentName: 'Executor',
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/orch/operator-spawn-route.test.ts src/main/orch/tools-panes-operator-child.test.ts`
Expected: FAIL — módulo novo inexistente; spawn ainda usa `adapterId` do agente.

- [ ] **Step 3: Write the helpers** — `src/main/orch/operator-spawn-route.ts`:

```ts
import type { PaneRuntimeState } from '../../shared/orch-types';
import {
  isJevUnavailableReason,
  type SpawnRouteInfo,
} from '../../shared/spawn-route';

/**
 * Peças puras do spawn da mão do operador sempre roteado (A, 25/09): o agente
 * descreve a tarefa, o Jev + tabela escolhem CLI/modelo/esforço.
 */

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Texto que o roteador classifica: task, senão prompt, senão title. */
export function operatorRouteTask(args: Record<string, unknown>): string | null {
  return nonBlank(args.task) ?? nonBlank(args.prompt) ?? nonBlank(args.title) ?? null;
}

/** O que o agente pediu e o roteamento descartou — vai no recibo. */
export function ignoredRouteChoice(
  args: Record<string, unknown>,
): { adapterId?: string; model?: string; effort?: string } | null {
  const adapterId = nonBlank(args.adapterId);
  const model = nonBlank(args.model);
  const effort = nonBlank(args.effort);
  if (!adapterId && !model && !effort) return null;
  return {
    ...(adapterId ? { adapterId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export interface UseCountPane {
  readonly sessionId: string | null;
  readonly adapterId?: string;
  readonly state: PaneRuntimeState;
}

const INACTIVE: ReadonlySet<PaneRuntimeState> = new Set(['exited', 'parked', 'hibernated']);

/**
 * CLIs já em uso pelo agente pai: a dele e a de cada filho vivo que ele
 * abriu. É "por pai" porque o Main ainda não conhece abas (sub-projeto B).
 */
export function operatorChildUseCounts(
  parentSessionId: string | undefined,
  parentAdapterId: string | undefined,
  panes: readonly UseCountPane[],
  parentOf: (sessionId: string) => string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!parentSessionId) return counts;
  const bump = (adapterId: string) => counts.set(adapterId, (counts.get(adapterId) ?? 0) + 1);
  if (parentAdapterId) bump(parentAdapterId);
  for (const pane of panes) {
    if (!pane.sessionId || !pane.adapterId || INACTIVE.has(pane.state)) continue;
    if (parentOf(pane.sessionId) !== parentSessionId) continue;
    bump(pane.adapterId);
  }
  return counts;
}

/** Origem da rota que o renderer exibe (chip + toast). */
export function spawnRouteFrom(
  route: Record<string, unknown> | undefined,
): SpawnRouteInfo | undefined {
  if (!route) return undefined;
  const raw = route.classifierSource;
  const source = raw === 'jev' || raw === 'mixed' ? raw : 'heuristic';
  return isJevUnavailableReason(route.jevUnavailable)
    ? { source, jevUnavailable: route.jevUnavailable }
    : { source };
}

export function routeString(
  route: Record<string, unknown> | undefined,
  key: 'adapterId' | 'model' | 'effort',
): string | undefined {
  return nonBlank(route?.[key]);
}
```

- [ ] **Step 4: Wire it into the handler** — em `tools-panes.ts`:

1. Imports: adicione

```ts
import {
  ignoredRouteChoice,
  operatorChildUseCounts,
  operatorRouteTask,
  routeString,
  spawnRouteFrom,
} from './operator-spawn-route';
```

   e acrescente `findPane, getPaneRuntimeAuthorityBySession, listPaneSnapshots` ao import de `./pane-registry` (os que faltarem).
2. Depois de `const inheritOperatorFreedom = …;` no handler:

```ts
    // A (25/09): na mão do operador sem missão o Jev + tabela SEMPRE decidem a
    // CLI; o que o agente pediu vira `route.ignored` no recibo. `resume` fica
    // de fora — trocar a CLI perderia a conversa retomada.
    const resumeRef = str(args, 'resume');
    const forceOperatorRoute =
      operatorHand &&
      !resumeRef &&
      !str(args, 'missionId') &&
      operatorRouteResolver !== null;
    const ignoredChoice = forceOperatorRoute ? ignoredRouteChoice(args) : null;
    const resolveOperatorRoute = async (): Promise<Record<string, unknown>> => {
      const task = operatorRouteTask(args);
      if (!task) {
        throw new Error(
          'nexus_pane_spawn: descreva a tarefa em `task` (ou `prompt`/`title`) — ' +
            'o Nexus escolhe a CLI pelo roteamento automático',
        );
      }
      const tieBreakUseCounts = operatorChildUseCounts(
        ctx.sessionId,
        ctx.providerId,
        listPaneSnapshots(),
        (sessionId) => getPaneRuntimeAuthorityBySession(sessionId)?.operatorParentSessionId,
      );
      let route: Record<string, unknown>;
      try {
        route = await operatorRouteResolver!(task, ctx, { tieBreakUseCounts });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`nexus_pane_spawn: roteamento automático falhou (${message})`);
      }
      if (!routeString(route, 'adapterId')) {
        throw new Error('nexus_pane_spawn: roteamento automático falhou (sem adapterId)');
      }
      return route;
    };
```

3. Ramo `agentRef`: substitua o trecho de `const requestedAdapterId = …` até `rosterRouteAuthorized = honored.rosterHonored || noRouteOverride;` por:

```ts
      const requestedAdapterId = str(args, 'adapterId');
      const requestedModel = str(args, 'model');
      const requestedEffort = str(args, 'effort');
      if (forceOperatorRoute) autoRoute = await resolveOperatorRoute();
      const honored = forceOperatorRoute
        ? null
        : honorSealedRosterRuntime({
            sealedCli: agent.cli,
            sealedModel: agent.model,
            sealedEffort: agent.effort,
            requestedAdapterId,
            requestedModel,
            requestedEffort,
          });
      const selectedAdapterId = honored
        ? honored.adapterId
        : routeString(autoRoute, 'adapterId')!;
      const selectedModel = honored ? honored.model : routeString(autoRoute, 'model');
      const selectedEffort = honored ? honored.effort : routeString(autoRoute, 'effort');
      const noRouteOverride =
        requestedAdapterId === undefined &&
        requestedModel === undefined &&
        requestedEffort === undefined;
      rosterRouteAuthorized = honored ? honored.rosterHonored || noRouteOverride : false;
```

4. Ramo ad-hoc: substitua de `let adHocAdapterId = str(args, 'adapterId');` até o fechamento do `if (adHocAdapterId === undefined && operatorHand && operatorRouteResolver) { … }` por:

```ts
      let adHocAdapterId = forceOperatorRoute ? undefined : str(args, 'adapterId');
      if (forceOperatorRoute) {
        autoRoute = await resolveOperatorRoute();
        adHocAdapterId = routeString(autoRoute, 'adapterId');
      } else if (operatorHand && resumeRef) {
        // Retomar mantém a CLI do pane retomado: o registro vivo (pane
        // estacionado) vence o que o agente mandou; sem registro, os args.
        adHocAdapterId = findPane(resumeRef)?.adapterId ?? adHocAdapterId;
      } else if (adHocAdapterId === undefined && operatorHand && operatorRouteResolver) {
        // Resolver sempre existe em produção; este ramo só cobre args com
        // missionId explícito vindos da mão do operador.
        autoRoute = await resolveOperatorRoute();
        adHocAdapterId = routeString(autoRoute, 'adapterId');
      }
```

   e troque as duas linhas de `adHocModel`/`adHocEffort` por:

```ts
      const adHocModel =
        (forceOperatorRoute ? undefined : str(args, 'model')) ??
        routeString(autoRoute, 'model');
      const adHocEffort =
        (forceOperatorRoute ? undefined : str(args, 'effort')) ??
        routeString(autoRoute, 'effort');
```

5. Depois do `if/else` dos dois ramos (antes do comentário "Escolha livre de agentes"):

```ts
    if (autoRoute) {
      const spawnRoute = spawnRouteFrom(autoRoute);
      if (spawnRoute) options = { ...options, spawnRoute };
    }
```

6. No `routeReceipt`, dentro de `route: { … }`, depois de `...(routeSkill ? { skill: routeSkill } : {}),`:

```ts
              ...(typeof autoRoute.jevUnavailable === 'string'
                ? { jevUnavailable: autoRoute.jevUnavailable }
                : {}),
              ...(ignoredChoice ? { ignored: ignoredChoice } : {}),
```

7. Descrição da tool: troque a frase `'From the operator\'s own pane without a mission, adapterId may be omitted ' + 'when task/prompt is given — Nexus routes it automatically, and a ' + 'confident Jev skill suggestion adds one hint line to the prompt. ' +` por

```ts
    'From the operator\'s own pane without a mission, Nexus ALWAYS routes: ' +
    'describe the work in `task` (or prompt/title) — adapterId, model and ' +
    'effort are ignored there (the receipt lists them under route.ignored), ' +
    'resume keeps the resumed pane\'s CLI, and a confident Jev skill ' +
    'suggestion adds one hint line to the prompt. ' +
```

   e as descrições de `adapterId`/`task` no schema por:

```ts
      adapterId: {
        type: 'string',
        description:
          'Adapter id (cli) to run. Ignored from the operator pane without a ' +
          'mission (Nexus routes the task); required elsewhere.',
      },
```

```ts
      task: {
        type: 'string',
        description:
          'What this pane will do. From the operator pane without a mission ' +
          'Nexus routes it (Jev tier/specialty + cost table) to a CLI/model; ' +
          'prompt/title are used when task is absent.',
      },
```

8. Em `tool-util.ts`, na interface `SpawnToolOptions`, depois de `missionId?: string;`:

```ts
  /** Origem da rota (A, 25/09) exibida no cabeçalho do pane; nunca autoridade. */
  spawnRoute?: import('../../shared/spawn-route').SpawnRouteInfo;
```

   (ou um `import type { SpawnRouteInfo } from '../../shared/spawn-route';` no topo, seguindo o estilo do arquivo).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/operator-spawn-route.test.ts src/main/orch/tools-panes-operator-child.test.ts src/main/orch/tools-panes-user-spawn.test.ts src/main/orch/tools-panes-route-gate.test.ts && npx tsc --noEmit`
Expected: PASS; typecheck limpo.

- [ ] **Step 6: Commit**

```bash
git add src/main/orch/operator-spawn-route.ts src/main/orch/operator-spawn-route.test.ts src/main/orch/tools-panes.ts src/main/orch/tool-util.ts src/main/orch/tools-panes-operator-child.test.ts
git commit -m "feat(spawn): pane aberto por agente do operador sempre passa pelo Jev"
```

---

### Task 8: contrato Main→renderer leva a rota e o pane pai

**Files:**
- Modify: `src/shared/orch-types.ts` (`OrchPaneSpawnRequest` ~linha 753)
- Modify: `src/main/orch/main-owned-pane-runtime.ts` (`PaneSpawnOptions` ~linha 91)
- Modify: `src/main/orch/pane-registry.ts` (montagem do `request` ~linha 2285)
- Modify: `src/main/orch/operator-spawn-route.ts` (+ `parentPaneIdFor`)
- Test: `src/main/orch/operator-spawn-route.test.ts`

**Interfaces:**
- Consumes: `SpawnToolOptions.spawnRoute` (Task 7).
- Produces: `OrchPaneSpawnRequest.route?: SpawnRouteInfo`, `OrchPaneSpawnRequest.parentPaneId?: string`; `PaneSpawnOptions.spawnRoute?: SpawnRouteInfo`; `export function parentPaneIdFor(parentSessionId: string | undefined, findPaneId: (sessionId: string) => string | undefined): string | undefined`. A Task 9 lê `route` e `parentPaneId`.

- [ ] **Step 1: Write the failing test** — em `operator-spawn-route.test.ts` (importe `parentPaneIdFor`):

```ts
  it('parentPaneIdFor converte a sessão do pai em paneId, nunca vaza a sessão', () => {
    const lookup = (sid: string) => (sid === 'sess-parent' ? 'pane-7' : undefined);
    expect(parentPaneIdFor('sess-parent', lookup)).toBe('pane-7');
    expect(parentPaneIdFor('sess-gone', lookup)).toBeUndefined();
    expect(parentPaneIdFor(undefined, lookup)).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/orch/operator-spawn-route.test.ts -t parentPaneIdFor`
Expected: FAIL — função inexistente.

- [ ] **Step 3: Write minimal implementation**

Em `operator-spawn-route.ts`:

```ts
/**
 * O renderer herda a aba do pai pelo PANE id. A sessão do pai
 * (`operatorParentSessionId`) é autoridade do Main e nunca cruza para lá.
 */
export function parentPaneIdFor(
  parentSessionId: string | undefined,
  findPaneId: (sessionId: string) => string | undefined,
): string | undefined {
  return parentSessionId ? findPaneId(parentSessionId) : undefined;
}
```

Em `src/shared/orch-types.ts`, no topo `import type { SpawnRouteInfo } from './spawn-route';` e em `OrchPaneSpawnRequest`, depois de `role?: …`:

```ts
  /** Origem da rota do spawn roteado (chip "Jev"/"sem Jev"); só exibição. */
  route?: SpawnRouteInfo;
  /**
   * Pane que pediu este (helper de agente do operador): o renderer herda a
   * aba dele. Só o id do pane — a sessão do pai nunca sai do Main.
   */
  parentPaneId?: string;
```

Em `main-owned-pane-runtime.ts`, `PaneSpawnOptions`, depois de `operatorParentSessionId?: string;`:

```ts
  /** Origem da rota exibida no renderer; não confere autoridade nenhuma. */
  spawnRoute?: SpawnRouteInfo;
```

(com `import type { SpawnRouteInfo } from '../../shared/spawn-route';`).

Em `pane-registry.ts`, importe `parentPaneIdFor` de `./operator-spawn-route` e, no `Object.freeze({ … })` do `request`, depois de `role: options.role,`:

```ts
    ...(options.spawnRoute ? { route: options.spawnRoute } : {}),
    ...(() => {
      const parentPaneId = parentPaneIdFor(
        options.operatorParentSessionId,
        (sessionId) => findPane(sessionId)?.paneId,
      );
      return parentPaneId ? { parentPaneId } : {};
    })(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/operator-spawn-route.test.ts src/main/orch/tools-panes-operator-child.test.ts && npx tsc --noEmit && npm run security:renderer-sinks`
Expected: PASS; typecheck limpo; sinks sem achado novo.

- [ ] **Step 5: Commit**

```bash
git add src/shared/orch-types.ts src/main/orch/main-owned-pane-runtime.ts src/main/orch/pane-registry.ts src/main/orch/operator-spawn-route.ts src/main/orch/operator-spawn-route.test.ts
git commit -m "feat(spawn): pedido ao renderer leva origem da rota e pane pai"
```

---

### Task 9: renderer herda a aba do pai, guarda a rota e avisa uma vez

**Files:**
- Modify: `src/shared/surface-payload-types.ts` (`PaneModel` ~linha 395)
- Modify: `src/renderer/state/layout-store.ts` (tipo e implementação de `spawnOrchPane`, ~linhas 87 e 899)
- Modify: `src/renderer/orch/orch-bridge.ts` (`onPaneSpawnRequest`, ~linha 638)
- Create: `src/renderer/orch/jev-route-notice.ts`, `src/renderer/orch/jev-route-notice.test.ts`
- Test: `src/renderer/state/layout-store.test.ts`

**Interfaces:**
- Consumes: `OrchPaneSpawnRequest.route`/`parentPaneId` (Task 8).
- Produces: `PaneModel.spawnRoute?: SpawnRouteInfo` (NÃO entra em `paneModelSchema`, então não persiste); `spawnOrchPane(req)` aceita `spawnRoute?` e `parentPaneId?`; `export function noticeJevRouteFallback(route: SpawnRouteInfo | undefined, push?: ToastStore['push']): boolean` e `export function resetJevRouteNoticesForTests(): void`. A Task 10 lê `PaneModel.spawnRoute`.

- [ ] **Step 1: Write the failing tests**

Em `layout-store.test.ts` (importe `spaceScopeKey` não é necessário; use os campos crus):

```ts
describe('spawnOrchPane — helper nasce na aba do pai (C3/B1)', () => {
  beforeEach(() => {
    seedLayout({
      root: buildGridTree([
        { ...basePane, id: 'pane-parent', kind: 'cli-agent', spaceId: 'space-b', spaceTitle: 'Feature B' },
        { ...basePane, id: 'pane-other' },
      ]),
      focusedPaneId: 'pane-parent',
    });
  });

  it('herda spaceId/spaceTitle do pai e guarda a rota', () => {
    const id = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-child',
      paneId: 'pane-child',
      adapterId: 'codex',
      parentPaneId: 'pane-parent',
      spawnRoute: { source: 'heuristic', jevUnavailable: 'no-key' },
    });
    const child = listPanes(useLayoutStore.getState().root).find((p) => p.id === id)!;
    expect(child).toMatchObject({
      spaceId: 'space-b',
      spaceTitle: 'Feature B',
      spawnRoute: { source: 'heuristic', jevUnavailable: 'no-key' },
    });
  });

  it('pai ausente: nasce como hoje (sem espaço)', () => {
    const id = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-orphan',
      paneId: 'pane-orphan',
      adapterId: 'codex',
      parentPaneId: 'pane-gone',
    });
    const child = listPanes(useLayoutStore.getState().root).find((p) => p.id === id)!;
    expect(child.spaceId).toBeUndefined();
  });

  it('pai de missão não passa espaço; pane de missão nunca herda', () => {
    seedLayout({
      root: buildGridTree([
        { ...basePane, id: 'pane-parent', kind: 'cli-agent', missionId: 'm1', spaceId: 'space-old' },
      ]),
      focusedPaneId: 'pane-parent',
    });
    const id = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-m',
      paneId: 'pane-m',
      adapterId: 'codex',
      parentPaneId: 'pane-parent',
    });
    expect(listPanes(useLayoutStore.getState().root).find((p) => p.id === id)!.spaceId).toBeUndefined();
  });

  it('spawnRoute não sobrevive ao schema persistido', async () => {
    const { layoutNodeSchema } = await import('../../shared/ipc');
    const parsed = layoutNodeSchema.parse({
      kind: 'leaf',
      id: 'n1',
      pane: { id: 'p', kind: 'cli-agent', title: 't', spawnRoute: { source: 'jev' } },
    }) as { pane: Record<string, unknown> };
    expect(parsed.pane.spawnRoute).toBeUndefined();
  });
});
```

`src/renderer/orch/jev-route-notice.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeJevRouteFallback, resetJevRouteNoticesForTests } from './jev-route-notice';

describe('noticeJevRouteFallback', () => {
  beforeEach(() => resetJevRouteNoticesForTests());

  it('um toast por motivo por execução; rota com Jev não avisa', () => {
    const push = vi.fn();
    expect(noticeJevRouteFallback({ source: 'jev' }, push)).toBe(false);
    expect(noticeJevRouteFallback({ source: 'heuristic', jevUnavailable: 'timeout' }, push)).toBe(true);
    expect(noticeJevRouteFallback({ source: 'heuristic', jevUnavailable: 'timeout' }, push)).toBe(false);
    expect(noticeJevRouteFallback({ source: 'heuristic', jevUnavailable: 'no-key' }, push)).toBe(true);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0]).toEqual([
      'warn',
      'Jev não respondeu (tempo esgotado)',
      expect.objectContaining({ detail: 'O pane foi aberto pela heurística.' }),
    ]);
  });

  it('sem chave ou desligado aponta para Chaves de API', () => {
    const push = vi.fn();
    noticeJevRouteFallback({ source: 'heuristic', jevUnavailable: 'no-key' }, push);
    expect(push.mock.calls[0]![2].detail).toContain('Configurações › Chaves de API');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/state/layout-store.test.ts -t "aba do pai" src/renderer/orch/jev-route-notice.test.ts`
Expected: FAIL — campos desconhecidos em `spawnOrchPane`; módulo inexistente.

- [ ] **Step 3: Write minimal implementation**

`PaneModel` (`surface-payload-types.ts`), depois de `missionHost?: true;` (com `import type { SpawnRouteInfo } from './spawn-route';`):

```ts
  /**
   * Origem da rota de um pane aberto por agente do operador (chip "Jev" /
   * "sem Jev"). Informação do nascimento: fica FORA do paneModelSchema de
   * propósito, então não persiste nem volta no restart.
   */
  spawnRoute?: SpawnRouteInfo;
```

`layout-store.ts`, no tipo de `spawnOrchPane(req: { … })`, depois de `role?: …`:

```ts
    /** Pane que pediu este helper: o helper nasce na aba dele (C3/B1). */
    parentPaneId?: string;
    /** Origem da rota, só exibição. */
    spawnRoute?: SpawnRouteInfo;
```

Na implementação, logo antes de `const newPane: PaneModel = {`:

```ts
    // Helper aberto por agente do operador nasce na aba do pai — mesma regra
    // do split (F-560): missão não se herda, e pane de missão não herda aba.
    const parent = req.parentPaneId
      ? existingPanes.find((pane) => pane.id === req.parentPaneId)
      : undefined;
    const parentHasMission = Boolean(
      parent && (parent.missionId ?? useOrchStore.getState().paneMissions[parent.id]),
    );
    const inheritedSpace =
      parent?.spaceId && !parentHasMission && !req.missionId
        ? { spaceId: parent.spaceId, spaceTitle: parent.spaceTitle }
        : {};
```

e, dentro do objeto `newPane`, depois de `role: req.role,`:

```ts
      ...inheritedSpace,
      ...(req.spawnRoute ? { spawnRoute: req.spawnRoute } : {}),
```

(`useOrchStore` já é importado em `layout-store.ts`; importe `type SpawnRouteInfo` de `'../../shared/spawn-route'`.)

`src/renderer/orch/jev-route-notice.ts`:

```ts
import {
  JEV_UNAVAILABLE_LABEL,
  type SpawnRouteInfo,
} from '../../shared/spawn-route';
import { useToastStore } from '../state/toast-store';

type Push = ReturnType<typeof useToastStore.getState>['push'];

/** Motivos já avisados nesta execução do app (um toast por motivo). */
const noticed = new Set<string>();

/**
 * Pane aberto pela heurística porque o Jev não respondeu: avisa UMA vez por
 * motivo. Sem chave/desligado aponta para onde resolver.
 */
export function noticeJevRouteFallback(
  route: SpawnRouteInfo | undefined,
  push: Push = useToastStore.getState().push,
): boolean {
  const reason = route?.jevUnavailable;
  if (!reason || noticed.has(reason)) return false;
  noticed.add(reason);
  const fix =
    reason === 'no-key' || reason === 'disabled'
      ? ' Ative em Configurações › Chaves de API › TypeSafe (Jev).'
      : '';
  push('warn', `Jev não respondeu (${JEV_UNAVAILABLE_LABEL[reason]})`, {
    detail: `O pane foi aberto pela heurística.${fix}`,
    dedupeKey: `jev-route-fallback:${reason}`,
  });
  return true;
}

export function resetJevRouteNoticesForTests(): void {
  noticed.clear();
}
```

`orch-bridge.ts`, no `spawnOrchPane({ … })` do `onPaneSpawnRequest`, depois de `role: req.role ?? 'worker',`:

```ts
                ...(req.parentPaneId ? { parentPaneId: req.parentPaneId } : {}),
                ...(req.route ? { spawnRoute: req.route } : {}),
```

e logo depois do `console.info(... pane spawn materialized ...)`: `noticeJevRouteFallback(req.route);` (import de `./jev-route-notice`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/state/layout-store.test.ts src/renderer/orch/jev-route-notice.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/surface-payload-types.ts src/renderer/state/layout-store.ts src/renderer/state/layout-store.test.ts src/renderer/orch/orch-bridge.ts src/renderer/orch/jev-route-notice.ts src/renderer/orch/jev-route-notice.test.ts
git commit -m "feat(terminais): helper nasce na aba do pai e queda do Jev avisa uma vez"
```

---

### Task 10: chip "Jev" / "sem Jev" no cabeçalho do pane

**Files:**
- Modify: `src/renderer/components/PaneToolbar.tsx` (perto de `JevHintChip`, ~linha 147; render ~linha 872)
- Create: `src/renderer/components/PaneToolbar.spawn-route.test.tsx`

**Interfaces:**
- Consumes: `PaneModel.spawnRoute` (Task 9), `JEV_UNAVAILABLE_LABEL` (Task 2).
- Produces: `SpawnRouteChip` interno ao arquivo; reusa as classes `toolbar__state toolbar__state--chip` (sem CSS novo).

- [ ] **Step 1: Write the failing test** — abra o arquivo com `/** @vitest-environment jsdom */`, os imports `import { act } from 'react'; import { createRoot } from 'react-dom/client'; import { afterEach, describe, expect, it, vi } from 'vitest';`, os mesmos `vi.mock` de `PaneToolbar.jev-hint.test.tsx` (terminal-host, confirm-store, pane-close-guard, CostBadge, DevServerChip, ProviderLogo, CommandBlockMenu, AgentAvatar, PixelIcon — copie literalmente as linhas 9–27 de lá) e o `IS_REACT_ACT_ENVIRONMENT = true`. Depois:

```tsx
import type { PaneModel } from '../../shared/types';
import { PaneToolbar } from './PaneToolbar';

function mount(pane: PaneModel): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<PaneToolbar pane={pane} isFocused />));
  return host;
}

describe('PaneToolbar — chip da rota do spawn', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const base: PaneModel = { id: 'p1', kind: 'cli-agent', title: 'Helper', adapterId: 'codex' };

  it('rota do Jev mostra "Jev"', () => {
    const host = mount({ ...base, spawnRoute: { source: 'jev' } });
    expect(host.textContent).toContain('Jev');
    expect(host.innerHTML).toContain('CLI escolhida pelo Jev');
  });

  it('queda mostra "sem Jev" com o motivo no tooltip', () => {
    const host = mount({ ...base, spawnRoute: { source: 'heuristic', jevUnavailable: 'timeout' } });
    expect(host.textContent).toContain('sem Jev');
    expect(host.innerHTML).toContain('tempo esgotado');
  });

  it('heurística sem queda (Jev pouco confiante) e pane sem rota não mostram chip', () => {
    expect(mount({ ...base, spawnRoute: { source: 'heuristic' } }).innerHTML).not.toContain('rota-chip');
    expect(mount(base).innerHTML).not.toContain('rota-chip');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/components/PaneToolbar.spawn-route.test.tsx`
Expected: FAIL — nenhum chip renderizado.

- [ ] **Step 3: Write minimal implementation** — em `PaneToolbar.tsx` (import `JEV_UNAVAILABLE_LABEL` e `type SpawnRouteInfo` de `'../../shared/spawn-route'`), depois de `JevHintChip`:

```tsx
/** Quem escolheu a CLI deste pane: o Jev, ou a heurística porque ele caiu. */
function SpawnRouteChip({ route }: { route: SpawnRouteInfo | undefined }) {
  if (!route) return null;
  if (route.jevUnavailable) {
    const tip = `CLI escolhida pela heurística — Jev ${JEV_UNAVAILABLE_LABEL[route.jevUnavailable]}`;
    return (
      <span className="toolbar__state toolbar__state--chip" data-rota-chip="fallback" data-tip={tip} aria-label={tip}>
        <span className="toolbar__state-label">sem Jev</span>
      </span>
    );
  }
  if (route.source === 'heuristic') return null;
  const tip = 'CLI escolhida pelo Jev para esta tarefa';
  return (
    <span className="toolbar__state toolbar__state--chip" data-rota-chip="jev" data-tip={tip} aria-label={tip}>
      <span className="toolbar__state-label">Jev</span>
    </span>
  );
}
```

e, logo depois de `{pane.kind === 'cli-agent' && <JevHintChip paneId={pane.id} />}`:

```tsx
        {pane.kind === 'cli-agent' && <SpawnRouteChip route={pane.spawnRoute} />}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/components/PaneToolbar.spawn-route.test.tsx src/renderer/components/PaneToolbar.test.tsx src/renderer/components/PaneToolbar.jev-hint.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/PaneToolbar.tsx src/renderer/components/PaneToolbar.spawn-route.test.tsx
git commit -m "feat(pane): chip mostra se a CLI veio do Jev ou da heurística"
```

---

# Parte C — delegação automática

### Task 11: doutrina de delegação no `initialize` do MCP

**Files:**
- Create: `src/main/orch/operator-delegation-doctrine.ts`, `src/main/orch/operator-delegation-doctrine.test.ts`
- Modify: `src/main/orch/mcp-protocol.ts` (caso `initialize`, ~linha 185)
- Test: `src/main/orch/mcp-protocol.test.ts`

**Interfaces:**
- Produces: `export const OPERATOR_DELEGATION_DOCTRINE: string`; `export function operatorDelegationInstructions(ctx: Pick<AgentGateContext, 'role' | 'missionId'>): string | undefined`.

- [ ] **Step 1: Write the failing tests**

`operator-delegation-doctrine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  OPERATOR_DELEGATION_DOCTRINE,
  operatorDelegationInstructions,
} from './operator-delegation-doctrine';

describe('doutrina de delegação da mão do operador', () => {
  it('cabe em 1,5 KB e cobre os pontos da spec', () => {
    expect(Buffer.byteLength(OPERATOR_DELEGATION_DOCTRINE, 'utf8')).toBeLessThanOrEqual(1536);
    for (const needle of ['nexus_pane_spawn', 'readOnly: true', 'um helper por vez', 'encerre o turno', 'nexus_handoff_submit', 'não insista']) {
      expect(OPERATOR_DELEGATION_DOCTRINE).toContain(needle);
    }
    // Não existe spawn em lote (`panes: [...]`) — a doutrina não pode prometer.
    expect(OPERATOR_DELEGATION_DOCTRINE).not.toContain('panes:');
    expect(OPERATOR_DELEGATION_DOCTRINE).not.toContain('adapterId:');
  });

  it('só a mão do operador sem missão recebe', () => {
    expect(operatorDelegationInstructions({ role: 'user' })).toBe(OPERATOR_DELEGATION_DOCTRINE);
    expect(operatorDelegationInstructions({ role: 'user', missionId: 'm' })).toBeUndefined();
    expect(operatorDelegationInstructions({ role: 'orchestrator', missionId: 'm' })).toBeUndefined();
    expect(operatorDelegationInstructions({ role: 'worker', missionId: 'm' })).toBeUndefined();
  });
});
```

Em `mcp-protocol.test.ts`, depois do teste de `initialize` existente:

```ts
  it('initialize entrega a doutrina de delegação só à mão do operador sem missão', async () => {
    const user = await handleMcpMessage(makeRegistry(), userCtx(), req('initialize', {}));
    expect((user?.result as { instructions?: string }).instructions).toContain('nexus_pane_spawn');
    const worker = await handleMcpMessage(makeRegistry(), missionCtx(), req('initialize', {}));
    expect((worker?.result as { instructions?: string }).instructions).toBeUndefined();
    const orch = await handleMcpMessage(makeRegistry(), orchestratorMissionCtx(), req('initialize', {}));
    expect((orch?.result as { instructions?: string }).instructions).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/orch/operator-delegation-doctrine.test.ts src/main/orch/mcp-protocol.test.ts -t "doutrina|instructions"`
Expected: FAIL — módulo inexistente; `instructions` ausente.

- [ ] **Step 3: Write minimal implementation**

`operator-delegation-doctrine.ts`:

```ts
import type { AgentGateContext } from './gate';

/**
 * Doutrina de delegação dos panes da mão do operador (C1, 25/09): todo pane
 * sem missão — os abertos no "+" e os helpers que eles abrem — distribui o
 * trabalho em vez de executar tudo sozinho. Vai no `instructions` do
 * `initialize` do MCP, que qualquer CLI com MCP pode ler. Teto: 1,5 KB.
 * Missão tem doutrina própria (orchestrator-doctrine.ts) e não recebe esta.
 */
export const OPERATOR_DELEGATION_DOCTRINE = [
  'NEXUS — COMO TRABALHAR NESTE PANE:',
  '1. Delegue o que for divisível, pesado ou paralelizável: nexus_pane_spawn({ task, prompt }). O Nexus (Jev) escolhe CLI, modelo e esforço — descreva a tarefa em task.',
  '2. Pesquisa, revisão, análise e leitura de testes: readOnly: true. Esses helpers rodam em paralelo.',
  '3. Quem altera código: um helper por vez. Enquanto um helper que escreve estiver rodando, você não edita arquivos.',
  '4. Depois de delegar, encerre o turno: a entrega chega sozinha no seu input. Não fique lendo panes em loop.',
  '5. Ao receber cada entrega: integre, verifique e reporte ao operador.',
  '6. Tarefa pequena ou conversa: faça você mesmo.',
  '7. Se você foi aberto por outro pane (é helper), termine com nexus_handoff_submit uma vez: o que fez, o que validou, o que bloqueou.',
  '8. Spawn recusado (writer ativo, teto de panes): não insista — faça a parte você mesmo ou espere a entrega em curso.',
].join('\n');

export function operatorDelegationInstructions(
  ctx: Pick<AgentGateContext, 'role' | 'missionId'>,
): string | undefined {
  return ctx.role === 'user' && !ctx.missionId ? OPERATOR_DELEGATION_DOCTRINE : undefined;
}
```

Em `mcp-protocol.ts` (import `operatorDelegationInstructions` de `./operator-delegation-doctrine`), no `case "initialize"`:

```ts
      const instructions = operatorDelegationInstructions(ctx);
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: registry.serverName,
          version: registry.serverVersion,
        },
        ...(instructions ? { instructions } : {}),
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/operator-delegation-doctrine.test.ts src/main/orch/mcp-protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Corrigir a spec C** — em `docs/superpowers/specs/2026-09-25-delegacao-automatica-design.md`, item 2 da C1, remova "(N helpers independentes = uma chamada só)": o `nexus_pane_spawn` não tem spawn em lote (a frase da skill `oc-pilot` está desatualizada).

- [ ] **Step 6: Commit**

```bash
git add src/main/orch/operator-delegation-doctrine.ts src/main/orch/operator-delegation-doctrine.test.ts src/main/orch/mcp-protocol.ts src/main/orch/mcp-protocol.test.ts docs/superpowers/specs/2026-09-25-delegacao-automatica-design.md
git commit -m "feat(delegação): pane do operador nasce sabendo delegar"
```

---

### Task 12: superfície Jev `delegation`

**Files:**
- Create: `src/main/jev/jev-delegation.ts`, `src/main/jev/jev-delegation.test.ts`
- Modify: `src/main/jev/jev-autopilot.ts` (`JevSurface`, `JEV_SURFACES`)
- Modify: `src/shared/settings-types.ts` (`jevSurfaces`, ~linha 149)
- Modify: `src/renderer/components/settings/ModuleSections.tsx` (~linhas 438, 461, 855)

**Interfaces:**
- Produces:
  ```ts
  export const DELEGATE_MIN_PROMPT_CHARS = 40;
  export const DELEGATE_MIN_CONFIDENCE = 0.6;
  export const DELEGATE_TIMEOUT_MS = 2_500;
  export interface DelegationAdvice { readonly parts: number; readonly writers: number; readonly confidence: number; readonly model: string }
  export interface AdviseDelegationDeps { judge?: typeof judge; enabled?: () => boolean; hasKey?: () => boolean; sessionId?: string }
  export async function adviseDelegation(message: string, deps?: AdviseDelegationDeps): Promise<DelegationAdvice | null>;
  ```
  `null` = não aconselha (curta, desligada, sem chave, Jev fora, 1 parte, pouca confiança).

- [ ] **Step 1: Write the failing test** — `jev-delegation.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('./jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  jevAnswerProbabilities: () => ({}),
  jevAnswerConfidences: () => ({}),
}));
vi.mock('./jev-autopilot', () => ({ isJevSurfaceEnabled: vi.fn(() => true) }));
vi.mock('./jev-secrets', () => ({ hasJevCredential: vi.fn(() => true) }));

import type { JevResult, JudgeInput } from './jev-client';
import { recordJevDecision } from './jev-decision-log';
import { adviseDelegation, DELEGATE_MIN_PROMPT_CHARS } from './jev-delegation';

type JudgeMock = (input: JudgeInput) => Promise<JevResult | null>;
const LONG = 'Implemente a tela de login, escreva os testes e revise a segurança do fluxo inteiro.';

function verdict(divisible: number, parts: string, writers: string): JevResult {
  return {
    model: 'jev-test',
    answers: {
      divisible: { type: 'noul', noul: divisible },
      parts: { type: 'choice', choice: parts, probabilities: {}, confidence: 0.8 },
      writers: { type: 'choice', choice: writers, probabilities: {}, confidence: 0.8 },
    },
    usage: { input_tokens: 50, output_tokens: 5 },
  };
}

describe('adviseDelegation', () => {
  it('aconselha com 2+ partes e confiança ≥ 0,6, e registra a decisão', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.8, '3', '1'));
    expect(await adviseDelegation(LONG, { judge })).toEqual({
      parts: 3, writers: 1, confidence: 0.8, model: 'jev-test',
    });
    expect(judge.mock.calls[0]![0]).toMatchObject({ surface: 'delegation', timeoutMs: 2_500 });
    expect(recordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'delegation', decision: 'delegate:3p/1w' }),
    );
  });

  it('5+ vira 5 e 2+ vira 2', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.9, '5+', '2+'));
    expect(await adviseDelegation(LONG, { judge })).toMatchObject({ parts: 5, writers: 2 });
  });

  it('silêncio: 1 parte, pouca confiança, Jev fora, desligado, sem chave', async () => {
    expect(await adviseDelegation(LONG, { judge: vi.fn<JudgeMock>(async () => verdict(0.9, '1', '0')) })).toBeNull();
    expect(await adviseDelegation(LONG, { judge: vi.fn<JudgeMock>(async () => verdict(0.4, '3', '0')) })).toBeNull();
    expect(await adviseDelegation(LONG, { judge: vi.fn<JudgeMock>(async () => null) })).toBeNull();
    const judge = vi.fn<JudgeMock>();
    expect(await adviseDelegation(LONG, { judge, enabled: () => false })).toBeNull();
    expect(await adviseDelegation(LONG, { judge, hasKey: () => false })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it(`mensagem com menos de ${DELEGATE_MIN_PROMPT_CHARS} caracteres não chama o Jev`, async () => {
    const judge = vi.fn<JudgeMock>();
    expect(await adviseDelegation('siga', { judge })).toBeNull();
    expect(await adviseDelegation('   ok   ', { judge })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('segredo colado na mensagem sai mascarado no state do judge', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.9, '2', '0'));
    // O judge real aplica redactState; aqui provamos que a mensagem vai crua
    // SÓ até o judge, que é quem redige — o teste do jev-client cobre a redação.
    const secret = `sk-ant-${'x'.repeat(40)}`;
    await adviseDelegation(`${LONG} chave ${secret}`, { judge });
    const { redactState } = await import('./jev-client');
    const sent = redactState(judge.mock.calls[0]![0].state) as { message: string };
    expect(sent.message).not.toContain(secret);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/jev/jev-delegation.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Write minimal implementation**

`jev-autopilot.ts`: acrescente `| 'delegation'` ao tipo `JevSurface` e `'delegation',` ao array `JEV_SURFACES`.

`settings-types.ts`, em `jevSurfaces`, depois de `researchTriage`:

```ts
      /** Conselho de delegação por mensagem nos panes do operador (hook). */
      delegation: z.boolean().default(true),
```

`ModuleSections.tsx`: `delegation: true,` no estado inicial; `delegation: o.jevSurfaces?.delegation !== false,` no `setJevSurfaces`; e `['delegation', 'Delegação automática (dividir pedidos em panes)'],` na lista de toggles, depois de `researchTriage`.

`src/main/jev/jev-delegation.ts`:

```ts
/**
 * Conselho de delegação via TypeSafe Jev (superfície `delegation`, C2 25/09).
 * A cada mensagem que o operador manda a um pane dele, o hook UserPromptSubmit
 * pergunta: isto se divide? em quantas partes? quantas escrevem? Com 2+ partes
 * e confiança ≥ 0,6 o pane recebe um lembrete para delegar. FAIL-OPEN: null =
 * nenhum lembrete, o pane segue como hoje.
 */
import {
  capText,
  judge,
  USD_PER_INPUT_TOKEN,
  type JevQuestion,
} from './jev-client';
import { isJevSurfaceEnabled } from './jev-autopilot';
import { hasJevCredential } from './jev-secrets';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from './jev-decision-log';

export const DELEGATE_MIN_PROMPT_CHARS = 40;
export const DELEGATE_MIN_CONFIDENCE = 0.6;
export const DELEGATE_TIMEOUT_MS = 2_500;
const DELEGATE_MAX_CHARS = 3_000;

const DELEGATION_QUESTIONS: Record<string, JevQuestion> = {
  divisible: {
    type: 'noul',
    instructions:
      'Does this request to a coding agent ask for work that splits into ' +
      'independent parts that separate agents could do in parallel?',
    criteria: {
      true: 'several independent pieces of work (research, implementation, tests, review…)',
      false: 'one cohesive task, a small change, a question or conversation',
    },
  },
  parts: {
    type: 'choice',
    instructions: 'How many independent parts does this work split into?',
    criteria: { '1': null, '2': null, '3': null, '4': null, '5+': null },
  },
  writers: {
    type: 'choice',
    instructions: 'How many of those parts change code or files (the rest only read)?',
    criteria: { '0': null, '1': null, '2+': null },
  },
};

export interface DelegationAdvice {
  readonly parts: number;
  readonly writers: number;
  readonly confidence: number;
  readonly model: string;
}

export interface AdviseDelegationDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
  sessionId?: string;
}

function countOf(choice: string | undefined): number {
  const parsed = Number.parseInt(choice ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function adviseDelegation(
  message: string,
  deps: AdviseDelegationDeps = {},
): Promise<DelegationAdvice | null> {
  if (message.trim().length < DELEGATE_MIN_PROMPT_CHARS) return null;
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('delegation'));
  const hasKey = deps.hasKey ?? hasJevCredential;
  if (!enabled() || !hasKey()) return null;

  const judgeFn = deps.judge ?? judge;
  const result = await judgeFn({
    state: { message: capText(message, DELEGATE_MAX_CHARS) },
    questions: DELEGATION_QUESTIONS,
    timeoutMs: DELEGATE_TIMEOUT_MS,
    // Teto total: sem isto o retry do judge dobraria a espera do hook.
    signal: AbortSignal.timeout(DELEGATE_TIMEOUT_MS),
    surface: 'delegation',
    sessionId: deps.sessionId,
  });
  if (!result) return null;

  const divisible = result.answers.divisible;
  const partsAnswer = result.answers.parts;
  const writersAnswer = result.answers.writers;
  if (divisible?.type !== 'noul' || partsAnswer?.type !== 'choice') return null;
  const parts = countOf(partsAnswer.choice);
  const writers = Math.min(
    parts,
    writersAnswer?.type === 'choice' ? countOf(writersAnswer.choice) : 0,
  );
  const advise = divisible.noul >= DELEGATE_MIN_CONFIDENCE && parts >= 2;

  recordJevDecision({
    surface: 'delegation',
    sessionId: deps.sessionId,
    model: result.model,
    questions: Object.keys(DELEGATION_QUESTIONS),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: advise ? `delegate:${parts}p/${writers}w` : 'solo',
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });
  if (!advise) return null;
  return { parts, writers, confidence: divisible.noul, model: result.model };
}
```

(`JevDecisionInput` já aceita `sessionId` — `jev-decision-log.ts:41`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/jev/jev-delegation.test.ts src/main/jev/jev-autopilot.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/jev/jev-delegation.ts src/main/jev/jev-delegation.test.ts src/main/jev/jev-autopilot.ts src/shared/settings-types.ts src/renderer/components/settings/ModuleSections.tsx
git commit -m "feat(jev): superfície de delegação julga se a mensagem se divide"
```

---

### Task 13: `POST /hook/delegate`

**Files:**
- Create: `src/main/orch/hook-http.ts`, `src/main/orch/hook-delegate-endpoint.ts`, `src/main/orch/hook-delegate-endpoint.test.ts`
- Modify: `src/main/orch/hook-triage-endpoint.ts` (passa a usar `hook-http.ts`)
- Modify: `src/main/orch/mcp-server.ts` (URL ~linha 389, env ~linha 1098, rota ~linha 1927)

**Interfaces:**
- Consumes: `adviseDelegation` (Task 12).
- Produces:
  ```ts
  // hook-http.ts
  export function sendHookJson(res: http.ServerResponse, status: number, payload: unknown): void;
  export async function handleHookJsonPost(req, res, ctx: unknown | null, maxBytes: number, onBody: (body: unknown) => Promise<{ statusCode: number; payload: unknown }>): Promise<void>;
  // hook-delegate-endpoint.ts
  export const HOOK_DELEGATE_MAX_BODY_BYTES = 64 * 1024;
  export function parseUserPrompt(body: unknown): string | null;
  export function formatDelegationContext(advice: DelegationAdvice): string;
  export async function handleHookDelegateRequest(ctx: Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId'>, body: unknown, deps?: { advise?: typeof adviseDelegation }): Promise<{ statusCode: 200; payload: Record<string, unknown> }>;
  export async function handleHookDelegateHttp(req: http.IncomingMessage, res: http.ServerResponse, ctx: AgentGateContext | null): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test** — `hook-delegate-endpoint.test.ts`:

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatDelegationContext,
  handleHookDelegateHttp,
  handleHookDelegateRequest,
  parseUserPrompt,
} from './hook-delegate-endpoint';

const operator = { role: 'user' as const, sessionId: 's1' };
const LONG = 'Implemente a tela de login, escreva os testes e revise a segurança do fluxo.';

describe('hook /hook/delegate', () => {
  it('parseUserPrompt lê o prompt do payload UserPromptSubmit', () => {
    expect(parseUserPrompt({ hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBe('x');
    expect(parseUserPrompt({ prompt: '' })).toBeNull();
    expect(parseUserPrompt('lixo')).toBeNull();
  });

  it('aconselha: additionalContext curto com as partes', async () => {
    const advise = vi.fn(async () => ({ parts: 3, writers: 1, confidence: 0.8, model: 'j' }));
    const out = await handleHookDelegateRequest(operator, { prompt: LONG }, { advise });
    const text = (out.payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
    expect(out.payload.hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit' });
    expect(text).toContain('~3 partes');
    expect(text).toContain('nexus_pane_spawn');
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it('silêncio: sem conselho, sessão de missão, worker, payload inválido, exceção', async () => {
    expect((await handleHookDelegateRequest(operator, { prompt: LONG }, { advise: vi.fn(async () => null) })).payload).toEqual({});
    const advise = vi.fn(async () => ({ parts: 3, writers: 0, confidence: 0.9, model: 'j' }));
    expect((await handleHookDelegateRequest({ ...operator, missionId: 'm' }, { prompt: LONG }, { advise })).payload).toEqual({});
    expect((await handleHookDelegateRequest({ role: 'worker', sessionId: 's' }, { prompt: LONG }, { advise })).payload).toEqual({});
    expect((await handleHookDelegateRequest(operator, { nope: 1 }, { advise })).payload).toEqual({});
    expect(advise).not.toHaveBeenCalled();
    const boom = vi.fn(async () => { throw new Error('x'); });
    expect((await handleHookDelegateRequest(operator, { prompt: LONG }, { advise: boom })).payload).toEqual({});
  });

  it('formatDelegationContext conta leitura e escrita', () => {
    expect(formatDelegationContext({ parts: 4, writers: 1, confidence: 0.9, model: 'j' })).toContain(
      '3 de leitura em paralelo, 1 de escrita',
    );
  });

  describe('HTTP', () => {
    const servers: http.Server[] = [];
    afterEach(() => {
      for (const server of servers.splice(0)) server.close();
    });

    // http.request (não fetch): o servidor responde 400 ANTES de ler o corpo
    // inteiro e fecha a conexão; o cliente do node entrega a resposta mesmo
    // assim, enquanto o fetch pode ver só o reset.
    async function post(ctx: unknown, body: string): Promise<number> {
      const server = http.createServer((req, res) => {
        void handleHookDelegateHttp(req, res, ctx as never);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/hook/delegate', method: 'POST' },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    }

    it('401 sem bearer; 400 para corpo acima de 64 KB (Jev nem é chamado)', async () => {
      expect(await post(null, '{}')).toBe(401);
      expect(
        await post({ role: 'user', sessionId: 's' }, JSON.stringify({ prompt: 'x'.repeat(70_000) })),
      ).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/orch/hook-delegate-endpoint.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Extract the shared HTTP plumbing** — crie `src/main/orch/hook-http.ts` movendo `sendJson` e `readBodyCapped` de `hook-triage-endpoint.ts` (renomeados, com o limite como parâmetro) e o esqueleto 401/405/400 de `handleHookTriageHttp`:

```ts
// Encanamento HTTP comum aos hooks aditivos (/hook/triage, /hook/delegate):
// 401 sem bearer, 405 não-POST, 400 corpo grande/inválido; o resto é 200.
import type http from 'node:http';

export function sendHookJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Rejeita SEM destruir o socket para o handler ainda enviar o 400.
        reject(new Error('body-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleHookJsonPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: unknown | null,
  maxBytes: number,
  onBody: (body: unknown) => Promise<{ statusCode: number; payload: unknown }>,
): Promise<void> {
  if (!ctx) {
    sendHookJson(res, 401, { ok: false, error: 'missing or unknown bearer token' });
    return;
  }
  if (req.method !== 'POST') {
    sendHookJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  let raw: string;
  try {
    raw = await readBodyCapped(req, maxBytes);
  } catch {
    const bodyOut = JSON.stringify({ ok: false, error: 'hook payload too large' });
    res.writeHead(400, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bodyOut),
      connection: 'close',
    });
    res.end(bodyOut, () => req.destroy());
    return;
  }
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    sendHookJson(res, 400, { ok: false, error: 'invalid hook payload JSON' });
    return;
  }
  const result = await onBody(body);
  sendHookJson(res, result.statusCode, result.payload);
}
```

Em `hook-triage-endpoint.ts`, apague `sendJson` e `readBodyCapped` locais e troque o corpo de `handleHookTriageHttp` por:

```ts
  await handleHookJsonPost(req, res, ctx, HOOK_TRIAGE_MAX_BODY_BYTES, (body) =>
    handleHookTriageRequest(ctx!, body),
  );
```

(import `handleHookJsonPost` de `./hook-http`). Rode `npx vitest run src/main/orch/hook-triage-endpoint.test.ts` — tem que continuar verde.

- [ ] **Step 4: Write the endpoint** — `hook-delegate-endpoint.ts`:

```ts
// POST /hook/delegate — conselho Jev de delegação via hook `UserPromptSubmit`
// (C2, 25/09). Mesmo servidor loopback e bearer do /hook/triage. A resposta
// vira `additionalContext` do Claude. Nunca atrapalha: qualquer coisa fora do
// caminho feliz responde `{}` com 200.
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { adviseDelegation, type DelegationAdvice } from '../jev/jev-delegation';
import { handleHookJsonPost } from './hook-http';

export const HOOK_DELEGATE_MAX_BODY_BYTES = 64 * 1024;

export function parseUserPrompt(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const prompt = (body as Record<string, unknown>).prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : null;
}

/** Texto pt-BR (≤ 400 caracteres) injetado como additionalContext. */
export function formatDelegationContext(advice: DelegationAdvice): string {
  const reads = Math.max(0, advice.parts - advice.writers);
  const text =
    `[Nexus · Jev] Esta tarefa se divide em ~${advice.parts} partes ` +
    `(${reads} de leitura em paralelo, ${advice.writers} de escrita, uma por vez). ` +
    'Delegue com nexus_pane_spawn({ task, prompt }) — readOnly: true nas de ' +
    'leitura — e encerre o turno; não execute tudo sozinho.';
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

export async function handleHookDelegateRequest(
  ctx: Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId'>,
  body: unknown,
  deps: { advise?: typeof adviseDelegation } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  try {
    if (ctx.role !== 'user' || ctx.missionId) return { statusCode: 200, payload: {} };
    const prompt = parseUserPrompt(body);
    if (!prompt) return { statusCode: 200, payload: {} };
    const advise = deps.advise ?? adviseDelegation;
    const advice = await advise(prompt, { sessionId: ctx.sessionId });
    if (!advice) return { statusCode: 200, payload: {} };
    return {
      statusCode: 200,
      payload: {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: formatDelegationContext(advice),
        },
      },
    };
  } catch {
    return { statusCode: 200, payload: {} };
  }
}

export async function handleHookDelegateHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext | null,
): Promise<void> {
  await handleHookJsonPost(req, res, ctx, HOOK_DELEGATE_MAX_BODY_BYTES, (body) =>
    handleHookDelegateRequest(ctx!, body),
  );
}
```

Em `mcp-server.ts`: import `handleHookDelegateHttp`; junto de `hookTriageUrl()`:

```ts
/** UserPromptSubmit delegation advice — same loopback server/bearer. */
function hookDelegateUrl(): string {
  return `http://127.0.0.1:${port}/hook/delegate`;
}
```

no env do PTY, depois de `NEXUS_HOOK_TRIAGE_URL: hookTriageUrl(),`: `NEXUS_HOOK_DELEGATE_URL: hookDelegateUrl(),`; e na rota, depois do bloco `/hook/triage`:

```ts
      // UserPromptSubmit → conselho de delegação do Jev — aditivo, nunca bloqueia.
      if (url === "/hook/delegate" && req.method === "POST") {
        await handleHookDelegateHttp(req, res, ctx);
        return;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/hook-delegate-endpoint.test.ts src/main/orch/hook-triage-endpoint.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/orch/hook-http.ts src/main/orch/hook-delegate-endpoint.ts src/main/orch/hook-delegate-endpoint.test.ts src/main/orch/hook-triage-endpoint.ts src/main/orch/mcp-server.ts
git commit -m "feat(delegação): endpoint do hook devolve o conselho do Jev"
```

---

### Task 14: hook `UserPromptSubmit` chama `/hook/delegate` na família Claude

**Files:**
- Create: `src/main/orch/hook-delegate-command.ts`, `src/main/orch/hook-delegate-command.test.ts`
- Modify: `src/main/orch/hook-status-config.ts` (`mergeClaudeStatusHooks`)
- Test: `src/main/orch/hook-status-config.test.ts`

**Interfaces:**
- Produces: `export function makeClaudeDelegateHookCommand(platform?: NodeJS.Platform): string` — usa `$NEXUS_HOOK_DELEGATE_URL`/`$NEXUS_GATE_TOKEN`, marcador `NEXUS_HOOK_MARKER`, `--max-time 4`, termina em `|| true`.

- [ ] **Step 1: Write the failing tests**

`hook-delegate-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeClaudeDelegateHookCommand } from './hook-delegate-command';

describe('makeClaudeDelegateHookCommand', () => {
  it('posix: posta o payload, devolve a resposta e nunca falha', () => {
    const cmd = makeClaudeDelegateHookCommand('darwin');
    expect(cmd).toContain('$NEXUS_HOOK_DELEGATE_URL');
    expect(cmd).toContain('Bearer $NEXUS_GATE_TOKEN');
    expect(cmd).toContain('--data-binary @-');
    expect(cmd).toContain('--max-time 4');
    expect(cmd).not.toContain('/dev/null');
    expect(cmd.trim().endsWith('|| true')).toBe(true);
  });

  it('windows: sai calado sem URL/token', () => {
    const cmd = makeClaudeDelegateHookCommand('win32');
    expect(cmd).toContain('NEXUS_HOOK_DELEGATE_URL');
  });
});
```

Em `hook-status-config.test.ts`:

```ts
  it('UserPromptSubmit ganha o hook de delegação sem perder o de status, e é idempotente', () => {
    const once = mergeClaudeStatusHooks({});
    const twice = mergeClaudeStatusHooks(once);
    const commands = (twice.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(commands.filter((c) => c.includes('NEXUS_HOOK_DELEGATE_URL'))).toHaveLength(1);
    expect(commands.some((c) => c.includes('NEXUS_HOOK_URL'))).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/orch/hook-delegate-command.test.ts src/main/orch/hook-status-config.test.ts`
Expected: FAIL — módulo inexistente; nenhuma entrada de delegação.

- [ ] **Step 3: Write minimal implementation** — `hook-delegate-command.ts` (mesmo molde de `hook-triage-command.ts`):

```ts
// Conselho de delegação via hook Claude `UserPromptSubmit` (C2, 25/09). Como
// na triagem, a resposta do endpoint É a saída do hook (additionalContext) —
// sem `--output /dev/null`. `--max-time 4` cobre o teto de 2,5 s do Jev mais o
// atraso de retry do judge. Nunca bloqueia: `-sf … || true`.
import {
  NEXUS_HOOK_MARKER,
  makeWindowsPowerShellHookCommand,
} from '../../vendor/emdash/hooks/hook-commands';

export function makeClaudeDelegateHookCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'if (-not $env:NEXUS_HOOK_DELEGATE_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }',
      `$env:${NEXUS_HOOK_MARKER} = '1'`,
      '$payload = [Console]::In.ReadToEnd()',
      'try { $response = Invoke-WebRequest -UseBasicParsing -Method POST ' +
        '-Uri $env:NEXUS_HOOK_DELEGATE_URL ' +
        '-Headers @{ ' +
        "'Content-Type' = 'application/json'; " +
        "'authorization' = ('Bearer ' + $env:NEXUS_GATE_TOKEN) " +
        '} -Body $payload -TimeoutSec 4; ' +
        'if ($response.Content) { Write-Output $response.Content } ' +
        '} catch { exit 0 }',
    ].join('; ');
    return makeWindowsPowerShellHookCommand(script);
  }
  return (
    `${NEXUS_HOOK_MARKER}=1 curl -sf --connect-timeout 0.5 --max-time 4 ` +
    '--noproxy 127.0.0.1,localhost -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
    '--data-binary @- "$NEXUS_HOOK_DELEGATE_URL" || true'
  );
}
```

Em `mergeClaudeStatusHooks` (import `makeClaudeDelegateHookCommand`), antes do `return next;`:

```ts
  // UserPromptSubmit → POST /hook/delegate (C2): o conselho do Jev vira
  // additionalContext. O loop de status acima já removeu as entradas antigas
  // com o marker neste evento, então a reescrita por spawn segue idempotente.
  const prompt = Array.isArray(next.UserPromptSubmit) ? next.UserPromptSubmit : [];
  next.UserPromptSubmit = [
    ...prompt,
    {
      hooks: [
        { type: 'command', command: makeClaudeDelegateHookCommand(), timeout: 5 },
      ],
    },
  ];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/hook-delegate-command.test.ts src/main/orch/hook-status-config.test.ts src/main/orch/hooks-gen.test.ts`
Expected: PASS. (Se o teste de idempotência falhar porque `UserPromptSubmit` não está em `claudeHookSpecs()`, filtre explicitamente antes de anexar: `prompt.filter((entry) => !JSON.stringify(entry).includes('NEXUS_HOOK_DELEGATE_URL'))`.)

- [ ] **Step 5: Commit**

```bash
git add src/main/orch/hook-delegate-command.ts src/main/orch/hook-delegate-command.test.ts src/main/orch/hook-status-config.ts src/main/orch/hook-status-config.test.ts
git commit -m "feat(delegação): hook de mensagem pede o conselho do Jev"
```

---

### Task 15: writers delegados em fila por checkout

**Files:**
- Create: `src/main/orch/delegated-writer-gate.ts`, `src/main/orch/delegated-writer-gate.test.ts`
- Modify: `src/main/orch/tools-panes.ts` (logo depois de `options = coerceSpawnReadOnly(options, ctx.readOnly);`, ~linha 783)
- Test: `src/main/orch/tools-panes-operator-child.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DelegatedPaneFact { readonly paneId: string; readonly paneNumber?: number; readonly state: PaneRuntimeState; readonly readOnly: boolean; readonly checkoutId?: string; readonly delegated: boolean }
  export function delegatedPaneFacts(snapshots: readonly PaneSnapshot[], parentOf: (sessionId: string) => string | undefined): DelegatedPaneFact[];
  export function decideDelegatedWriterSpawn(input: { spawnReadOnly: boolean; checkoutId: string; panes: readonly DelegatedPaneFact[] }): { allowed: true } | { allowed: false; reason: string };
  ```

- [ ] **Step 1: Write the failing tests** — `delegated-writer-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideDelegatedWriterSpawn, delegatedPaneFacts, type DelegatedPaneFact } from './delegated-writer-gate';

const writer = (over: Partial<DelegatedPaneFact> = {}): DelegatedPaneFact => ({
  paneId: 'pane-w', paneNumber: 4, state: 'busy', readOnly: false, checkoutId: 'ck', delegated: true, ...over,
});

describe('decideDelegatedWriterSpawn', () => {
  it('writer × writer delegado vivo no mesmo checkout: recusa nomeando o pane', () => {
    const out = decideDelegatedWriterSpawn({ spawnReadOnly: false, checkoutId: 'ck', panes: [writer()] });
    expect(out).toEqual({
      allowed: false,
      reason: 'writer pane 4 ainda ativo — espere a entrega dele ou abra este como readOnly',
    });
  });

  it('reader sempre passa', () => {
    expect(decideDelegatedWriterSpawn({ spawnReadOnly: true, checkoutId: 'ck', panes: [writer()] })).toEqual({ allowed: true });
  });

  it('não contam: pane manual, reader, outro checkout, encerrado/estacionado/hibernado', () => {
    for (const pane of [
      writer({ delegated: false }),
      writer({ readOnly: true }),
      writer({ checkoutId: 'other' }),
      writer({ state: 'exited' }),
      writer({ state: 'parked' }),
      writer({ state: 'hibernated' }),
    ]) {
      expect(decideDelegatedWriterSpawn({ spawnReadOnly: false, checkoutId: 'ck', panes: [pane] })).toEqual({ allowed: true });
    }
  });

  it('idle e spawning ainda bloqueiam (trabalho possivelmente não entregue)', () => {
    for (const state of ['idle', 'spawning', 'unknown'] as const) {
      expect(decideDelegatedWriterSpawn({ spawnReadOnly: false, checkoutId: 'ck', panes: [writer({ state })] }).allowed).toBe(false);
    }
  });

  it('delegatedPaneFacts marca delegado quem tem pai', () => {
    const facts = delegatedPaneFacts(
      [
        { paneId: 'a', sessionId: 's-a', title: 'a', kind: 'cli-agent', state: 'busy', scope: { checkoutId: 'ck' } as never },
        { paneId: 'b', sessionId: null, title: 'b', kind: 'cli-agent', state: 'busy' },
      ],
      (sid) => (sid === 's-a' ? 'parent' : undefined),
    );
    expect(facts.map((fact) => [fact.paneId, fact.delegated, fact.checkoutId])).toEqual([
      ['a', true, 'ck'],
      ['b', false, undefined],
    ]);
  });
});
```

Em `tools-panes-operator-child.test.ts`:

```ts
  it('writer delegado ativo no checkout recusa outro writer; readOnly passa', async () => {
    harness.snapshots = [
      { paneId: 'pane-w', paneNumber: 4, sessionId: 's-w', adapterId: 'codex', state: 'busy', title: 'w', kind: 'cli-agent', scope: testProjectScope() },
    ];
    harness.parentBySession = { 's-w': 'session-user' };
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'kimi' })));
    await expect(paneSpawnTool.handler({ prompt: 'edite X' }, userPane())).rejects.toThrow(/writer pane 4 ainda ativo/);
    await paneSpawnTool.handler({ prompt: 'revise X', readOnly: true }, userPane());
    expect(harness.spawnPaneAndMaybePrompt).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/orch/delegated-writer-gate.test.ts src/main/orch/tools-panes-operator-child.test.ts -t writer`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation** — `delegated-writer-gate.ts`:

```ts
import type { PaneRuntimeState, PaneSnapshot } from '../../shared/orch-types';

/**
 * Fila de writers delegados (C3, 25/09): na mão do operador, helpers que só
 * leem rodam em paralelo; quem ESCREVE entra um por vez no mesmo checkout.
 * Panes que o operador abriu na mão não contam — isolamento entre abas é o B3.
 */
export interface DelegatedPaneFact {
  readonly paneId: string;
  readonly paneNumber?: number;
  readonly state: PaneRuntimeState;
  readonly readOnly: boolean;
  readonly checkoutId?: string;
  /** Aberto por agente do operador (tem operatorParentSessionId). */
  readonly delegated: boolean;
}

const INACTIVE: ReadonlySet<PaneRuntimeState> = new Set(['exited', 'parked', 'hibernated']);

export function delegatedPaneFacts(
  snapshots: readonly PaneSnapshot[],
  parentOf: (sessionId: string) => string | undefined,
): DelegatedPaneFact[] {
  return snapshots.map((snapshot) => ({
    paneId: snapshot.paneId,
    ...(snapshot.paneNumber !== undefined ? { paneNumber: snapshot.paneNumber } : {}),
    state: snapshot.state,
    readOnly: snapshot.readOnly === true,
    ...(snapshot.scope?.checkoutId ? { checkoutId: snapshot.scope.checkoutId } : {}),
    delegated: Boolean(snapshot.sessionId && parentOf(snapshot.sessionId)),
  }));
}

export function decideDelegatedWriterSpawn(input: {
  spawnReadOnly: boolean;
  checkoutId: string;
  panes: readonly DelegatedPaneFact[];
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.spawnReadOnly) return { allowed: true };
  const active = input.panes.find(
    (pane) =>
      pane.delegated &&
      !pane.readOnly &&
      pane.checkoutId === input.checkoutId &&
      !INACTIVE.has(pane.state),
  );
  if (!active) return { allowed: true };
  const label = active.paneNumber !== undefined ? `pane ${active.paneNumber}` : active.paneId;
  return {
    allowed: false,
    reason: `writer ${label} ainda ativo — espere a entrega dele ou abra este como readOnly`,
  };
}
```

Em `tools-panes.ts` (import de `./delegated-writer-gate`), logo depois de `options = coerceSpawnReadOnly(options, ctx.readOnly);`:

```ts
    // C3 (25/09): na mão do operador, writer delegado entra um por vez no
    // checkout; helpers de leitura seguem em paralelo.
    if (operatorHand && !options.missionId) {
      const writerDecision = decideDelegatedWriterSpawn({
        spawnReadOnly: options.readOnly === true,
        checkoutId: ctx.scope.checkoutId,
        panes: delegatedPaneFacts(
          listPaneSnapshots(),
          (sessionId) =>
            getPaneRuntimeAuthorityBySession(sessionId)?.operatorParentSessionId,
        ),
      });
      if (!writerDecision.allowed) throw new Error(writerDecision.reason);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/delegated-writer-gate.test.ts src/main/orch/tools-panes-operator-child.test.ts src/main/orch/tools-panes-user-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orch/delegated-writer-gate.ts src/main/orch/delegated-writer-gate.test.ts src/main/orch/tools-panes.ts src/main/orch/tools-panes-operator-child.test.ts
git commit -m "feat(delegação): helpers que escrevem entram um por vez no checkout"
```

---

### Task 16: helper do operador fecha sozinho no sucesso

**Files:**
- Modify: `src/main/orch/tools-panes.ts` (~linha 1167, `armAutoCloseOnHandoff`)
- Test: `src/main/orch/tools-panes-operator-child.test.ts`

**Interfaces:**
- Consumes: `armAutoCloseOnHandoff` de `./pane-close-scopes` (existente).
- Produces: comportamento — na mão do operador sem missão, `autoCloseOnHandoff` ausente vale `true`; `false` explícito é respeitado; missão inalterada.

- [ ] **Step 1: Write the failing test** — no topo de `tools-panes-operator-child.test.ts`, acrescente `armAutoCloseOnHandoff: vi.fn(),` ao `vi.hoisted` e:

```ts
vi.mock('./pane-close-scopes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-close-scopes')>()),
  armAutoCloseOnHandoff: harness.armAutoCloseOnHandoff,
}));
```

e os testes:

```ts
  it('helper do operador arma o auto-close por padrão', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex' }, userPane());
    expect(harness.armAutoCloseOnHandoff).toHaveBeenCalledWith('pty-child', 'pane-child');
  });

  it('autoCloseOnHandoff: false explícito é respeitado', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', autoCloseOnHandoff: false }, userPane());
    expect(harness.armAutoCloseOnHandoff).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/orch/tools-panes-operator-child.test.ts -t auto-close`
Expected: FAIL — hoje só arma com `true` explícito.

- [ ] **Step 3: Write minimal implementation** — troque

```ts
      if (args.autoCloseOnHandoff === true && spawned.sessionId) {
```

por

```ts
      // C3 (25/09): helper da mão do operador fecha sozinho no handoff de
      // sucesso por padrão — a aba não enche de panes que já entregaram.
      const autoClose =
        args.autoCloseOnHandoff === true ||
        (operatorHand && !options.missionId && args.autoCloseOnHandoff !== false);
      if (autoClose && spawned.sessionId) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/tools-panes-operator-child.test.ts src/main/orch/tools-panes-user-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orch/tools-panes.ts src/main/orch/tools-panes-operator-child.test.ts
git commit -m "feat(delegação): helper do operador fecha sozinho quando entrega"
```

---

### Task 17: teto de panes recusa spawn feito por agente do operador

**Files:**
- Modify: `src/main/orch/pane-admission.ts` (`admitAgentSpawnSync`, ~linha 438)
- Modify: `src/main/pty/pty-manager.ts` (~linha 1362)
- Test: `src/main/orch/pane-admission.test.ts`

**Interfaces:**
- Produces: `admitAgentSpawnSync(liveAgentPanes, now?, env?, request?: { agentRequested?: boolean })` — `agentRequested` força `hardBlocks` (teto e memória recusam). Chamadas atuais com 1–3 argumentos não mudam.

- [ ] **Step 1: Write the failing test** — em `pane-admission.test.ts`, perto dos testes de `admitAgentSpawnSync`:

```ts
  it('spawn pedido por agente do operador vira trava dura; o do renderer só avisa', () => {
    // O teto real desta máquina (env vazio), não o default: o gate lê a RAM.
    const atCap = readPaneAdmissionLimits({}).maxAgentPanes;
    const byAgent = admitAgentSpawnSync(atCap, Date.now(), {}, { agentRequested: true });
    expect(byAgent.ok).toBe(false);
    const byHand = admitAgentSpawnSync(atCap, Date.now(), {});
    expect(byHand.ok).toBe(true);
    expect(byHand.warning).toBeTruthy();
    const off = admitAgentSpawnSync(atCap, Date.now(), { NEXUS_PANE_GUARD: 'off' }, { agentRequested: true });
    expect(off.ok).toBe(true);
  });
```

(Garanta `readPaneAdmissionLimits` e `admitAgentSpawnSync` no import do teste — os dois são exportados por `pane-admission.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/orch/pane-admission.test.ts -t "agente do operador"`
Expected: FAIL — o 4º argumento é ignorado e o spawn passa com aviso.

- [ ] **Step 3: Write minimal implementation** — em `admitAgentSpawnSync`:

```ts
export function admitAgentSpawnSync(
  liveAgentPanes: number,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  request: { readonly agentRequested?: boolean } = {},
): PaneAdmissionVerdict {
  try {
    const base = readPaneAdmissionLimits(env);
    if (!base.enabled) return { ok: true };
    // C3 (25/09): delegação automática sem limite de profundidade pode abrir
    // panes em cascata (F-572: 33 panes, Mac em swap). Spawn pedido por AGENTE
    // do operador recusa no teto/pressão; o "+" do operador segue só avisando.
    const limits = request.agentRequested ? { ...base, hardBlocks: true } : base;
```

(o resto do corpo usa `limits` como hoje). Em `pty-manager.ts`:

```ts
  const admission = admitAgentSpawnSync(liveAgentPanes, Date.now(), process.env, {
    agentRequested: authority.context?.operatorParentSessionId !== undefined,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/orch/pane-admission.test.ts src/main/pty/pty-manager.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orch/pane-admission.ts src/main/orch/pane-admission.test.ts src/main/pty/pty-manager.ts
git commit -m "feat(delegação): teto de panes freia cascata aberta por agente"
```

---

### Task 18: Codex — provar ou descartar o conselho por mensagem

**Files:**
- Modify (só se a prova passar): `src/main/orch/hook-status-config.ts` (`codexStatusHookArgs`), `src/main/orch/hook-status-config.test.ts`
- Modify (se não passar): `docs/superpowers/specs/2026-09-25-delegacao-automatica-design.md`

**Interfaces:** nenhuma nova; decide se `codexStatusHookArgs` ganha a entrada de delegação.

- [ ] **Step 1: Provar com a CLI real** — num diretório temporário do scratchpad, com Codex logado:

```bash
TMP=$(mktemp -d)
cat > "$TMP/hook.sh" <<'EOF'
#!/bin/sh
cat >/dev/null
printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"MARCADOR-NEXUS-42: responda exatamente com a palavra BANANA."}}'
EOF
chmod +x "$TMP/hook.sh"
codex exec -c "hooks.UserPromptSubmit=[{hooks=[{type=\"command\",command=\"$TMP/hook.sh\"}]}]" "Diga olá." 2>&1 | tail -5
```

Expected para "provado": a resposta contém `BANANA`.

- [ ] **Step 2a (provado): wire it** — em `codexStatusHookArgs`, a chave `UserPromptSubmit` precisa carregar os DOIS comandos no mesmo array (um `-c` por chave sobrescreve). Monte o array de hooks por chave antes de serializar:

```ts
export function codexStatusHookArgs(): string[] {
  const byKey = new Map<string, string[]>();
  for (const spec of codexHookSpecs()) {
    byKey.set(spec.hookKey, [...(byKey.get(spec.hookKey) ?? []), spec.command]);
  }
  byKey.set('UserPromptSubmit', [
    ...(byKey.get('UserPromptSubmit') ?? []),
    makeClaudeDelegateHookCommand(),
  ]);
  const args: string[] = [];
  for (const [hookKey, commands] of byKey) {
    const hooks = commands
      .map((command) => `{type="command",command=${tomlBasicString(command)}}`)
      .join(',');
    args.push('-c', `hooks.${hookKey}=[{hooks=[${hooks}]}]`);
  }
  return args;
}
```

e o teste:

```ts
  it('codex: UserPromptSubmit carrega status e delegação no mesmo -c', () => {
    const args = codexStatusHookArgs();
    const prompt = args.find((arg) => arg.startsWith('hooks.UserPromptSubmit='))!;
    expect(prompt).toContain('NEXUS_HOOK_DELEGATE_URL');
    expect(args.filter((arg) => arg.startsWith('hooks.UserPromptSubmit='))).toHaveLength(1);
  });
```

Run: `npx vitest run src/main/orch/hook-status-config.test.ts` → PASS. Commit:

```bash
git add src/main/orch/hook-status-config.ts src/main/orch/hook-status-config.test.ts
git commit -m "feat(delegação): Codex também recebe o conselho do Jev por mensagem"
```

- [ ] **Step 2b (não provado): registrar** — na spec C, seção C2, troque "**Codex** entra só se…" por "**Codex**: testado em <data> com a CLI <versão>; o `UserPromptSubmit` não injeta `additionalContext`. Fica só com a doutrina (C1)." Commit:

```bash
git add docs/superpowers/specs/2026-09-25-delegacao-automatica-design.md
git commit -m "docs(spec): Codex fica só com a doutrina de delegação"
```

---

### Task 19: verificação final

**Files:** nenhum código novo.

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 2: Testes afetados**

Run: `npm run test:changed`
Expected: PASS. Se algum teste fora dos listados quebrar, leia a falha: é regressão real (corrija o código) ou um teste que fixava o comportamento antigo do `adapterId` explícito na mão do operador (atualize, citando a decisão de 25/09 no nome do teste).

- [ ] **Step 3: Sinks do renderer (payload de IPC mudou)**

Run: `npm run security:renderer-sinks`
Expected: sem achado novo.

- [ ] **Step 4: Prova no app** — `npm run start`, abra um pane Claude pelo "+" numa aba "Feature B" e peça: "abra dois helpers: um revisa o README, outro lista os testes lentos". Confirme:
  - os helpers nascem na aba "Feature B" (não em "Terminais");
  - cada cabeçalho mostra o chip "Jev" (ou "sem Jev" + toast único se a chave for removida);
  - `nexus_route_log` lista as duas decisões com `classifierSource`;
  - um helper que entrega com sucesso fecha sozinho;
  - uma mensagem longa e divisível mostra o `[Nexus · Jev] Esta tarefa se divide…` no contexto do Claude.

Anote o que não bateu e corrija antes de declarar pronto.
