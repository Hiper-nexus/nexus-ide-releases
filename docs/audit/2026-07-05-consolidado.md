# Auditoria Sênior NexusIDE — Relatório Consolidado

Missão `mission-mr7vgjyz-1`. 4 frentes auditadas em paralelo por reviewers dedicados (leitura estática, zero alteração no projeto — `git status` limpo). Total: **65 achados**.

| Frente | Achados | Altos/Críticos | Relatório |
|---|---|---|---|
| 🔒 Segurança | 13 | 5 Altos | `/tmp/nexus-audit-sec.md` |
| 🐛 Bugs & Correção | 8 | 3 Altos | `/tmp/nexus-audit-qa.md` |
| ⚡ Perf & Código | 12 | 3 Altos | `/tmp/nexus-audit-perf.md`* |
| 🎨 UX/UI | 32 | 9 Altos | `/tmp/nexus-audit-ux.md` |

\* Perf entregue via handoff MCP (conteúdo abaixo).

---

## 🔴 TOP PRIORIDADE — pontos onde 2+ reviewers convergem

### A. Lifecycle de PTY é a falha estrutural nº 1 (Segurança + Bugs + Perf)
- **SEC #1**: renderer tem acesso direto a `pty.spawn/write/kill` → uma XSS vira **RCE local**. `preload.ts:191`, `pty-ipc.ts:29`.
- **QA #1**: `destroySession()` remove a sessão do Map **antes** do `onExit`, que então retorna cedo → `pty:exit` nunca chega ao renderer, `waitForIdle` trava até timeout, tokens MCP / artifacts / gate **vazam** (`~/.nexus/ephemeral`, `mcp-configs`). `pty-manager.ts:246/401`.
- **QA #8**: `node-pty` roda **no main process** contrariando a própria `ARCHITECTURE.md` (deveria ser `utilityProcess`) → um crash nativo derruba o app inteiro.
- **Fix unificado**: mover host PTY para `utilityProcess`; criar `finalizeSession()` idempotente; tratar PTY como capability privilegiada com owner por pane, não bytes arbitrários.

### B. "Janela preta" NÃO está comprovadamente resolvida (Bugs + UX)
- **QA #3**: watchdog de mount só roda em dev (`devServerUrl`); sinal `[diag] app montado` é um `console.log` disparado antes do primeiro commit real do React; `render-process-gone` só loga em dev. **Em produção não há recovery.**
- **UX #1**: estado `exited`/`failed` do pane nem chega ao toolbar (renderer só tipa `spawning|busy|idle`) — quando o agente morre, o usuário perde o sinal visual.
- **Fix**: IPC `renderer:mounted` dentro de `useEffect` pós-commit; watchdog + ErrorBoundary também em produção; ampliar `PaneSessionState` para incluir `exited|failed|unknown`.

### C. pane-pipe e buffers — custo O(n) e leaks (Perf + Bugs)
- **PERF #2**: cada chunk de PTY varre todos os pipes × todos os panes (linear `findPane`) — 87ms/10k chunks a 64 panes.
- **PERF #3 + QA #6**: buffers de 256KB e pipes ficam **órfãos após exit** (só marca `exited=true`, nunca remove do Map) → leak em app de longa duração.
- **Fix**: índice `sessionId → pipes`; `prunePipesForLivePanes()` no `syncPanes()`; TTL/LRU para buffers encerrados.

---

## 🔒 Segurança — os 5 Altos
1. **RCE via PTY exposto ao renderer** (ver A).
2. **IPC de arquivos usa `os.homedir()` como sandbox** quando não há workspace ativo → renderer comprometido lê `~/.ssh/id_rsa`, escreve `~/.zshrc`. `workspace-store.ts:74` — deve **falhar fechado**.
3. **Escape por symlink** em escrita de arquivo novo: `safeResolve` só checa lexicalmente quando o alvo não existe → symlink de dir pai escapa a sandbox. `files-ipc.ts:37`.
4. **`binPath`/`extraArgs` de provider configuráveis pelo renderer** → executa binário arbitrário no contexto do usuário. `provider-config-store.ts:332`, `pty-manager.ts:318`. Exigir confirmação + validação por hash.
5. **Ferramentas MCP de pane sem autorização por missão/owner/role** → agente lê/escreve pane de outro agente ou do usuário (escape lateral). `tools-panes.ts:106`, `gate.ts:51`. `allowedTools: null` = irrestrito.

Médios notáveis: voice `run_command` gerado por LLM executado **sem confirmação** (prompt-injection voz→comando); remote-debugging na porta 9223 em dev; PATH confia em dirs graváveis; catálogo remoto não pinado instala em `~/.claude`.

## 🐛 Bugs — os 3 Altos
1. `kill/close` suprime `exit` (ver A) — **o bug mais crítico**.
2. `nexus_pane_spawn` pendura 20-30s quando renderer fecha/crasha: `rendererAvailable()` não checa `isCrashed()`, `send()` sem try/catch, `pendingSpawns` nunca resolvidos no unregister.
3. Janela preta parcial (ver B).

Médios: `loadURL` rejeitado vira unhandled rejection (`window.ts:122`); `write` em PTY morto explode/retorna falso `{ok:true}`; subprocessos de voz (`say`/piper/whisper com `execFileSync` **sem timeout**) travam o main e não morrem no quit.

## ⚡ Perf — destaques
Altos: strip ANSI global em todo chunk para fallback legado (104ms/10k); scan O(chunks×pipes×panes); buffers retidos pós-exit. Médios: `waitForIdle` deixa timers vivos e `returnOn:any` não cancela perdedores; `pane_read` reprocessa 256KB a cada leitura; heartbeat `syncPanes` roda 1×/s para sempre; 3 implementações duplicadas de `waitForSession` (polling 150ms). Baixos: addons xterm (Search/Serialize) carregados e não usados; viewport persiste a cada frame de pan/zoom.
**Checks**: `npm test` verde (230 testes); **`npm run typecheck` VERMELHO** por `src/main/adapters/auth-probe.ts` (untracked, importa tipos inexistentes) — precisa resolver.

## 🎨 UX — os temas
- **Estados de agente invisíveis**: `exited`/falha não chegam ao toolbar; status codificado em glifos `●◌○` + `title`; spawn pode falhar 20s em silêncio.
- **Acessibilidade quebrada**: botões de pane usam `onMouseDown` (não funcionam por teclado); ícones só com `title` sem `aria-label`; panes não focáveis/navegáveis; `focus-visible` inconsistente.
- **OrchestrationPanel é "debug view"**, não timeline de missão; handoffs não mostram destino/pendente/artefatos; empty states expõem nomes de tools (`nexus_mission_create`) em vez da próxima ação.
- **"Look de IA"**: emoji como iconografia (`🗂⚙👥✦💾`), glass/orb/gradiente no Voice HUD, uppercase+letter-spacing em excesso, `--text-dim` ~4:1 (abaixo do AA para texto pequeno).

---

## Ordem de execução sugerida
1. **PTY**: `utilityProcess` + `finalizeSession()` idempotente + capability por pane. (resolve A, maior parte de B e C)
2. **Sandbox de arquivos**: fail-closed sem workspace + realpath do pai + rejeitar symlink.
3. **Autorização MCP por objeto** (missão/owner/role) + `allowedTools` explícito nos squads.
4. **Janela preta**: IPC mount pós-commit + watchdog/ErrorBoundary em produção.
5. **Perf**: índice de pipes + TTL de buffers + eliminar heartbeat/polling duplicado.
6. **UX crítico**: estados de pane, `onClick`+`aria-label`, timeline de missão.
7. Corrigir o `typecheck` vermelho (`auth-probe.ts`).
