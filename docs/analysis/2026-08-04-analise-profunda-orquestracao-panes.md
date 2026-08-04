# Análise profunda — orquestração, panes, missões e travamentos

**Data:** 2026-08-04
**Método:** leitura direta do código neste checkout (`main`, base `2be8e01e`),
cruzamento com as análises seniores de 2026-08-02/03 e com a destilação do
Overclock 1.2.4 instalado (`/Applications/Overclock.app`).
**Escopo:** achar bugs novos, confirmar o estado dos conhecidos e extrair o
delta Overclock que melhora a entrega de missões.

## 0. Fechamento da auditoria (2026-08-04)

Os três bugs novos desta análise foram corrigidos antes da release:

- **F2:** múltiplas filas ligadas à mesma sessão não são mais apagadas em
  silêncio; cada autoridade entra na recuperação física Main-owned.
- **F1:** timeout de aquisição restaura a cauda predecessora no registry do
  lifecycle lock, preservando exclusão mútua sem deixar cauda órfã.
- **F3:** cache de telemetria e registry de usage usam a identidade física
  completa (`installationId`, `projectId`, `checkoutId`, `rootRealPath`).
- O Vitest agora exclui também `.dev-user-data-qa/**`.

Evidência executada após as correções:

- `npm test`: **1.072 arquivos, 10.061 testes, zero falhas**;
- `npm run typecheck`: passou;
- `npm run security:renderer-sinks`: zero sinks executáveis;
- sensor de design: 8/8 tokens documentados coerentes;
- benchmark multipane 4/8/10: ordem e ANSI preservados, fila limitada;
- `npm run package`: smoke empacotado com 20 probes, 142 tools, 9 adapters,
  shutdown gracioso e zero processos órfãos.

---

## 1. Veredito executivo

A base está **muito mais saudável do que há uma semana**: o deadlock dominante
de handoff está provado como resolvido (pull-ACK), o fail-fast de MCP auth
existe, e a sessão paralela fechou os 5 sintomas de UX das missões (boot sem
feedback, prompt gordo, veredito, recovery eterno, warm-up de panes).

Ainda assim encontrei **3 bugs reais não documentados** (dois no ciclo de
vida de entrega/locks, um na telemetria de quota) e reconfirmo **3 dívidas
estruturais** que seguem abertas e explicam o gap "Overclock vive, Nexus
trava" na percepção do operador.

---

## 2. Bugs novos encontrados nesta varredura

### F2 (médio) — `flushQueue` dropa filas de handoff em silêncio após rebind

`src/main/orch/idle-delivery.ts:825-845`

```ts
const matches = [...queues.entries()].filter(
  ([, queue]) => queue[0]?.authority.sessionId === sessionId);
if (matches.length !== 1) {
  for (const [key] of matches) queues.delete(key);   // ← drop mudo
  return;
}
```

`authorityKey` (:382-393) inclui `missionId + paneId + sessionId`. Quando uma
sessão de orquestrador é **rebindada para outra missão** (troca exclusiva de
orquestrador / re-dispatch), pode existir a fila da missão antiga e a da nova
apontando para o MESMO `sessionId`. No próximo idle, `flushQueue` encontra 2
matches e **apaga as duas filas sem log, sem `failDeliveryAttempt` e sem
agendar recovery**. Os handoffs ficam `delivery_state='queued'` no SQLite
para sempre, até um `redeliverPendingHandoffs` por rebind/restart ou o
Maestro puxar por leitura (pull-ACK — que mitiga, mas depende de o Maestro
decidir ler).

O tap de exit da sessão (:864-936) faz o caminho certo — captura
`recoveryTargets` ANTES de dropar e invoca `recoverDefectiveRuntime`. O drop
por multi-match deveria fazer o mesmo (ou, no mínimo, `console.warn` +
`failDeliveryAttempt` com código próprio).

### F1 (baixo) — lifecycle lock vaza entrada no Map a cada timeout

`src/main/orch/mission-lifecycle-lock.ts:66-87`

O waiter registra `missionLifecycleTails.set(key, tail)` ANTES de aguardar.
Se desiste por `acquireTimeoutMs`, o `catch` chama `release()` (correto — a
cadeia não estraga) e lança, mas o bloco `finally` (:93-98) que removeria a
entrada **nunca executa**, pois fica depois do `await operation()`. Resultado:
uma entrada permanente no Map por timeout, por missão. Não trava ninguém (a
tail já está resolvida), mas é leak crescente em cenários de recovery
repetido — exatamente o cenário para o qual o timeout foi criado.

Fix de 3 linhas: no `catch` do race, se `missionLifecycleTails.get(key) === tail`,
deletar antes de lançar.

### F3 (médio) — raiz da "scope identity collision" continua aberta

`src/main/usage/usage-service.ts:92-94` vs `src/main/orch/project-scoped-broadcast.ts:5-15`

```ts
function scopeKey(scope) { return `${scope.projectId}\0${scope.checkoutId}`; }
```

mas `sameProjectScope` exige **também** `installationId` e `rootRealPath`.
Mesma chave + escopo diferente ⇒ `#ensureScope` lança
`usage telemetry scope identity collision` (:266-268). A mitigação de
2026-08-02 conteve o hook de dictation (try/catch no `pty-manager.ts:1971`) e
o resume (degrada para `null`), mas estes caminhos **ainda propagam o throw**:

- `snapshot(scope)` (:192) → IPC de quota/custo que alimenta a UI;
- `notifyMediaGenerated` (:218-220);
- `#onSessionDictated` (:318) → contido pelo catch do pty-manager, mas segue
  dependente de contenção externa.

Rodar de worktree (ou o mesmo projeto em dois checkouts/instalações) torna a
colisão trivialmente alcançável. Fix: alinhar `scopeKey` aos 4 campos — o
próprio `missionLifecycleKey` (`mission-lifecycle-lock.ts:11-25`) já usa o
formato correto com `\0`. + teste de regressão "mesmo projectId+checkoutId,
rootRealPath diferente ⇒ dois estados, sem throw".

---

## 3. Estado dos problemas conhecidos (confirmado por leitura)

| Item | Estado | Evidência |
|------|--------|-----------|
| Deadlock handoff (queued↔idle) | **Resolvido** | `2026-08-02-deadlock-handoff-ack.md`, prova `HANDOFF_PROOF=PASS` |
| Worker trava com MCP ambient quebrado | **Mitigado** | `login-stuck-watchdog.ts` (padrões `mcp-auth` + handoff sintético), `prepareCodexOperatorMissionHome` (CODEX_HOME privado sem MCPs do perfil real) |
| Recovery "para sempre" | **Resolvido** | timeout 120s/attempt, lock 30s busy-retryable, bloco N/8, escape hatch na UI (`2026-08-03-mission-ux-handoff.md`) |
| Boot sem feedback / prompt gordo / veredito / warm-up panes | **Resolvido** | commits citados no handoff 2026-08-03 |
| Travamentos de render multi-pane | **Endereçado** | `2be8e01e`: scheduler adaptativo (fila 2MB cap, parking de pane oculto, WebGL suspenso, FPS/queue diagnostics). Revisado nesta varredura — drenagem cooperativa com budget de 8ms, parse-backpressure (`MAX_UNPARSED_WRITE_CHARS`), dispose com `discardTerminalOutput`. Sem bug novo encontrado |
| Orçamento de entrega esgotado | **Coberto** | `blockDeliveryFailure` (:621-662): recovery físico ou `blocked` com CTA, com warn |
| Locks/loops `while(true)` em orch | **Sãos** | `cli-mcp-session-governance.ts:131` e `catalog.ts:180` têm breaks corretos |
| Timers de módulo (`pane-session-output`, cron, scheduler) | **Sãos** | unref'd, ring buffer com cap, TTL de 60s para buffers de sessão morta |

### Dívidas estruturais que seguem abertas

1. **~23-25 gates pré-PTY** (`2026-08-02-overclock-124-distill.md` §7). A
   recomendação continua de pé e é a maior alavanca de "missão nasce":
   enforcement real DEPOIS que o PTY existe; antes disso só gates que o
   operador entende em uma frase.
2. **`node_modules` compartilhado** entre checkout e app empacotado — ABI
   Electron 148 ↔ Node 127 quebra alternadamente testes/app (já mordeu a
   prova ao vivo de 2026-08-02).
3. **Vitest varre `.dev-user-data-qa/`** — 12 cópias obsoletas do mesmo teste
   observadas; falta `exclude` na config.

---

## 4. Delta Overclock 1.2.4 → ações para entrega de missões

Extraído da destilação local (`2026-08-02-overclock-124-distill.md` + RE do
sidecar instalado). O que vale absorver AGORA, em ordem de retorno:

1. **Worker TTL pós-handoff (~30s, opt-in).** Overclock fecha workers ~30s
   após handoff limpo — libera panes, memória e PTYs. Nexus mantém workers
   vivos até o fim da missão. Verificar `mission-runtime-termination.ts`:
   adicionar encerramento ocioso pós-`handoff_ack` (com o handoff durável no
   SQLite, reabrir é barato).
2. **Happy path de 3 passos.** O deles: brief → spawn → handoff. O nosso:
   approve → 20+ gates → spawn → recovery. Cada gate movido para pós-PTY é
   uma falha a menos no nascimento da missão (ver dívida 1).
3. **`pane_write_many` serializando writes no mesmo pane** — equivalente ao
   nosso `pane-pipe.flushQueue` (revisado, são). Paridade ok.
4. **Handoff durável + schema validation com re-prompt** — paridade ok
   (SQLite + `handoff_ack_receipts`).
5. **NÃO copiar:** ausência de sandbox OS, `session.json` 0644 com tokens,
   RemoteBridge em 0.0.0.0, builtins re-sincronizando a cada boot. O Nexus
   está à frente nesses e deve ficar.

---

## 5. Plano sugerido (estado após execução)

| # | Ação | Arquivo | Esforço |
|---|------|---------|---------|
| 1 | Fix F3 (scopeKey 4 campos + teste) | `usage-service.ts` / registry | **feito** |
| 2 | Fix F2 (multi-match: warn + recovery targets, espelhando o exit-tap) | `idle-delivery.ts` | **feito** |
| 3 | Fix F1 (restaurar predecessor no catch do timeout) | `mission-lifecycle-lock.ts` | **feito** |
| 4 | Worker TTL pós-handoff (opt-in) | `mission-runtime-termination.ts` | médio |
| 5 | `exclude` de `.dev-user-data-qa` no vitest | `vitest.config.ts` | **feito** |
| 6 | Continuar a migração de gates para pós-PTY | vários | programa |

Os itens 4 e 6 permanecem como programa de evolução, não como bloqueadores
desta correção patch. Os itens 1, 2, 3 e 5 estão implementados e validados.
