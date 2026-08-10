# Xirp Parity Clean-Room — Persistência de sessão + Project Overview

**Status:** aprovado e implementado (base A+B, 2026-08-10)  
**Escopo:** fatias **A** (PTY persistente via tmux) + **B** (project-first + minimap + goal box)  
**Referência observada:** Spotify Xirp 0.12.0 / Chirp (binário local + docs Backstage)  
**Método:** clean-room — modelo de produto apenas; **zero** código do asar Spotify  
**Referências internas:** `docs/ARCHITECTURE.md`, `src/main/pty/`, `src/renderer/state/product-navigation-store.ts`, `src/shared/feature-flags.ts`, canvas `xirp-vs-nexus-raspagem.canvas.tsx`

## 1. Problema

O NexusIDE já supera o Xirp em orquestração (MissionEngine, squads, MCP, sandbox,
voz). O gap de produto é UX de flock:

1. **Quit mata o agente.** Fechar o app encerra o PTY; reopen respawna contexto
   fresco. Xirp (via squab/tmux) detach/attach.
2. **Não há superfície project-first.** A navegação é launcher → terminal →
   missão. Falta um overview do repo com sessões, status e um goal box que
   spawna sessão (+ worktree opcional).

Sem (1), um overview (2) mostra processos mortos após quit. Por isso A e B
entram na mesma onda, nesta ordem.

## 2. Decisão

Entregar **A → B** atrás de feature flags, sem daemon WS separado e sem epics.

| Fatia | Entrega | Flag |
|-------|---------|------|
| A | Sessão sobrevive ao quit (tmux detach/attach) | `feature.pty.persistentSession` |
| B | Destinação Projeto + overview + minimap + goal box | `feature.ui.projectOverview` |

**Fora de escopo (ondas futuras):**

- C — daemon WebSocket separado (`@chirp/daemon`-like)
- D — epics / digests / PR watch acima das missões
- Hardcodar só Claude/Codex/Gemini (Nexus mantém adapters JSON)
- Descompilar / portar asar Spotify (proibido)

**Não alterar:** MissionEngine como autoridade de missão; seals de pane
persistido; Seatbelt/Bubblewrap fail-closed; ContextualPanel Files/Git/Skills
como painel lateral (não vira full-page Xirp).

## 3. Fatia A — Persistência de sessão

### 3.1 Modelo

```
Quit app  → detach (agente continua no tmux)
Reopen    → attach à sessão tmux existente
Close pane → kill real da sessão tmux
Sem tmux  → fallback PTY direto (comportamento atual) + aviso único
```

O processo raiz do host, quando a flag está ON e `tmux` está no PATH, passa a
ser um client/session tmux. O CLI do agente roda **dentro** da sessão tmux,
não como filho direto do utilityProcess sem intermediário.

### 3.2 Componentes

| Componente | Path proposto | Responsabilidade |
|------------|---------------|------------------|
| Flag | `src/shared/feature-flags.ts` | `feature.pty.persistentSession` |
| Backend | `src/main/pty/persistent-session.ts` (+ `.test.ts`) | probe tmux, create, attach, detach, kill, list |
| Registry | SQLite em userData (better-sqlite3, alinhado à arquitetura) | `paneId → tmuxSessionName`, cwd, createdAt |
| Quit path | `pty-manager` shutdown | detach em vez de terminate/kill quando flag ON e sessão mapeada |
| Spawn/resume | `pty-manager` / `pty-ipc` | se tmux session existe → attach; senão create+spawn |

### 3.3 Contratos

- **Nome tmux:** `nexus-<paneId>` (estável; não usar `pty-*` efêmero).
- **Probe:** `tmux -V` + `has-session -t <name>`; timeout curto; falha = fallback.
- **Flag default:** `defaultEnabled: true` no canal `dev`; kill-switch permanece.
- **Sandbox:** Seatbelt/Bubblewrap continua no tree; se o profile rejeitar o
  wrapper tmux, log + fallback PTY direto (não bloquear spawn).
- **Mission resume / authority:** attach não recria grant; reusa o mesmo
  `persisted-pane` seal. Se o processo dentro do tmux morreu, attach falha →
  spawn fresco com as regras atuais de resume.
- **Linux/Windows:** A v1 é **macOS-first** (paridade com Xirp beta). Linux
  tmux no mesmo backend se PATH ok; Windows fica flag-off / no-op até spike.

### 3.4 IPC / eventos

Sem canal novo obrigatório no preload se o manager encapsular. Opcional
(flag ON):

- `pty:persistence` push → `{ sessionId, paneId, mode: 'direct' \| 'tmux', aliveOutsideApp: boolean }`
- Renderer usa isso só no minimap (B).

### 3.5 Testes A

- unit: nome tmux, probe ausente, create/attach/kill com mock `child_process`
- unit: quit path chama detach, não kill, quando flag ON
- unit: close pane chama kill da sessão tmux
- unit: flag OFF = caminho atual intacto
- integração leve: registry SQLite sobrevive round-trip insert/list/delete

## 4. Fatia B — Project Overview

### 4.1 Navegação

Estender `ProductDestination`:

```ts
| { kind: 'project' }
```

- `WorkspaceRail`: item **Projeto** (visível só com flag ON).
- `openProject()` no `product-navigation-store`.
- Clique em sessão no overview → `openTerminal()` + foco do pane.
- Missão (`mission` board/terminals) **não** é substituída.

Flag: `feature.ui.projectOverview`, `defaultEnabled: true` em `dev`.

### 4.2 Superfície

Uma composição (não dashboard multi-card):

1. **Header do repo** — nome do workspace, branch, indicação de worktree ativa
   (git/stores existentes).
2. **Goal box** — prompt + seletor de adapter/agente + toggle “worktree
   isolada” → spawna pane via APIs já usadas pelo terminal/missão (sem segundo
   motor de spawn).
3. **Flock / minimap** — lista compacta de sessões do workspace:
   - label, adapter, status semântico (`working` / `idle` / `awaiting-input` /
     `exited` via hooks + `session-state-store`)
   - badge worktree quando aplicável
   - badge “fora do app” quando A reporta `aliveOutsideApp`
   - click → foca; close → kill (igual close pane)
4. **Atalho Cmd+G** — abre/foca Project Overview (documentar no cheatsheet).

### 4.3 Fontes de dados (sem schema pesado)

| Fonte | Uso |
|-------|-----|
| layout / panes do workspace | inventário de sessões |
| `session-state-store` + agent semantic status | badges |
| worktree registry (já main-owned) | path/branch em panes de missão |
| git / workspace store | header |
| persistence map (A) | badge aliveOutsideApp + reattach na reopen |

### 4.4 Testes B

- navigation store: `openProject` / rail destination
- ProjectOverview: render com N panes mockados + status
- goal box: chama spawn com adapter + cwd/worktree flag (mock IPC)
- Cmd+G registrado só com flag ON
- flag OFF: rail sem item Projeto; destino `project` redireciona para terminal

## 5. Integração A ↔ B

| Momento | Comportamento |
|---------|---------------|
| Spawn com A+B ON | cria tmux `nexus-<paneId>`; overview lista a sessão |
| Quit | detach; overview (após reopen) lista sessões tmux órfãs do registry e oferece attach |
| Attach | foca terminal; badge “fora do app” some |
| Close no minimap | kill tmux + remove do layout |
| Só B ON / A OFF | overview funciona; quit ainda mata processos |

## 6. Segurança

- Persistência **não** enfraquece sandbox: wrapper tmux é opt-in; fallback se
  profile falhar.
- Registry em userData não guarda tokens; só `paneId`, tmux name, cwd.
- Close pane / kill continua a única forma de mortar o agente; quit não é kill.
- Clean-room: nenhum arquivo do `/Applications/Xirp.app` entra no repo.

## 7. Ordem de implementação

1. Flags A + B em `feature-flags.ts`
2. `persistent-session.ts` + testes + registry
3. Quit=detach / reopen=attach em `pty-manager`
4. Destinação `project` + rail + shell vazio
5. Flock/minimap com status existente
6. Goal box + Cmd+G
7. Badge `aliveOutsideApp`
8. `npm run typecheck` + vitest dos arquivos tocados

## 8. Critérios de aceite

- [ ] Com tmux instalado e flag A ON: quit app → processo do agente ainda vivo (`tmux ls`); reopen → attach sem respawn fresco se a sessão existir.
- [ ] Close pane → sessão tmux destruída.
- [ ] Sem tmux → app funciona como hoje; um aviso; sem crash.
- [ ] Flag B ON → rail Projeto; overview lista panes com status semântico.
- [ ] Goal box spawna pane no workspace atual.
- [ ] Cmd+G abre Project.
- [ ] MissionEngine / mission destinations inalterados em comportamento.
- [ ] Typecheck e testes co-localizados verdes.

## 9. Riscos

| Risco | Mitigação |
|-------|-----------|
| Seatbelt rejeita tmux wrapper | fallback direto + telemetria/log |
| paneId colide entre workspaces | prefixar `nexus-<workspaceId>-<paneId>` se necessário na implementação |
| Sessão tmux zumbi após kill falho | `kill-session` + `has-session` no reopen; limpar registry |
| Overview vira segundo Ops Board | escopo rígido: header + goal + flock; sem board de missão |

## 10. Aprovação

- Design verbal A+B: aprovado pelo usuário (“siga” / “a+b”) em 2026-08-10.
- Este arquivo: **aguardando review** antes do plano de implementação
  (`docs/superpowers/plans/…`).
