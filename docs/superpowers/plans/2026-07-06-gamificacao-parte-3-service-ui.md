# Gamificação Power-Scaling — Plan (Parte 3/3: service, IPC, UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Sequência: Parte 1 `2026-07-06-gamificacao-parte-1-regras-engine.md` e Parte 2 `2026-07-06-gamificacao-parte-2-streak-store.md` são PRÉ-REQUISITOS.
> **Global Constraints:** ver Parte 1 (valem aqui integralmente).

**Goal:** Borda completa: service read-model (eventos reais → XP → broadcast/narração/retro), IPC + preload + modo sóbrio, mascote pixel programático, HUD e tela Perfil de Operador.

**Architecture:** `gamification-service` assina `onHandoffsChange`/`onMissionsChange`/`onTasksChange` + tap de mídia; resolve evidência/effort/custo; usa engine+store (Partes 1–2); broadcast coalescido (padrão `usage-service`); narração via canal `'voice:narrate'`. Renderer espelha snapshot via zustand (padrão `usage-store` do renderer).

**Tech Stack:** TypeScript, Electron, React, zustand, vitest.

## Interfaces existentes consumidas (verificadas no repo)

- `handoff-store`: `onHandoffsChange(cb): () => void`; `listHandoffs({includeDelivered:true}): Handoff[]` — `Handoff {id, missionId?, fromAgent?, status, summary, artifacts: unknown[], createdAt}`; `initHandoffStore(db)` p/ teste.
- `mission-store`: `onMissionsChange(cb)`; `listMissions(): Mission[]` — `Mission {id, title, status, squadId?, createdAt, updatedAt}`; `initMissionStore(db)`.
- `task-store`: `onTasksChange(cb)`; `listTasks(): TaskRecord[]`; `initTaskStore(db)`.
- `mission-pane-store`: `listMissionPanes(missionId): MissionPaneSpec[]` (`effort?: string`, `agentName?`, `role`).
- `squad-store`: `findAgent(ref): {squad, agent} | null` (`agent.category`).
- `usage-store`: `usageTotalsByMission(db, missionId)` (criada na Task 6 abaixo).
- `media-usage-store`: `mediaUsageTotalsByMission(db, missionId)`; edge `recordMediaUsage`.
- `persistence/db.ts`: `getDb(): Db | null`.
- Settings: `orchSettingsSchema` (`src/shared/settings-types.ts`) + IPC `orchGet`/`orchSet` já existente (`window.nexus.settings.orchSet`).
- Broadcast: padrão `usage-service` (BrowserWindow.getAllWindows, coalesce 1s, `.unref()`).
- HUD monta em `src/renderer/components/WorkspaceBar.tsx` linha ~126 (ao lado de `<CostSummary />`).
- Zustand mirror: copiar padrão de `src/renderer/state/usage-store.ts` (hydrate + onChanged).

---

### Task 6: `usageTotalsByMission` no usage-store

**Files:**
- Modify: `src/main/usage/usage-store.ts`
- Test: `src/main/usage/usage-store.test.ts` (adicionar caso no describe SQLite existente)

**Interfaces:**
- Produces (Task 7): `usageTotalsByMission(db: Db, missionId: string): UsageTotals` (mesmo shape das totals existentes).

- [ ] **Step 1: Adicionar o teste** — no `describe.skipIf(!sqlite)` existente:

```ts
  it('agrega uso por missão', () => {
    const db = makeDb();
    recordUsage(db, { ...makeEvent(), workspacePath: '/ws', missionId: 'm-1' }, 1);
    recordUsage(
      db,
      { ...makeEvent({ messageId: 'msg-2', sessionId: 's2' }), workspacePath: '/ws', missionId: 'm-2' },
      2,
    );
    const m1 = usageTotalsByMission(db, 'm-1');
    expect(m1.turns).toBe(1);
    expect(m1.costUsd).toBeGreaterThan(0);
    expect(usageTotalsByMission(db, 'm-x').turns).toBe(0);
  });
```

(Adicionar `usageTotalsByMission` ao import do teste. `UsageRecord` já tem
`missionId?: string | null` — se `makeEvent` não propagar, passar direto no
objeto literal como acima.)

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run src/main/usage/usage-store.test.ts` → FAIL (não exportada)
- [ ] **Step 3: Implementar** — ao lado de `usageTotalsByWorkspace`, com o MESMO corpo trocando o WHERE:

```ts
export function usageTotalsByMission(db: Db, missionId: string): UsageTotals {
  const row = db
    .prepare(`${TOTALS_SELECT} WHERE mission_id = ?`)
    .get(missionId) as TotalsRow | undefined;
  return totalsFromRow(row);
}
```

(Se não existir helper `totalsFromRow`, replicar o mapeamento literal da
função vizinha — manter idêntico.)

- [ ] **Step 4: Rodar e ver passar** — suite do arquivo inteira PASS.
- [ ] **Step 5: Commit** — `git add src/main/usage/ && git commit -m "feat(usage): totais de tokens por missão (base do bônus de eficiência)"`

---

### Task 7: gamification-service (borda: eventos reais → engine → broadcast/narração/retro)

**Files:**
- Create: `src/main/gamification/gamification-service.ts`
- Test: `src/main/gamification/gamification-service.test.ts`
- Modify: `src/main/usage/media-usage-store.ts` (tap de mídia)
- Modify: `src/main/orch/tools-domain.ts` (hint de evidência na description)

**Interfaces:**
- Consumes: Partes 1–2 completas + interfaces listadas no topo.
- Produces (Tasks 8–10):
  - `initGamificationService(deps?: Partial<ServiceDeps>): void` / `shutdownGamificationService(): void`
  - `buildSnapshot(): GamificationSnapshot`
  - `recordMediaGeneratedForGamification(kind: string, missionId: string | null): void`
  - `hasGreenEvidence(artifacts: unknown[]): string | null` (exportada p/ teste)
  - `runRetroReplayOnce(): void` (service chama no init; exportada p/ teste)
  - `doPrestige(): GamificationSnapshot` (chamada pelo IPC)
  - `ServiceDeps = { db: Db | null; broadcast(channel: string, payload?: unknown): void; now(): number; soberMode(): boolean }` — defaults: `getDb()` (lazy require), broadcast BrowserWindow coalescido, `Date.now`, `getOrchSettings().soberMode` (lazy require).

**Comportamentos (cada um vira caso de teste — o teste usa better-sqlite3
in-memory + `initHandoffStore(db)`/`initMissionStore(db)`/`initTaskStore(db)`
reais + deps fake `{db, broadcast: spy, now: fixo, soberMode: () => false}`):**

1. **Evidência**: `hasGreenEvidence(artifacts)` → procura artifact objeto
   `{kind:'verification', command: string, exitCode: 0}` e retorna
   `"${command} (exit 0)"`; senão `null`.
2. **Handoffs**: no callback de `onHandoffsChange`, varre
   `listHandoffs({includeDelivered:true})`; cada `status==='success'` vira
   evento `handoff_green` (com evidência) ou `handoff_success` (sem);
   `entityKey = kind + ':' + handoff.id`; `agentCategory` via
   `findAgent(handoff.fromAgent ?? '')?.agent.category ?? null`; `effort` do
   pane da missão cujo `agentName === fromAgent` (fallback: 1º pane worker).
   Idempotência do store descarta já-processados (re-varredura é barata e
   segura).
3. **Missões**: no callback de `onMissionsChange`, cada `status==='done'` vira
   `mission_green` se existe handoff green daquela missão, senão
   `mission_done`; `costUsd = usageTotalsByMission(db,id).costUsd +
   mediaUsageTotalsByMission(db,id).costUsd`; `effort` = maior effort entre os
   panes (`high > medium > low`). Counters extras em meta
   (`counters_extra` JSON): `efficient_mission` +1 quando
   `efficiencyBonus('mission_green', effort, costUsd) > 0`; `agentic_mission`
   +1 quando `mission.squadId?.startsWith('agentic-')`.
4. **Tasks**: `status==='done'` → `task_done`, `entityKey='task_done:'+id`.
5. **Mídia**: `recordMediaGeneratedForGamification(kind, missionId)` insere
   evento `media_generated` com `entityKey='media_generated:'+randomUUID()`
   e incrementa counter extra `media_<kind>` no meta.
6. **Fold + estado**: após inserir evento(s) novo(s): `foldAggregate(listXpEvents)`
   + merge dos counters extras do meta; aplica piso de tier (meta `tierFloor`,
   só sobe); avança streak (`advanceStreak` sobre meta `streak`) para eventos
   de entrega não-retro; avalia `evaluateAchievements` (novas → meta
   `achievements` + skins ao meta `skins`); grava metas; broadcast
   `GAMIFICATION_CHANNELS.changed` com `buildSnapshot()`.
7. **Narração**: quando tier sobe / conquista nova / ramo muda E
   `!deps.soberMode()` E evento não-retro → `deps.broadcast('voice:narrate',
   {text: GAMIFICATION_COPY.levelUp(tier)})` (idem `achievementUnlocked`,
   usando o title do copy). NUNCA narrar durante replay retro.
8. **Retro**: `runRetroReplayOnce()` — se meta `replayDone` ausente: varre
   missões done + handoffs success + tasks done existentes, insere eventos com
   `retro: true` e `createdAt` original, grava `replayDone='1'`. Sem narração.
9. **Prestígio**: `doPrestige()` — só quando `powerLevel efetivo >=
   PRESTIGE_THRESHOLD` e tier `LENDA`: incrementa meta `prestige`, grava
   `prestigeBaseline = powerBruto` (power exibido = bruto − baseline; estrelas
   = prestige). Snapshot expõe `prestigeReady`.

Casos de teste mínimos (8): evidência presente/ausente; handoff success sem
evidência → `handoff_success`; com evidência → `handoff_green`; missão done
com handoff verde + custo na banda → `mission_green` com bônus e counter
`efficient_mission`; idempotência (2ª varredura não duplica nem re-broadcast
de conquista); level-up narra e sóbrio suprime; retro marca `replayDone`, não
narra e conta com peso simples; snapshot completo (streak/conquistas/skins).

- [ ] **Step 1: Escrever o teste com os 8 casos** (padrão `describe.skipIf(!sqlite)`).
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run src/main/gamification/gamification-service.test.ts`
- [ ] **Step 3: Implementar o service** conforme os 9 comportamentos (lazy require de `persistence/db` e `settings-store`; broadcast coalescido de 1s copiado de `usage-service.scheduleBroadcast`).
- [ ] **Step 4: Tap de mídia** — em `media-usage-store.recordMediaUsage`, após o `insertMediaUsage` + notify existente:

```ts
    const { recordMediaGeneratedForGamification } =
      require('../gamification/gamification-service') as typeof import('../gamification/gamification-service');
    recordMediaGeneratedForGamification(result.kind, ctx.missionId ?? null);
```

- [ ] **Step 5: Hint de evidência** — em `tools-domain.ts`, description de `nexus_handoff_submit`, acrescentar: `'Attach {kind:"verification", command, exitCode:0} in artifacts to count as a VERIFIED (green) delivery.'`
- [ ] **Step 6: Rodar tudo** — `npx vitest run src/main/gamification && npm run typecheck` → PASS/limpo.
- [ ] **Step 7: Commit** — `git add -A src/main/gamification src/main/usage/media-usage-store.ts src/main/orch/tools-domain.ts && git commit -m "feat(gamification): service read-model (handoff/missão/task/mídia → XP, retro, narração, prestígio)"`

---

### Task 8: IPC + preload + modo sóbrio + boot

**Files:**
- Create: `src/main/gamification/gamification-ipc.ts`
- Modify: `src/shared/settings-types.ts` (`orchSettingsSchema` + `soberMode: z.boolean().default(false)`)
- Modify: `src/main/main.ts` (registrar + init/shutdown)
- Modify: `src/preload/preload.ts` (expor `window.nexus.gamification`)
- Modify: `src/shared/types.ts` (NexusApi.gamification)

**Interfaces:**
- Consumes: Task 7 + `GAMIFICATION_CHANNELS`.
- Produces (renderer, Tasks 9–10):
  - `window.nexus.gamification.snapshot(): Promise<GamificationSnapshot>`
  - `window.nexus.gamification.onChanged(cb): Unsubscribe`
  - `window.nexus.gamification.selectSkin(skin: string | null): Promise<GamificationSnapshot>` (valida: null ou skin ∈ snapshot.skins)
  - `window.nexus.gamification.exportProfile(): Promise<{ok: boolean; path?: string; error?: string}>` — `dialog.showSaveDialog` + JSON `{version: 1, ruleVersion, events, meta, checksum}` (checksum = sha256 de `JSON.stringify({events, meta})`; assinatura criptográfica real fica p/ backend)
  - `window.nexus.gamification.importProfile(): Promise<{ok: boolean; error?: string}>` — `dialog.showOpenDialog`, valida version+checksum, substitui eventos/meta em transação, refold + broadcast
  - `window.nexus.gamification.prestige(): Promise<GamificationSnapshot>`
- Modo sóbrio: campo em `orchSettingsSchema`; renderer usa o IPC orchGet/orchSet existente; HUD/celebrações/narração respeitam.

Steps: (1) `soberMode` no schema (o `orchSet` existente já aceita patch parcial — verificar que o zod `.partial()` cobre, senão espelhar o campo no handler); (2) implementar `gamification-ipc.ts` com handlers zod-validados; (3) `main.ts`: `registerGamificationIpc()` + `initGamificationService()` logo após `initUsageTelemetry()`; `shutdownGamificationService()` no `before-quit`; (4) preload (listener-set + `ipcRenderer.on(GAMIFICATION_CHANNELS.changed, ...)`, padrão media/usage) + `NexusApi.gamification` em `shared/types.ts`; (5) `npm run typecheck` limpo; (6) commit `feat(gamification): IPC + preload + modo sóbrio + boot`.

---

### Task 9: OperatorSprite (mascote pixel programático) + OperatorHud

**Files:**
- Create: `src/renderer/components/OperatorSprite.tsx`
- Create: `src/renderer/components/OperatorHud.tsx`
- Create: `src/renderer/state/gamification-store.ts`
- Modify: `src/renderer/components/WorkspaceBar.tsx` (montar `<OperatorHud />` ao lado de `<CostSummary />`)
- Modify: `src/renderer/styles/global.css` (bloco `.operator-hud*`)
- Test: `src/renderer/components/operator-sprite-data.test.ts`

**Interfaces:**
- Consumes: Task 8 (`window.nexus.gamification.*`), tipos/copy do shared.
- Produces (Task 10):
  - `OperatorSprite({ size, tier, branch, skin, mood })` — props: `size: number`, `tier: GamificationTier`, `branch: OperatorBranch`, `skin: string | null`, `mood: 'idle' | 'celebrating' | 'evolving' | 'sleeping'`. Renderiza `<canvas>` com `image-rendering: pixelated`.
  - Helpers puros em arquivo separado `src/renderer/components/operator-sprite-data.ts`: `OPERATOR_GRID: number[][]` (16×16, valores 0–5 = índice de paleta; **desenhar aqui um robô/criatura ORIGINAL** — silhueta assimétrica com antena lateral e visor, nada derivado de terceiros), `paletteFor(tier, branch, skin): string[]` (6 cores hex: fundo transparente, corpo, sombra, visor, acento, aura — corpo/acento variam por ramo, aura aparece a partir de VETERANO e intensifica por tier, skin sobrepõe).
- HUD: sprite 24px + `LV {n} · {GAMIFICATION_COPY.tiers[tier]}` + power formatado (`fmt(35_500_000) === '35.5M'`) + barra `scaleX` até `nextTierAt` + estrelas de prestígio; contagem animada ao subir (pular se `prefers-reduced-motion`); `mood='celebrating'` por 3s quando snapshot.powerLevel aumenta; some quando `soberMode`; clique chama `useGamificationStore.getState().openProfile()` (Task 10 conecta a tela).
- Zustand: `useGamificationStore` — `{snapshot, profileOpen, hydrate, receive, openProfile, closeProfile}`, hydrate no mount + `onChanged` (copiar shape de `usage-store.ts` do renderer).

Steps: (1) teste dos helpers puros: grid 16×16, só índices < tamanho da paleta, `paletteFor` difere por tier (RECRUTA vs MAESTRO), por ramo (guardiao vs forja) e aplica skin ('gold' muda o acento), `fmt` formata `999`, `1_500` → `1.5K`, `35_500_000` → `35.5M`; (2) implementar `operator-sprite-data.ts` (grid original + paletas) e ver passar; (3) `OperatorSprite.tsx` (canvas, escala inteira `Math.floor(size/16)`, 2 frames de idle alternando 600ms — desligado com reduced-motion); (4) zustand store; (5) `OperatorHud.tsx` + montagem no WorkspaceBar + CSS (`.operator-hud` compacto, expande no hover; tokens do design system, AA; acento só na barra/aura); (6) `npm run typecheck` + `npx vitest run src/renderer/components/operator-sprite-data.test.ts` PASS; (7) commit `feat(gamification): mascote pixel programático + HUD do Operador`.

---

### Task 10: Perfil de Operador (tela completa)

**Files:**
- Create: `src/renderer/components/OperatorProfile.tsx`
- Modify: `src/renderer/App.tsx` (montar `<OperatorProfile />` como overlay nos DOIS returns com workspace — padrão `<SettingsDrawer />`)
- Modify: `src/renderer/styles/global.css` (bloco `.operator-profile*`)

**Interfaces:**
- Consumes: Tasks 8–9 (`useGamificationStore`, `OperatorSprite`, `window.nexus.gamification.*`, `window.nexus.settings.orchGet/orchSet`, `GAMIFICATION_COPY`).
- Produces: overlay (aberto por `profileOpen`; Esc e clique no backdrop fecham) com:
  - Cabeçalho: sprite 96px + nome do ramo (`GAMIFICATION_COPY.branches[branch]`) + tier + estrelas `★×prestige`.
  - Power level grande formatado + barra até `nextTierAt` + botão **Transcender** (visível só com `prestigeReady`; confirma antes: `window.confirm` não — usar um mini-diálogo inline com dois botões).
  - Breakdown de XP: linhas por kind (`counters.mission_green × copy`) — copy local no componente (`missões verdes`, `handoffs verificados`, etc.).
  - Eficiência: `counters.efficient_mission` missões na banda eficiente.
  - Streak: `streakDays` dias úteis + `shieldsLeft` escudos.
  - Grid de conquistas: TODAS as ids de `GAMIFICATION_COPY.achievements` — desbloqueada (title+description plenos) vs bloqueada (cinza, título visível).
  - Skins: chips das `snapshot.skins` (+ 'padrão'=null); clicar → `selectSkin`; selecionada marcada.
  - Rodapé: botões Exportar / Importar perfil (chamam IPC, mostram resultado) + toggle **Modo sóbrio** (orchGet no mount, orchSet no change).
- Estética: design system do app (neutros profundos, acento operacional só no vivo, AA, hierarquia por tipografia/espaçamento; SEM gradiente roxo/glassmorphism/sparkles).

Steps: (1) implementar tela + CSS; (2) montar no App (dois pontos de return com workspace); (3) conectar clique do HUD; (4) `npm run typecheck` + `npm test` (suite completa verde); (5) commit `feat(gamification): tela Perfil de Operador (conquistas, skins, streak, prestígio, export, sóbrio)`.

---

### Task 11: Verificação final integrada

**Files:** nenhum novo (correções pontuais se algo falhar).

- [ ] **Step 1:** `npm run typecheck` → exit 0.
- [ ] **Step 2:** `npm test` → suite completa verde (~35–45 testes novos sobre a base atual).
- [ ] **Step 3:** Smoke real: `npm start`, abrir workspace com histórico → HUD já mostra power > 0 (retro replay funcionou); abrir Perfil (clique no HUD); conquista "Primeiro Deploy" visível; ligar Modo sóbrio → HUD some; desligar → volta com o mesmo power.
- [ ] **Step 4:** Commit final:

```bash
git add -A
git commit -m "feat: sistema de gamificação power-scaling v1 completo (spec 2026-07-06)"
```

---

## Self-review do plano (3 partes, feito na escrita)

- **Cobertura da spec:** §1 princípio → P1 T1–2 (teste estrutural: sem kind de token); §2 identidade/tiers/prestígio/ramos/spec-de-asset → P1 T1–2 + P3 T9 (sprite programático 16×16 dentro da grade 32, paletas por tier/ramo/skin = ramo base + variações; arte bitmap final pode substituir depois sem mudar interface); §3 XP/anti-farm/evidência/eficiência/versionamento → P1 T1–2, P2 T5, P3 T7; §4 HUD/perfil/conquistas/streak/skins/narração/sóbrio/retro → P2 T3–4, P3 T7–10; §5 arquitetura/export-import/i18n → P2 T5, P3 T7–8 (export com checksum; assinatura real fica p/ backend, documentado); §6 escopo v1 coberto; gated (leaderboard time/loja) fora, conforme spec — recordes pessoais = breakdown/counters do perfil; §7 privacidade (tudo local), a11y (reduced-motion/AA nas T9–10), testes em toda task.
- **Placeholders:** nenhum TBD; Tasks 7–10 especificam contratos exatos + comportamentos numerados com casos de teste nomeados (nível certo p/ executor com o repo aberto; padrões a copiar são apontados por arquivo).
- **Consistência de tipos:** nomes verificados contra o repo (`onHandoffsChange`, `listMissionPanes`, `findAgent`, `initHandoffStore(db)`); `usageTotalsByMission` criada (T6) antes do uso (T7); `GAMIFICATION_CHANNELS`/`GAMIFICATION_COPY` definidos na P1 T1 e usados na P3; `prestigeReady` presente no snapshot (P1 T1) e usado na T10.
- **Riscos anotados:** (a) `makeEvent` do usage-store.test pode não propagar `missionId` — mitigação no step T6; (b) counters extras vivem em meta (não no fold) — decisão documentada em T7 comportamentos 3/5; (c) narração reaproveita canal `'voice:narrate'` — anti-tagarelice já é tratada no renderer.
