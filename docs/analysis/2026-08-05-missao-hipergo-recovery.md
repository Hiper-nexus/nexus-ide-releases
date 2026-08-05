# Missão HiperGO `mission-3be48989` — veredito de recuperação

**Data:** 2026-08-05 · **Veredito: nada foi perdido.** A missão não se auto-destruiu, não foi ceifada e não perdeu trabalho. Ela parou porque o próprio worker reportou `blocked`, e o produto não contou isso a ninguém.

## 1. O que sobrevive (verificado em disco, `runtime.sqlite3` read-only)

Banco: `~/Library/Application Support/NexusIDE/project-runtime/projects/project-c983a99128d5…/checkout-d44b1037…/runtime.sqlite3`

| Artefato | Estado |
|---|---|
| Linha da missão | `mission-3be48989-391d-4b4c-8f2c-6449d0475d4d` · `status=pending` · `intent_state=awaiting_approval` · `updated_at=19:50:42` |
| Plano | **8 tasks** — 1 `failed` (t1), 7 `pending` |
| Plano selado | `mission_task_plans` `intent_version=1`, `plan_hash=739d984e005e0710…`, 9897 bytes, criado 19:25:20 |
| Commit da entrega | **`a7cf9b2 docs: preparar gate da story 1.2`** |
| Diff real | 4 arquivos, **+486 / −6** (`RU-02-tenant-isolation.md`, `1-2-acceptance-manifest.yaml`, `1-2-tenant-isolation-com-rls-e-suite-ci.md`, `DELIVERY-COVERAGE-MATRIX.yaml`) |
| Branch | `nexus/b3148bf118b3c509/12bfa07c42d4c466c5190b42b6a1e498` (local no repo HiperGO) |
| Worktree | **existe em disco**, `HEAD=a7cf9b2`, working tree **limpa** |

O checkout principal `/Users/cleofasrocha/HiperGO` está em `fix/story-1-1-codex-round2` @ `afeb2fc` — a entrega **não** está nele, vive só no branch da task.

## 2. Caminho seguro de volta (v0.26.0, sem esperar release)

```bash
cd /Users/cleofasrocha/HiperGO

# ver o que foi entregue
git log  --oneline afeb2fc..nexus/b3148bf118b3c509/12bfa07c42d4c466c5190b42b6a1e498
git diff --stat    afeb2fc..nexus/b3148bf118b3c509/12bfa07c42d4c466c5190b42b6a1e498

# trazer para o branch atual
git cherry-pick a7cf9b26abd6f1723ed4c096106a35600b7edb01
```

**Não clicar:** "Enviar para aprovação" no wizard reaberto. Nada foi apagado (a linha da missão não muda desde 19:50:42), mas a missão está em `intent_version=2` enquanto o plano selado está gravado em `intent_version=1` — e `mission_task_plans` tem PK `(mission_id, intent_version)`. Aprovar ali sela um plano NOVO na v2 e deixa o plano que já executou órfão. Sair pelo "Cancelar".

## 3. Cronologia, sem lacuna (audit_events)

| Hora | Evento |
|---|---|
| 19:19:40 | handoff `progress` — recuperação de orquestração (missão despachada sem tasks no prazo). Maestro acorda, sela plano de 8 tasks, despacha t1 |
| 19:25:20 | plano selado gravado (`intent_version=1`) |
| 19:44:05 | handoff `stalled` do mission-driver ("sem progresso há 10 min"). Sinal **não-destrutivo** e declaradamente não-letal |
| 19:47:27 · 19:50:22 | `nexus_worker_heartbeat ok` — worker vivo, trabalhando |
| **19:50:40** | **`nexus_handoff_submit ok` — o worker submete `status: blocked`** ("Story 1.2 em TBD-BLOCKED… commitados localmente em a7cf9b26. O gate não foi promovido") |
| 19:50:41 | dispatch atinge estado terminal → `[NEXUS_DEAD_OWNER_WORKTREE_RELEASE] dispatch alcançou estado terminal (blocked/failed); ownership do worktree liberada` → panes fecham |
| 19:50:42 | missão → `pending` / `awaiting_approval` |
| depois | **nada.** O audit acaba aí |

**Descartado com evidência:** sem crash, sem exceção no motor de missão, sem parada por budget/quota, **sem ceifador**. O worktree foi liberado *porque* o dispatch ficou terminal — consequência, não causa.

## 4. Reaper não alcança missão viva (verificação pedida)

`src/main/orch/stall-watchdog.ts`:

- `shouldFlagStall` (:73) — `if (c.role !== 'worker') return false`. E **só sinaliza**, nunca mata.
- `shouldReapNonExecutingBoot` (:94-107) — quatro guardas independentes, qualquer uma basta para impedir a ceifa:
  1. `role !== 'worker'` → orquestrador nunca é alvo;
  2. `everExecuted` → worker que já engajou fica **permanentemente imune**;
  3. `state !== 'idle'` → `busy`/`waiting` nunca é reapeado;
  4. limitado à janela de boot e idempotente (`alreadyReaped`).
- `login-stuck-watchdog.ts:391` — também worker-only.

Prova de campo desta missão: nenhum reaper apareceu no audit; o último evento é o `handoff_submit` do próprio worker.

## 5. Os dois defeitos reais (produto, não runtime)

**A — a causa existe no banco e a UI esconde.** O handoff `blocked` carrega o motivo completo (falta OD-23 resolvido, identity seam aprovado, fixture de membership) e o card mostrava só "Aguarda você" sobre um wizard vazio. Temos a causa e escondemos — a classe de diagnóstico invisível.

**B — `awaiting_approval` roteava para o wizard de objetivo.** Em `mission-rail-groups.ts` o estado estava no mesmo balde de `awaiting_goal`/`draft`, sob um bloco cuja premissa declarada é *"no panes yet"* — falsa para uma missão com plano selado, worktree e commit. Recomeço do zero oferecido como se fosse retomada.

### Correções desta rodada

| Defeito | Commit | O que mudou |
|---|---|---|
| Destino da retomada | `24f98406` | `mission-resume-route.ts` decide por **evidência** (panes gravados) e não por classificação de estado; wizard só com prova de zero panes |
| Rótulo e convite | `172d5b7b` | `hasObservedRuntime` entra na evidência do rail: pill vira "Parou — aguarda você" e o convite vira "Ver por que parou", dizendo que plano e trabalho continuam preservados |

## 6. Fora de escopo desta análise

A falha de CI no status bar (`CI - main (a3b945e)`, "All jobs have failed") é do repo nexus-ide e não tem relação com o colapso desta missão.
