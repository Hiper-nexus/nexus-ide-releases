# Rotação proativa de contas — plano de implementação

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use
> superpowers:subagent-driven-development (recomendado) ou
> superpowers:executing-plans para implementar tarefa a tarefa. Os passos usam
> checkbox (`- [ ]`).

**Goal:** fazer o Nexus tirar o trabalho de uma conta ANTES de ela esgotar,
passando para a próxima sem interromper a missão.

**Architecture:** três camadas sobre o motor que já existe. O núcleo puro
(`account-headroom.ts`) ganha o conceito de *drenando* (folga abaixo do
limiar), com a decisão amarrada a leitura `provider-api` fresca.
`chooseAccount` passa a preferir quem não está drenando; `pickAvailableForFailover`
liga isso ao store. Um vigia no `delegation-supervisor` cobre o pane longo que
esgota no meio. O estado terminal (todas as contas esgotadas → outra CLI) já
existe e não é tocado.

**Tech Stack:** TypeScript, Electron main, vitest. Sem dependência nova.

**Spec:** [docs/superpowers/specs/2026-10-19-rotacao-proativa-contas-design.md](../specs/2026-10-19-rotacao-proativa-contas-design.md)

## Global Constraints

- Limiar de drenagem: **0.89** (`usedRatio >= 0.89` → drenando). Constante
  exportada, override por env, sem UI na v1.
- `account-headroom.ts` e `account-select.ts` **continuam puros**: sem I/O,
  sem relógio implícito (o `now` entra por parâmetro).
- Só leitura `source: 'provider-api'` autoriza drenar. `transcript-inferred`,
  `local-tokens`, `limit-hit`, `cooldown` e `unknown` nunca drenam.
- Só leitura fresca autoriza drenar: idade máxima **10 min**, o mesmo
  `REFUTE_FRESH_MS` que o caminho reativo já usa.
- **O gatilho exige leitura da conta ATIVA; o destino não precisa de leitura.**
  Em contas AGY as irmãs nunca têm leitura (403 no endpoint direto) — exigir
  uma significaria nunca rotacionar. A proteção contra cascata está no gatilho.
- Nenhum token, fingerprint ou e-mail em recibo, trace ou log. `maskAccountLabel`.
- Toda decisão sai no trace `account-failover`, com motivo.
- Co-located tests: `foo.ts` → `foo.test.ts` no mesmo diretório.
- `npm run typecheck` depois de cada tarefa.

### Simplificação apurada ao mapear o código

O desenho (§7.0) previa um "modo A / modo B" explícito. **Não é preciso flag.**
Em mode-B (AGY) as irmãs não têm linha de cota, `compareAccountHeadroom`
devolve empate e `chooseAccount` já cai no desempate por `createdAt` — fila
ordenada emerge do código existente. As tarefas abaixo não criam modo nenhum.

## Review Focus

Classes de entrada que a spec implica e que nenhum caminho feliz exercita.
Cada uma tem teste na tarefa que é dona do código.

1. **Leitura não-`provider-api` com `usedRatio >= 0.89`** (ex.: `local-tokens`
   estimada do transcript) não pode drenar conta saudável — Tarefa 1.
2. **Leitura da conta ativa mais velha que 10 min** (serviço de cota fora do
   ar) não pode drenar: dado obsoleto não é prova — Tarefa 1.
3. **Todas as contas drenando** deve voltar a escolher entre elas (segunda
   volta do carrossel), nunca devolver `null` e travar a missão — Tarefa 3.
4. **Pane ocioso porque TERMINOU** não pode receber pacote de continuidade: a
   camada 2 inventaria trabalho — Tarefa 6.
5. **`usedRatio: null`** (janela desconhecida) não é 89% e não drena — Tarefa 1.

---

### Task 1: Núcleo puro — `source`, idade e o limiar de drenagem

**Files:**
- Modify: `src/main/quota/account-headroom.ts`
- Test: `src/main/quota/account-headroom.test.ts`

**Interfaces:**
- Consumes: `QuotaWindow`, `QuotaSource` de `src/shared/quota-types.ts`.
- Produces:
  - `export const DRAIN_THRESHOLD = 0.89`
  - `HeadroomInput['windows'][number]` passa a incluir `readonly source?: QuotaSource`
  - `export interface DrainEvidence { readonly requireSource?: QuotaSource; readonly maxAgeMs?: number; readonly now: number }`
  - `export function isHeadroomDraining(input: HeadroomInput | undefined, threshold: number, evidence: DrainEvidence): boolean`

- [ ] **Step 1: Escrever os testes que falham**

```ts
const WIN = (o: Partial<HeadroomInput['windows'][number]>) =>
  ({ label: '5 Horas', kind: 'hours', usedRatio: 0.9, source: 'provider-api', ...o });
const EV = { requireSource: 'provider-api' as const, maxAgeMs: 600_000, now: 1_000_000 };

it('drena com leitura provider-api fresca acima do limiar', () => {
  const input = { windows: [WIN({})], updatedAt: EV.now - 60_000 };
  expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(true);
});

it('não drena abaixo do limiar', () => {
  const input = { windows: [WIN({ usedRatio: 0.88 })], updatedAt: EV.now - 60_000 };
  expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
});

// Review Focus 1
it('não drena por leitura que não é do provider', () => {
  const input = { windows: [WIN({ source: 'local-tokens' })], updatedAt: EV.now - 60_000 };
  expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
});

// Review Focus 2
it('não drena por leitura mais velha que maxAgeMs', () => {
  const input = { windows: [WIN({})], updatedAt: EV.now - 600_001 };
  expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
});

it('não drena sem updatedAt: idade desconhecida não é leitura fresca', () => {
  expect(isHeadroomDraining({ windows: [WIN({})] }, DRAIN_THRESHOLD, EV)).toBe(false);
});

// Review Focus 5
it('usedRatio null não drena', () => {
  const input = { windows: [WIN({ usedRatio: null })], updatedAt: EV.now - 60_000 };
  expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
});

it('a janela mais apertada decide', () => {
  const input = {
    windows: [WIN({ kind: 'weekly', label: 'Semanal', usedRatio: 0.1 }), WIN({})],
    updatedAt: EV.now - 60_000,
  };
  expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(true);
});

it('esgotada também conta como drenando', () => {
  const input = { windows: [WIN({ usedRatio: 1 })], updatedAt: EV.now - 60_000 };
  expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(true);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/quota/account-headroom.test.ts`
Expected: FAIL — `isHeadroomDraining is not a function`

- [ ] **Step 3: Implementar em `src/main/quota/account-headroom.ts`**

Acrescentar `readonly source?: QuotaSource` ao `Pick` de `HeadroomInput['windows']`
(o campo já existe em `QuotaWindow`; hoje é descartado). Implementar
`isHeadroomDraining` reusando `headroomReadings` para o colapso por janela, e
devolvendo `false` quando a evidência não passa. Manter o módulo puro: `now`
vem de `DrainEvidence`, nunca de `Date.now()`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/quota/account-headroom.test.ts`
Expected: PASS, incluindo os testes que já existiam.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add src/main/quota/account-headroom.ts src/main/quota/account-headroom.test.ts
git commit -m "feat(quota): limiar de drenagem com evidência de fonte e idade"
```

---

### Task 2: Núcleo puro — drenagem dimensionada por rota

**Files:**
- Create: `src/main/quota/headroom-route-filter.ts`
- Test: `src/main/quota/headroom-route-filter.test.ts`

**Interfaces:**
- Consumes: `HeadroomInput` da Tarefa 1.
- Produces:
  - `export function windowsServingModel(input: HeadroomInput, model: string | null): HeadroomInput`

**Contexto:** `agy-bridge.ts:265` registra que o AGY devolve
"Gemini × (5h|semanal), Claude/GPT × (5h|semanal)", e `windowsFromGroup`
(linha 341) prefixa o rótulo com o nome do grupo: `"Gemini · 5 Horas"`. Sem
filtro, um bucket Claude/GPT cheio drena uma conta que serve um pane Gemini.

- [ ] **Step 1: Escrever os testes que falham**

```ts
const GEMINI = { label: 'Gemini · 5 Horas', kind: 'hours', usedRatio: 0.1, source: 'provider-api' };
const THIRD  = { label: 'Claude/GPT · 5 Horas', kind: 'hours', usedRatio: 1, source: 'provider-api' };

it('mantém só os buckets que o modelo consome', () => {
  const out = windowsServingModel({ windows: [GEMINI, THIRD] }, 'gemini-3.8-flash-high');
  expect(out.windows).toEqual([GEMINI]);
});

it('modelo desconhecido recua para todos os buckets (conservador)', () => {
  const out = windowsServingModel({ windows: [GEMINI, THIRD] }, 'modelo-que-ninguem-conhece');
  expect(out.windows).toEqual([GEMINI, THIRD]);
});

it('model null recua para todos os buckets', () => {
  const out = windowsServingModel({ windows: [GEMINI, THIRD] }, null);
  expect(out.windows).toEqual([GEMINI, THIRD]);
});

it('rótulo sem prefixo de grupo é sempre mantido', () => {
  const plain = { label: '5 Horas', kind: 'hours', usedRatio: 0.5, source: 'provider-api' };
  expect(windowsServingModel({ windows: [plain] }, 'gemini-3.8-flash-high').windows).toEqual([plain]);
});

it('preserva onCooldown e updatedAt', () => {
  const input = { windows: [GEMINI, THIRD], onCooldown: true, updatedAt: 42 };
  const out = windowsServingModel(input, 'gemini-3.8-flash-high');
  expect(out.onCooldown).toBe(true);
  expect(out.updatedAt).toBe(42);
});

it('filtrar tudo recua para o input original, nunca devolve vazio', () => {
  const out = windowsServingModel({ windows: [THIRD] }, 'gemini-3.8-flash-high');
  expect(out.windows).toEqual([THIRD]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/quota/headroom-route-filter.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `windowsServingModel`**

Um mapa de prefixo de grupo → predicado sobre o id do modelo (`Gemini` casa
`gemini*`; `Claude/GPT` casa `claude*`/`gpt*`/`o[0-9]*`). Regra de recuo, nesta
ordem: rótulo sem prefixo conhecido → mantém; modelo nulo ou que não casa com
nenhum prefixo → devolve o input inteiro; filtro que esvaziaria a lista →
devolve o input inteiro. Todo recuo é para o comportamento de hoje (pior
bucket): no máximo drena cedo, nunca tarde.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/quota/headroom-route-filter.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add src/main/quota/headroom-route-filter.ts src/main/quota/headroom-route-filter.test.ts
git commit -m "feat(quota): drenagem considera só os buckets que o modelo consome"
```

---

### Task 3: `chooseAccount` prefere quem não está drenando

**Files:**
- Modify: `src/main/persistence/account-select.ts`
- Test: `src/main/persistence/account-select.test.ts`

**Interfaces:**
- Consumes: `isHeadroomDraining`, `DRAIN_THRESHOLD`, `DrainEvidence` (Tarefa 1).
- Produces: `chooseAccount` ganha um 7º parâmetro opcional
  `drain?: DrainEvidence`. Ausente = comportamento de hoje, byte a byte.

- [ ] **Step 1: Escrever os testes que falham**

```ts
// mode B (AGY): a ativa tem leitura, as irmãs não têm nenhuma
it('ativa drenando cede para a irmã mais velha quando nenhuma irmã tem leitura', () => {
  const chosen = chooseAccount([a, b, c], a.id, null, NOW, undefined, mapOf({
    [a.id]: { windows: [W(0.9)], updatedAt: NOW - 60_000 },
  }), EV);
  expect(chosen?.id).toBe(b.id); // b.createdAt < c.createdAt
});

it('ativa abaixo do limiar fica', () => {
  const chosen = chooseAccount([a, b], a.id, null, NOW, undefined, mapOf({
    [a.id]: { windows: [W(0.88)], updatedAt: NOW - 60_000 },
  }), EV);
  expect(chosen?.id).toBe(a.id);
});

// Review Focus 3
it('todas drenando: escolhe entre elas, nunca devolve null', () => {
  const quota = mapOf({
    [a.id]: { windows: [W(0.95)], updatedAt: NOW - 60_000 },
    [b.id]: { windows: [W(0.91)], updatedAt: NOW - 60_000 },
  });
  const chosen = chooseAccount([a, b], a.id, null, NOW, undefined, quota, EV);
  expect(chosen).not.toBeNull();
});

it('sem drain evidence o comportamento é o de hoje', () => {
  const quota = mapOf({ [a.id]: { windows: [W(0.9)], updatedAt: NOW - 60_000 } });
  expect(chooseAccount([a, b], a.id, null, NOW, undefined, quota)?.id).toBe(a.id);
});

it('conta única drenando continua escolhida', () => {
  const quota = mapOf({ [a.id]: { windows: [W(0.95)], updatedAt: NOW - 60_000 } });
  expect(chooseAccount([a], a.id, null, NOW, undefined, quota, EV)?.id).toBe(a.id);
});

it('irmã esgotada não recebe o pane mesmo com a ativa drenando', () => {
  const quota = mapOf({
    [a.id]: { windows: [W(0.9)], updatedAt: NOW - 60_000 },
    [b.id]: { windows: [W(1)], updatedAt: NOW - 60_000 },
  });
  expect(chooseAccount([a, b, c], a.id, null, NOW, undefined, quota, EV)?.id).toBe(c.id);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/persistence/account-select.test.ts`
Expected: FAIL nos casos novos; os antigos continuam passando.

- [ ] **Step 3: Implementar em `chooseByWindows`**

Quando `drain` está presente e a ativa está drenando, a ativa perde para a
primeira candidata do `ranked` que não esteja drenando. Se nenhuma candidata
escapar da drenagem, a regra de hoje decide (segunda volta do carrossel: o
resto da janela é consumido em vez de desperdiçado). Manter o módulo puro.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/persistence/account-select.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add src/main/persistence/account-select.ts src/main/persistence/account-select.test.ts
git commit -m "feat(accounts): conta drenando perde o trabalho novo para a irmã"
```

---

### Task 4: `pickAvailableForFailover` entrega a evidência de drenagem

**Files:**
- Modify: `src/main/persistence/account-store.ts:1344-1380`
- Test: `src/main/persistence/account-store.test.ts`

**Interfaces:**
- Consumes: `chooseAccount(..., drain?)` (Tarefa 3), `windowsServingModel` (Tarefa 2).
- Produces: `FailoverPickOptions` ganha `readonly drain?: DrainEvidence` e
  `readonly model?: string | null`. `FailoverPick` ganha
  `readonly drained?: boolean` (a ativa saiu por drenagem, não por esgotamento)
  — é o que o recibo e o trace usam para dizer o motivo.

- [ ] **Step 1: Escrever os testes que falham**

```ts
it('repassa a evidência e devolve drained quando a ativa estava drenando', () => {
  // ativa em 0.9 com leitura fresca provider-api, irmã sem leitura
  const pick = pickAvailableForFailover('agy', null, NOW, undefined, {
    quotaByAccountId: quota, drain: EV,
  });
  expect(pick.account?.id).toBe(sibling.id);
  expect(pick.drained).toBe(true);
});

it('sem drain nas options nada muda', () => {
  const pick = pickAvailableForFailover('agy', null, NOW, undefined, { quotaByAccountId: quota });
  expect(pick.account?.id).toBe(active.id);
  expect(pick.drained).toBeUndefined();
});

it('model filtra os buckets antes de decidir a drenagem', () => {
  // ativa: bucket Gemini 10%, bucket Claude/GPT 100%
  const pick = pickAvailableForFailover('agy', null, NOW, undefined, {
    quotaByAccountId: bucketQuota, drain: EV, model: 'gemini-3.8-flash-high',
  });
  expect(pick.account?.id).toBe(active.id);
  expect(pick.drained).toBeFalsy();
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/persistence/account-store.test.ts`
Expected: FAIL — `drain` não existe em `FailoverPickOptions`.

- [ ] **Step 3: Implementar**

Aplicar `windowsServingModel(input, options.model ?? null)` a cada entrada de
`options.quotaByAccountId` antes de repassar, e passar `options.drain` adiante
para `chooseAccount`. `drained` é verdadeiro quando havia ativa, ela estava
drenando e a escolhida é outra.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/persistence/account-store.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add src/main/persistence/account-store.ts src/main/persistence/account-store.test.ts
git commit -m "feat(accounts): pickAvailableForFailover aceita evidência de drenagem"
```

---

### Task 5: Camada 1 — o spawn passa a drenar

**Files:**
- Modify: `src/main/persistence/provider-config-store.ts:1760-1850`
- Test: `src/main/persistence/provider-config-spawn.test.ts`

**Interfaces:**
- Consumes: `pickAvailableForFailover(..., { drain, model })` (Tarefa 4).
- Produces: o recibo da escolha de conta ganha `reason: 'drained'` quando a
  anterior saiu por drenagem. Rótulos seguem mascarados (`maskAccountLabel`).

- [ ] **Step 1: Escrever os testes que falham**

```ts
// ativa `a` com leitura provider-api fresca em 0.9; irmã `b` sem leitura
it('o spawn seguinte nasce na irmã quando a ativa está drenando', async () => {
  const spawn = await prepareProviderSpawn({ adapterId: 'agy', model: 'gemini-3.8-flash-high' });
  expect(spawn.account.id).toBe(b.id);
});

it('o recibo diz drained, com o rótulo mascarado', async () => {
  const spawn = await prepareProviderSpawn({ adapterId: 'agy', model: 'gemini-3.8-flash-high' });
  expect(spawn.receipt.reason).toBe('drained');
  expect(spawn.receipt.account.label).toBe(maskAccountLabel(b.label));
  expect(JSON.stringify(spawn.receipt)).not.toContain(b.id);
});

// §8.9: pin é escolha explícita do operador, drenagem é inferência
it('conta fixada ignora a drenagem', async () => {
  const spawn = await prepareProviderSpawn({ adapterId: 'agy', accountId: a.id });
  expect(spawn.account.id).toBe(a.id);
  expect(spawn.receipt.source).toBe('pinned');
});

// §8.9: no respawn do Maestro já não há conversa a preservar
it('o Maestro respeita a drenagem no respawn', () => {
  expect(pickMissionOrchestratorAccountId('agy', a.id)).toBe(b.id);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/persistence/provider-config-spawn.test.ts`

- [ ] **Step 3: Implementar**

Montar a `DrainEvidence` (`requireSource: 'provider-api'`, `maxAgeMs` =
`REFUTE_FRESH_MS`, `now`) e passá-la, com o modelo do spawn, nas chamadas de
`pickAvailableForFailover`. **Não** passar em `preparedAccount` (o atalho de
conta fixada, linha 1713). **Passar** em `pickMissionOrchestratorAccountId`
(linha 1810).

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/persistence/provider-config-spawn.test.ts`

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add src/main/persistence/provider-config-store.ts src/main/persistence/provider-config-spawn.test.ts
git commit -m "feat(spawn): trabalho novo evita conta drenando (camada 1)"
```

---

### Task 6: Camada 2 — vigia de troca a quente com prova de trabalho pendente

**Files:**
- Create: `src/main/orch/drain-watchdog.ts`
- Test: `src/main/orch/drain-watchdog.test.ts`
- Modify: `src/main/orch/delegation-supervisor.ts:2463` (chamar no `reconcile`)

**Interfaces:**
- Consumes: `isHeadroomExhausted` (a camada 2 só atende esgotamento; a
  drenagem é da camada 1), `switchRendererOrchestratorAccount`
  (`failover-orchestrator-respawn.ts:119`).
- Produces: `export function decideDrainSwap(input: { paneId: string; accountId: string; headroom: HeadroomInput | undefined; hasPendingWork: boolean; lastSwapAt: number | null; now: number }): { swap: boolean; reason: string }`
  — função **pura**; o efeito fica no `delegation-supervisor`.

- [ ] **Step 1: Escrever os testes que falham**

```ts
it('troca quando a conta esgotou e há trabalho pendente', () => {
  expect(decideDrainSwap({ ...base, headroom: full, hasPendingWork: true }).swap).toBe(true);
});

// Review Focus 4
it('NÃO troca pane ocioso sem trabalho pendente', () => {
  const d = decideDrainSwap({ ...base, headroom: full, hasPendingWork: false });
  expect(d.swap).toBe(false);
  expect(d.reason).toMatch(/sem trabalho pendente/);
});

it('não troca por drenagem: a camada 2 só atende esgotamento', () => {
  expect(decideDrainSwap({ ...base, headroom: draining, hasPendingWork: true }).swap).toBe(false);
});

it('respeita o teto: uma troca por pane por hora', () => {
  const d = decideDrainSwap({ ...base, headroom: full, hasPendingWork: true, lastSwapAt: base.now - 59 * 60_000 });
  expect(d.swap).toBe(false);
});

it('sem leitura nenhuma não troca', () => {
  expect(decideDrainSwap({ ...base, headroom: undefined, hasPendingWork: true }).swap).toBe(false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/orch/drain-watchdog.test.ts`

- [ ] **Step 3: Implementar `decideDrainSwap` e ligá-la ao supervisor**

A função pura decide. No `reconcileDelegationSupervisor`, para cada pane de
missão vivo, montar o input (`hasPendingWork` vem do ledger de handoffs —
`pendingDeliverableHandoffs`, linha 469) e, com `swap: true`, chamar
`switchRendererOrchestratorAccount`. `switched: true` só depois do religamento
real (F-995). Teto de uma troca por pane por hora, conforme §8.4 da spec.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/orch/drain-watchdog.test.ts src/main/orch/delegation-supervisor.test.ts`

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add src/main/orch/drain-watchdog.ts src/main/orch/drain-watchdog.test.ts src/main/orch/delegation-supervisor.ts
git commit -m "feat(orch): troca a quente quando a conta do pane esgota (camada 2)"
```

---

### Task 7: Camada 3.2 — o silêncio do AGY conta como limite

**Files:**
- Modify: `src/main/orch/failover.ts` (perto de `quotaHeadroomFor`, linha 715)
- Test: `src/main/orch/failover-agy-silence.test.ts` (criar)

**Interfaces:**
- Consumes: `quotaHeadroomFor` (failover.ts:715), `isHeadroomExhausted`.
- Produces: nenhum export novo. O caminho existente de `performSwitch` é
  reusado; o `LimitHit` passa a poder nascer da medição.

**Contexto:** é o caso do relato. A CLI do AGY emudece sem imprimir erro, então
nenhum padrão de texto dispara. A prova aqui é a API do provedor, não o
terminal — por isso não fere o F-249.

- [ ] **Step 1: Escrever os testes que falham**

```ts
const silent = { paneId: 'p1', adapterId: 'agy', idle: true, accountId: a.id };

it('pane AGY ocioso com conta medida esgotada vira LimitHit confirmado', async () => {
  setQuota(a.id, { windows: [W(1, 'provider-api')], updatedAt: NOW - 60_000 });
  await reconcileDelegationSupervisor(NOW);
  expect(h.trace).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'account-failover', fromAccountId: a.id,
  }));
});

it('pane AGY ocioso com conta medida COM FOLGA não vira limite', async () => {
  setQuota(a.id, { windows: [W(0.3, 'provider-api')], updatedAt: NOW - 60_000 });
  await reconcileDelegationSupervisor(NOW);
  expect(h.respawnMainOwned).not.toHaveBeenCalled();
});

it('pane AGY ocioso sem leitura de cota não vira limite', async () => {
  setQuota(a.id, undefined);
  await reconcileDelegationSupervisor(NOW);
  expect(h.respawnMainOwned).not.toHaveBeenCalled();
});

it('leitura que não é provider-api não vira limite', async () => {
  setQuota(a.id, { windows: [W(1, 'local-tokens')], updatedAt: NOW - 60_000 });
  await reconcileDelegationSupervisor(NOW);
  expect(h.respawnMainOwned).not.toHaveBeenCalled();
});

it('pane ATIVO (transmitindo) não é julgado pelo silêncio', async () => {
  setPane({ ...silent, idle: false });
  setQuota(a.id, { windows: [W(1, 'provider-api')], updatedAt: NOW - 60_000 });
  await reconcileDelegationSupervisor(NOW);
  expect(h.respawnMainOwned).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/orch/failover-agy-silence.test.ts`

- [ ] **Step 3: Implementar**

No laço do supervisor, pane de missão ocioso cuja conta tem leitura
`provider-api` fresca e esgotada gera um `LimitHit` com
`kind: 'quota'` e `confirmedAt` preenchido (a medição É a confirmação), que
entra no `performSwitch` existente. Sem leitura, sem leitura fresca, ou com
folga: nada acontece.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/orch/failover-agy-silence.test.ts src/main/orch/failover.test.ts`

- [ ] **Step 5: Typecheck, suíte de failover e commit**

```bash
npm run typecheck
npx vitest run src/main/orch/failover
git add src/main/orch/failover.ts src/main/orch/failover-agy-silence.test.ts
git commit -m "feat(failover): AGY que emudece com cota esgotada troca de conta"
```

---

### Task 8: Sonda direcionada da conta ativa

**Files:**
- Modify: `src/main/quota/quota-service.ts:923`
- Test: `src/main/quota/quota-service.test.ts`

**Interfaces:**
- Produces: `async refreshAccount(adapterId: string, accountId: string | null): Promise<QuotaFleetSnapshot>`

**Contexto:** hoje só existe `refresh()` da frota inteira, e o comentário de
`QUOTA_PROBE_CONCURRENCY` (linha 79-86) registra que várias sondas abrem um
processo de CLI por conta — a 1 min, com 7 contas, isso trava a máquina. No
modo B só a conta ativa precisa de cadência rápida.

- [ ] **Step 1: Escrever os testes que falham**

```ts
it('sonda só a conta pedida, não a frota', async () => {
  await service.refreshAccount('agy', a.id);
  expect(probeSpy).toHaveBeenCalledTimes(1);
  expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ accountId: a.id }));
});

it('respeita o TTL de 60 s por linha', async () => {
  await service.refreshAccount('agy', a.id);
  clock.advance(59_000);
  await service.refreshAccount('agy', a.id);
  expect(probeSpy).toHaveBeenCalledTimes(1);
});

it('respeita o backoff da linha', async () => {
  setBackoff(a.id, NOW + 300_000);
  await service.refreshAccount('agy', a.id);
  expect(probeSpy).not.toHaveBeenCalled();
});

it('falha da sonda não derruba o snapshot', async () => {
  probeSpy.mockRejectedValueOnce(new Error('boom'));
  const snap = await service.refreshAccount('agy', a.id);
  expect(snap.entries).toBeDefined();
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/quota/quota-service.test.ts`

- [ ] **Step 3: Implementar `refreshAccount`**

Reusar o caminho de `refresh()` restringindo o conjunto de linhas a sondar.
Manter TTL, backoff e `QUOTA_PROBE_CONCURRENCY` intactos.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/main/quota/quota-service.test.ts`

- [ ] **Step 5: Ligar à cadência e commit**

Em `mission-quota-poll.ts`, acelerar para 1 min **somente** a conta ativa
quando a última leitura dela passar de `QUOTA_HIGH_USAGE_THRESHOLD` (0.8); a
frota segue em 5 min.

```bash
npm run typecheck
git add src/main/quota/quota-service.ts src/main/quota/quota-service.test.ts src/main/quota/mission-quota-poll.ts src/main/quota/mission-quota-poll.test.ts
git commit -m "feat(quota): sonda direcionada e cadência rápida perto do limiar"
```

---

### Task 9: Prova de ponta a ponta

**Files:**
- Create: `src/main/orch/__tests__/account-rotation-e2e.test.ts`

- [ ] **Step 1: Escrever o teste**

Três contas AGY (`a`, `b`, `c` por `createdAt`), só a ativa com leitura.

```ts
it('drena a, depois b, depois c, e então muda de CLI', async () => {
  const live = await spawn('agy');                 // nasce em a
  expect(live.account.id).toBe(a.id);

  setQuota(a.id, { windows: [W(0.9, 'provider-api')], updatedAt: NOW - 60_000 });
  expect((await spawn('agy')).account.id).toBe(b.id);
  expect(paneAccountOf(live.paneId)).toBe(a.id);   // o pane vivo não foi tocado

  setQuota(b.id, { windows: [W(0.9, 'provider-api')], updatedAt: NOW - 60_000 });
  expect((await spawn('agy')).account.id).toBe(c.id);

  for (const id of [a.id, b.id, c.id]) {
    setQuota(id, { windows: [W(1, 'provider-api')], updatedAt: NOW - 60_000 });
  }
  await reconcileDelegationSupervisor(NOW);
  expect(h.trace).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'cli-switch-requested' }),
  );
});

it('a segunda volta do carrossel consome o resto da janela', async () => {
  for (const id of [a.id, b.id, c.id]) {
    setQuota(id, { windows: [W(0.9, 'provider-api')], updatedAt: NOW - 60_000 });
  }
  expect((await spawn('agy')).account.id).toBe(a.id); // todas drenando → volta para a
});
```

- [ ] **Step 2: Rodar e ver falhar, depois passar**

Run: `npx vitest run src/main/orch/__tests__/account-rotation-e2e.test.ts`

- [ ] **Step 3: Suíte completa, lint e commit**

```bash
npm run typecheck && npm run lint && npx vitest run src/main/quota src/main/persistence src/main/orch
git add src/main/orch/__tests__/account-rotation-e2e.test.ts
git commit -m "test: rotação de contas de ponta a ponta até a troca de CLI"
```

---

## Fora deste plano

- **Troca de CLI no esgotamento total** — já existe (F-775 item 2, spec §7.4).
- **Padrão de texto de limite do AGY** (camada 3.1) — depende de colher a
  string real de um AGY esgotado (spec §9.1). A Tarefa 7 cobre o caso relatado
  sem ela.
- **Tela de Ajustes para o limiar** — constante com env na v1 (spec §8.5b).
- **Reserva de conta para o Maestro** — spec §8.8, revisitar com medição.
