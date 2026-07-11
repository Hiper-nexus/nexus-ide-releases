# Goal draft — Paridade ORCA restante (pós F0–F5 parcial)

**Data:** 2026-07-11 (revalidado com leitura total do mapa + greps no tip)  
**Fonte de verdade:** `docs/analysis/2026-07-10-nexus-orca-integration-map.md`  
**Pin ORCA (inegociável):** `143c36e566483006fe54fa2716b019ec00599752`  
**Branch de partida:** `fix/mic-permission-v011`  
**Tip observado ao revalidar:** `26d0253` (`fix(remote,scm): harden F3-F5 review findings`) — branch **ahead 1** de origin  
**Método:** mapa §§11–14 + §18; inventário no filesystem; `rg` em production paths (não só harvest)

Este documento **não implementa** código. Serve para copiar/colar como `<user_query>` de um novo goal, ou como PRD curto de paridade.

---

## 0. Veredito honesto (1 parágrafo)

O mapa original pedia **colheita seletiva** (não fork do monorepo ORCA). No tip atual o Nexus fechou **P0 reliability** e **harvest + wiring de produção** de F3–F5 unitários (agent-runtime-bridge, forge lean, stream no remote-bridge). **Ainda não** há paridade operacional de hooks gerenciados, child-process-gone, forge read/token store, stack SSH/FS/Git remota, nem mobile. **Parity-ops ≈ quase; parity-remote = não; mobile = zero; P3 = fora.**

---

## 1. O que o mapa original pedia (resumo)

| Prioridade | Escopo mapa (§11 / §14) | Intenção |
| --- | --- | --- |
| **P0** | Circuit breaker, worktree removal safety, terminal stream protocol, terminal output scheduler, provenance | Reliability operacional |
| **P1** | Crash reporting completo, agent hooks + awake, hosted-remote-url, forge GH/GL (+ flags) | Agent runtime + SCM |
| **P2** | Relay SSH/FS/Git, WSL, reconnect/resume, remote scopes, E2EE/pairing, **mobile companion** | Remote + mobile |
| **P3** | Themes, Jira/Linear, automations, VMs, SC UI rich, i18n | Opcional / não-core |
| **Nunca** | Substituir worktree/context/merge-queue/doctor/identity Nexus; renderer ORCA inteiro; toolchain React/Node/xterm beta | §12 |

---

## 2. Matriz fase a fase do mapa (§14) × estado real

| Fase | Pedido do mapa | Estado no tip `26d0253` | Evidência |
| --- | --- | --- | --- |
| **F0** estabilizar working tree | typecheck + 2× tests + smoke + hygiene | **Parcial** — harvest rodou sobre tree já com testes; smoke package / ONNX / main.js ainda podem ser dívida humana | Gates F0 do mapa ainda com checkboxes abertos no doc original |
| **F1** promover v0.12 | merge main, tag, release, updater | **Parcial** — tags `v0.12.0` / `v0.12.1` locais; **publicação GitHub Release + merge main + updater real = humano** | `git tag -l 'v0.12*'` |
| **F2** Harvest 1 Reliability | breaker, worktree safety, stream protocol, scheduler, licenses | **GO (código)** | `src/main/window.ts` + reliability paths; scheduler renderer; `third_party/` + 71 entries ledger |
| **F3** Harvest 2 Agent Runtime | hooks, activity, awake, breadcrumbs, process-gone | **Harvest + wire parcial** — bridge produção no renderer-gone; **installers registry vazio**; **sem `child-process-gone`** | `agent-runtime-bridge`; `managed-agent-hook-controls` “Empty until…” |
| **F4** Harvest 3 Source Control | URL parser → forge → GH → GL → others flagged → Jira opcional | **Lean GO** — create PR/MR + authz/audit; **sem get/list PR**, **token não vem de keychain**, UI zero | `github-forge-provider` só `createReview` |
| **F5** Harvest 4 Remote | binary stream prod, relay, SSH FS/Git, WSL, resume, scopes, E2EE | **Unit/helpers + stream no bridge** — **sem ssh2 stack**, **sem FS/Git remoto**, WSL só detect, pairing sem E2EE wire | `src/main/remote/*` sem `ssh/` |
| **F6** Mobile | só após F5 | **NÃO iniciado** (correto) | sem `mobile/` |

### Backlog §18 do mapa (agora / próximo / depois)

| Item §18 | Status |
| --- | --- |
| Fechar gates locais / limpar artefatos / fatiar commits | Feito em grande parte na linha harvest |
| Promover v0.12 | Tag local; release/publicação humana |
| THIRD_PARTY + provenance | **Feito** (`THIRD_PARTY_NOTICES.md`, ledger 71) |
| Circuit breaker / worktree safety / stream / scheduler / multipane bench | **Feito** |
| Agent hooks | **Parcial** (tipos + ingest + wire; installers vazios) |
| Crash diagnostics completos | **Parcial** (módulos + renderer wire; child-process não) |
| Forge interface + GH/GL | **Parcial lean** (create only) |
| Relay SSH/WSL | **Não** (só path/WSL detect + framing) |
| Mobile companion | **Não** |

---

## 3. Já coberto no Nexus (não reabrir sem regressão)

### P0 — Reliability (Fase 2)
- [x] `renderer-recovery-circuit-breaker` + wire em `window.ts`
- [x] `worktree-removal-safety` (+ orphan proof / path compare)
- [x] `terminal-stream-protocol` shared + testes
- [x] `terminal-output-scheduler` adaptado (xterm estável) + multipane benchmark
- [x] `third_party/licenses/orca-MIT.txt`, `orca-143c36e.json` (~71 entries), `THIRD_PARTY_NOTICES.md`
- [x] Verifier: `scripts/verify-orca-provenance.mjs`

### P1 parcial — Agent runtime (Fase 3) **após wire de produção**
- [x] process-gone classification/dedupe/diagnostics, GPU fallback, breadcrumb/report stores
- [x] agent-hook types/listener/status/relay/endpoint helpers
- [x] agent-awake + macOS/linux sleep assertions
- [x] **Facade produção:** `agent-runtime-bridge`  
  - `window.ts` → `handleRenderProcessGone`  
  - `hook-ipc` / `hook-ingest` → activity → pane state  
  - `main.ts` → `getAgentAwakeService`
- [x] Verifier: `scripts/verify-agent-runtime-wiring.mjs`
- [x] Invariante §12.4: hooks **não** autorizam evidence

### P1 parcial — Source control (Fase 4)
- [x] `hosted-remote-url` + dual provenance hosted-git-info@9.0.3
- [x] Forge interface lean + **authz + audit**
- [x] GitHub + GitLab adapters (HTTP injetável) — **create PR/MR only**
- [x] Bitbucket/Azure/Gitea **default off** (`forge-flags`)

### P2 parcial — Remote (Fase 5 unit)
- [x] Stream session + **wire em `remote-bridge`** (`pane.read` / `pane.stream.*`)
- [x] relay framing (bounded), ssh-path containment, wsl-detect, device-pairing helpers, remote-capability sob `ProjectExecutionScope`
- [x] remote-bridge / remote-spawn / remote-ipc (Nexus nativo)

### Human / release
- [x] LICENSE na raiz; tags `v0.12.0` / `v0.12.1` no repo local
- [ ] Publicar GitHub Release + promover `origin/main` (humano)
- [ ] Validar updater v0.11 → v0.12 (humano)
- [ ] Limpar/decidir `training/` e artefatos locais (`.tsb-verify-skeptic`, etc.)

---

## 4. O que **falta** para paridade útil (backlog do novo goal)

Ordenado por retorno / dependência. **Não** é “clonar o monorepo ORCA”.

### Gap A — Agent hooks: installers reais + path de ingest de sessão (P1 incompleto)

**Mapa:** `src/main/agent-hooks/`, installers por provider, WSL/SSH hook relay.  
**Hoje:** `registerManagedAgentHookService` existe, mas **registry vazio**; `MANAGED_AGENT_HOOK_INSTALLERS = []`; **nenhum** call site de produção registra Claude/Codex; IPC ingest para testes/wire, sem scripts managed no FS do user.

| Item | Aceite |
| --- | --- |
| A1 | `registerManagedAgentHookService` para **Claude + Codex** (mínimo) com install/remove/getStatus reais no FS do user |
| A2 | Endpoint HTTP local **ou** pipeline documentado que CLI/hooks reais alimentam; testes de install/status |
| A3 | Hook events de sessão real atualizam `PaneSessionState` via ingest (não só IPC de teste) |
| A4 | **Nunca** marcar missão done / evidence a partir de hook |
| A5 | Provenance + testes upstream adaptados |

**Fora de escopo neste gap:** portar todos os 14 providers ORCA de uma vez; WSL hook relay (vai com Gap D7).

---

### Gap B — Crash path: child-process-gone + UI mínima de relatório (P1 incompleto)

**Mapa:** distinguir GPU/utility; dedupe; breadcrumbs; recovery sem loop.  
**Hoje:** `wc.on('render-process-gone')` → `handleRenderProcessGone` em `window.ts`. **Não** há `app.on('child-process-gone')` consumindo classification/GPU fallback. GPU decision existe em pure module, **sem** persistência de preferência no launch.

| Item | Aceite |
| --- | --- |
| B1 | Handler `child-process-gone` no main → bridge (ou extensão) com `source: 'child'` |
| B2 | GPU fallback decision **persiste preferência** (flag/arquivo userData) e aplica no próximo launch se engajado |
| B3 | Superfície mínima de “crash report pending” (main → renderer opcional) **sem** telemetria sem consent |
| B4 | Testes: classification + bridge com child details |

---

### Gap C — Source control: token store + read PR/MR (P1/P2)

**Mapa:** forge abstraction + GitHub/GitLab **completos**; Bitbucket/Azure/Gitea flagged; Jira/Linear P3.  
**Hoje:** só `createReview` (POST create PR/MR); token **obrigatório na factory** (injetado em testes); **sem** getPR/list/review mappers; **sem** UI; **sem** resolver de token keychain/settings.

| Item | Aceite |
| --- | --- |
| C1 | Resolver token por conta (keychain/settings) injetável; zero secret em `.nexus/` de projeto |
| C2 | GitHub: create + **get PR for branch** (read) com testes mock HTTP |
| C3 | GitLab: create + **get MR for branch** com testes mock HTTP |
| C4 | Manter authz+audit em **toda** escrita; reads auditados opcionalmente |
| C5 | Bitbucket/Azure/Gitea: stubs flagged only — não expandir sem flag |
| C6 | **Não** portar Jira/Linear (P3) neste goal |

---

### Gap D — Remote/SSH production parity (P2 incompleto — **maior bloco**)

**Mapa §11.3:** `src/relay/`, `src/main/ssh/`, providers ssh-*, PTY remoto, FS, Git remoto, backpressure, handshake, WSL relay.  
**Hoje:** bridge WebSocket JSON + stream framing + path helpers; **sem** stack SSH2 mux; **sem** FS/Git remoto completo; **sem** WSL hook relay; device-pairing **sem** wire E2EE de produção.

| Sprint | Item | Aceite |
| --- | --- | --- |
| D0 | Protocolo: documentar mapa JSON-RPC bridge × binary stream × futuro SSH mux | Doc + testes de contrato |
| D1 | Import seletivo **ssh config parser / path expansion / identity filter** (módulos puros) + testes | typecheck + unit |
| D2 | SSH session manager (connect/auth/keepalive) sob `RemoteHostCapability` + scope | unit + mock ssh2 |
| D3 | Remote FS: read/list/write com path containment (`ssh-path`) + authz | unit |
| D4 | Remote Git: status/diff/fetch **read-mostly**; writes com policy | unit |
| D5 | Remote PTY via SSH + stream protocol | unit; e2e marked pending se sem host |
| D6 | Reconnect/resume: seq do terminal-stream + reattach | unit |
| D7 | WSL: path translate, shell readiness, hook path no WSL (além de detect) | unit; e2e Windows pending |
| D8 | Security: rate limit, max frame, no agent-force, scope fail-closed | testes negativos |
| D9 | E2EE/pairing unificado no bridge (mapa F5) — pairing já existe; falta crypto path real | unit |

**Critério de “F5 production-GO” (mapa):**  
não basta unit helpers — precisa **pelo menos um** caminho SSH real **ou** suite de integração com mock de transporte que exercite FS+PTY+stream de ponta a ponta no main process.

**Paridade total ORCA SSH:** ~dezenas de arquivos; fatiar **D0–D5** como MVP, **D6–D9** como follow-up se estourar.

---

### Gap E — Mobile companion (Fase 6 / P2 — **maior produto**)

**Mapa:** `mobile/`, transport, RPC, stream protocol; só após remote estável.  
**Hoje:** **sem** pasta `mobile/`; thin client HTML no bridge apenas.

#### Pré-requisitos (gate duro — se falhar, só plano)
1. Gap D MVP (D0–D5) verde  
2. Pairing + revogação de device no bridge (D9)  
3. Stream reconnect/resume estável (D6)  
4. Authz por `ProjectExecutionScope` em todo RPC  

#### Escopo se pré-requisitos OK
| Item | Aceite |
| --- | --- |
| E1 | App mobile mínimo (React Native **ou** thin client + PWA — **decidir no plan**, um stack) |
| E2 | Transport: pairing → token → stream subscribe/output |
| E3 | Features v1: list panes, read output, send input, mission list (read) |
| E4 | Writes destrutivas: confirmação explícita no device |
| E5 | Revogação de device no desktop propaga close |
| E6 | **Não** importar renderer ORCA mobile inteiro de uma vez |

#### Se pré-requisitos falharem
Entregar **apenas** plano mobile atualizado e **parar** (sem pasta `mobile/`).

---

### Gap F — Cross-platform release (mapa §9 / §11.3 / F1)

| Item | Aceite | Quem |
| --- | --- | --- |
| F1 | Smoke Windows/Linux documentado | Humano + CI se existir |
| F2 | Updater path v0.11 → v0.12 validado | Humano |
| F3 | Publicar GitHub Release + promover main | Humano |
| F4 | Decidir `training/` e lixo local (`.tsb-verify-skeptic`) | Humano |

---

### Gap G — Explicitamente **fora** do goal de paridade (P3 / anti-escopo §12)

- Themes Warp/Ghostty  
- Jira / Linear  
- Ephemeral VM runtime  
- Advanced source-control UI ORCA  
- Localization framework  
- Troca de Electron/React/Node/xterm/pnpm para “ficar igual ORCA”  
- Substituir merge queue / doctor / context harness / identity Nexus  
- Fork monorepo ORCA / importar `package.json` ORCA  

---

## 5. Invariantes (copiar para o goal execute)

1. Pin ORCA só `143c36e566483006fe54fa2716b019ec00599752`  
2. Header MIT + ledger + THIRD_PARTY_NOTICES em todo arquivo copiado/adaptado  
3. `verify-orca-provenance.mjs` PASS antes de declarar fase GO  
4. Hooks ≠ evidência (§12.4)  
5. Host remoto = capability; autoridade = `ProjectExecutionScope` local  
6. Nenhum `force` acessível a agente  
7. Sem `npm install` / `rebuild:electron` / `smoke:package` sem auth explícita  
8. Sole writer: `git log -3` + `git status` a cada pausa  
9. Typecheck por commit (verify worktree) + `npm test` 2× ao fechar cada mega-fase  
10. Não tocar `training/` salvo pedido  

---

## 6. Sugestão de fatiamento do **novo goal**

### Goal 1 — “ORCA parity P1 complete” (médio, 1–2 semanas agent) ✅ **recomendado próximo**
- Gaps **A + B + C1–C4**  
- Não inclui mobile nem SSH stack completa  
- Exit: wiring scripts PASS, typecheck, 2× npm test, relatório GO por gap  

### Goal 2 — “ORCA remote production MVP” (grande)
- Gaps **D0–D5** (+ D6/D9 se couber)  
- Exit: integração main-process stream+SSH mock e2e; checklist pending host real  

### Goal 3 — “ORCA mobile v1” (grande, só após Goal 2 GO)
- Gap **E**  
- Exit: companion usa transport de produção; ou STOP plano se D falhar  

**Não** juntar Goal 1+2+3 num único goal monólito (foi a causa de “GO” prematuro com harvest morto).

---

## 7. Prompt pronto para colar (Goal 1 — recomendado próximo)

```text
MISSÃO: Completar paridade ORCA P1 restante no Nexus (NÃO mobile, NÃO stack SSH completa).

GUIA: docs/analysis/2026-07-10-nexus-orca-integration-map.md §§11.2, 12, 13
GAP DOC: docs/analysis/2026-07-11-orca-parity-remaining-goal.md (Gaps A, B, C)

PIN ORCA: 143c36e566483006fe54fa2716b019ec00599752
REPO: /Users/cleofasrocha/dev/nexus-ide branch fix/mic-permission-v011
TIP BASE: confirmar com git log -3 (esperado ~26d0253 ou tip atual)

JÁ FEITO (não refazer): P0 reliability; F3 harvest+wire agent-runtime-bridge (renderer-gone);
F4 hosted-remote-url + forge GH/GL create-only lean; F5 stream no remote-bridge unit;
provenance ledger ~71 + verify-orca-provenance.mjs.

FAZER:
A) Managed hook installers Claude+Codex + path de ingest real; registry NÃO vazio;
   registerManagedAgentHookService em bootstrap de produção.
B) app.on('child-process-gone') no main + GPU fallback persistido em userData;
   breadcrumbs/classificação já existem — só ligar.
C) GitHub/GitLab get PR/MR for branch + token resolver injetável (keychain/settings);
   authz+audit em writes; zero secret em .nexus de projeto.

GATES: scripts/verify-agent-runtime-wiring.mjs + scripts/verify-orca-provenance.mjs PASS;
typecheck por commit; npm test 2× no close; zero secrets em .nexus projeto.

STOP: push/tag/release sem confirmação; mudar core identity/merge-queue/doctor;
mobile/; importar src/main/ssh inteiro; npm install/rebuild electron sem auth;
Jira/Linear/P3.

ENTREGÁVEL: relatório GO/NO-GO por gap A/B/C + commits + provenance.
```

---

## 8. Prompt pronto (Goal 2 — remote MVP)

```text
MISSÃO: ORCA Remote production MVP (Gap D do
docs/analysis/2026-07-11-orca-parity-remaining-goal.md).

Pré-condição: Goal P1 complete GO ou tip já com installers+child-gone+forge read.

Escopo D0–D5 do gap doc; pin 143c36e; ProjectExecutionScope autoridade local;
sem mobile. Host real Win/Linux: unit+mock se indisponível, lista PENDING.

Não substituir remote-bridge de uma vez — estrangular com capability + protocol.
E2EE real = D9 (pode ser follow-up se D0–D5 estourar).
```

---

## 9. Prompt pronto (Goal 3 — mobile)

```text
MISSÃO: Mobile companion v1 (Gap E).
Pré-condição dura: Gap D MVP GO (stream+SSH mock e2e + pairing revogável).
Se pré-condição falhar: só plano detalhado e PARE (sem pasta mobile/).
Stack: decidir thin-client vs RN no plan mode antes de código.
```

---

## 10. Métricas de “paridade” (definição honesta)

| Nível | Significado | Estado tip |
| --- | --- | --- |
| **Parity-ops** | P0+P1 reliability/hooks/SCM usable no Nexus | **quase** — falta A/B/C finish |
| **Parity-remote** | SSH/FS/PTY/stream production | **não** — só helpers + bridge local |
| **Parity-product-ORCA** | mobile + forges full + WSL hooks + automations | **longe** |
| **Parity-core** | Nunca objetivo — core Nexus permanece distinto | **OK** |

---

## 11. Inventário P0–P3 item a item (§11) — checklist de auditoria

### §11.1 P0
| Item mapa | Destino sugerido mapa | Status |
| --- | --- | --- |
| A Renderer Recovery Circuit Breaker | `reliability/renderer-recovery-circuit-breaker.ts` | **Done** + wire |
| B Worktree Removal Safety | `runtime/worktree-removal-safety.ts` | **Done** |
| C Terminal Stream Protocol | `shared/terminal-stream-protocol.ts` | **Done** + remote wire |
| D Terminal Output Scheduler | renderer scheduler | **Done** + bench |

### §11.2 P1
| Item mapa | Status |
| --- | --- |
| process-gone classification/dedupe/diagnostics | **Done** (módulos) |
| gpu-crash-fallback-decision | **Done** (pure); **persistência launch = Gap B** |
| crash-breadcrumb-store / crash-report-store | **Done** |
| agent-hook-types / listener | **Done** |
| agent-hooks installers + server | **Gap A** (registry vazio) |
| agent-awake-service | **Done** + wire |
| hosted-remote-url | **Done** |
| forge-provider + GH/GL | **Lean create only → Gap C** |
| Bitbucket/Azure/Gitea | Flagged stubs **OK** |

### §11.3 P2
| Item mapa | Status |
| --- | --- |
| SSH relay / runtime remoto | **Gap D** |
| Mobile companion | **Gap E** |
| WSL + cross-platform avançado | detect only → **D7 + Gap F** |

### §11.4 P3
| Item | Status |
| --- | --- |
| Themes, Jira, Linear, VMs, SC UI rich, i18n | **Fora** (Gap G) |

---

## 12. Próximo passo recomendado ao humano

1. **Opcional humano:** publicar Release v0.12.x + promover main + limpar `training/`.  
2. **Soltar Goal 1** (prompt §7) — fecha P1 de verdade (A+B+C).  
3. Só então Goal 2 (remote) e Goal 3 (mobile).  

Arquivo: `docs/analysis/2026-07-11-orca-parity-remaining-goal.md`
