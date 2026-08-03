# Fail-fast MCP auth + gap de panes paralelos do mesmo LLM

**Data:** 2026-08-02  
**Objetivo:** missão fan-out em `done` limpo; Overclock sobe ~12 terminais.

---

## 1. O que foi feito (Nexus)

### Prevenção — Codex operator-choice gated

`prepareCodexOperatorMissionHome` (`cli-mcp-session-codex.ts`), wired em
`pty-manager.ts` no ramo `gatedSpawn && isFrictionless`:

- CODEX_HOME privado com `auth.json` linkado
- `mcp_servers` do `~/.codex/config.toml` real **removidos**
- Nexus continua via `-c mcp_servers.nexus_*` (`codexMcpArgs`)
- Sem Seatbelt/deny table (mantém autopiloto frictionless)

Causa de campo: workers Codex herdavam cloudflare-api / higgsfield / figma do
perfil real e travavam no handshake antes do prompt.

### Fail-fast — login-stuck + handoff sintético

`login-stuck-watchdog.ts`:

- Novos padrões `mcp-auth`: `not logged in`, `handshake failed`, MCP
  unauthorized/auth failed
- Não limpa `mcp-auth` só porque semantic status = `working` (handshake pode
  parecer busy com quietKey congelado)
- Em stuck MCP: handoff sintético `failed` (`fromAgent=nexus-watchdog`), mesmo
  padrão não-destrutivo do stall-watchdog — acorda o Maestro

### Verificação

- `login-stuck-watchdog.test.ts`: 16 testes OK
- `prepareCodexOperatorMissionHome`: 1 teste OK
- `npm run typecheck`: limpo

Prova ao vivo `done` nesta passada: **não revalidada** — o ambiente QA sofreu
churn de ABI (`better-sqlite3` Node 127 ↔ Electron 148) e queda do Vite/CDP
durante o smoke. O ciclo de handoff `queued→consumed` já estava provado na
sessão anterior (`HANDOFF_PROOF=PASS`).

---

## 2. OmniRoute / Orca

| Fonte | Útil para este bug? | Motivo |
|-------|---------------------|--------|
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | **Não** | Gateway multi-provider / MCP de API — sem hang de MCP ambient no spawn de worker CLI |
| [Orca](https://github.com/stablyai/orca) hang-watchdog | **Não** | Detecta freeze da **main thread** Electron (`main-thread-hang-watchdog`), não auth MCP de pane |

Tudo acima foi inventado/adaptado **dentro do Nexus** (extensão de
login-stuck + stall-watchdog + overlay Codex estilo kimi governed).

---

## 3. Gap Overclock: N panes do mesmo LLM (~12)

| Dimensão | Overclock (vídeo) | Nexus hoje |
|----------|-------------------|------------|
| Capacidade dura | ~12 panes | `maxWorkers` default **12** (risk normal/sensitive); schema até **64**; destructive = 1 |
| Limite por adapter | Vários do mesmo LLM | **Sem** gate 1:1 por `adapterId` em `nexus_pane_spawn` |
| O que freia na prática | — | Roster com poucos agents distintos; Maestro tende a 1 pane por papel; prompts não pedem fan-out homogêneo |

**Conclusão:** não há bloqueio artificial “um pane por LLM” no spawn. O teto
útil era `maxWorkers=8` (agora **12**, alinhado ao Overclock) e o comportamento
do Maestro/roster. Para forçar fan-out homogêneo:

1. ~~Subir preset `maxWorkers`~~ — feito (12)
2. Instruir o Maestro a spawnar N workers do mesmo `adapterId` com títulos
   distintos (ad-hoc `adapterId` sem `agentName`, ou N agents no roster com o
   mesmo `cli`)
3. Opcional: squad “parallel-smoke” com 8–12 executors Codex iguais

Próximo passo de produto (não código de spawn): brief de fan-out dizendo
explicitamente “pode abrir vários panes do mesmo CLI em paralelo até
maxWorkers”.
