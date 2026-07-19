# Análise senior — MoonshotAI/kimi-cli → Nexus

Data: 2026-07-18  
Fonte: [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) (Apache-2.0, ~9.5k★, Python)  
Successor: o README anuncia evolução para **[Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)** (~3.6k★); instalar Kimi Code migra config/sessões.  
Licença: Apache-2.0 — inspiração / reimplementação limpa; **não** vendor monorepo.

**Regra Nexus:** cockpit multi-CLI. Kimi já é um motor hospedado (`src/adapters/builtin/kimi.json` → bin `kimi`, package `@moonshot-ai/kimi-code`). Não substituímos PREVC/MCP/worktrees por Wire/ACP do Kimi.

---

## 0. TL;DR

| Veredito | Detalhe |
|----------|---------|
| **Já temos o essencial** | Adapter PTY, models, OAuth/managed home, `KIMI_MODEL_*` env, resume `--continue`/`--session`, YOLO `--yolo`, MCP host quirk `nexusMcp: kimi` |
| **Aproveitar (alto valor, baixo risco)** | Print/quiet headless; AFK/yolo flags; session resume/export patterns; subagent taxonomy *explore / plan / coder* como *inspiração* de roster |
| **Aproveitar (médio, design)** | Wire mode como *padrão* (JSON-RPC stdio + external tools) se um dia quisermos RPC nativo Kimi — espelho do que omp-rpc já faz |
| **Não portar** | Monorepo Python (kosong/pykaos), shell-mode Ctrl-X, VS Code extension, Zsh plugin, multi-provider LLM dentro do Kimi (Nexus escolhe o CLI) |
| **Atenção** | Repo `kimi-cli` está em *wind-down*; alinhar install/docs com **kimi-code** como binário canônico |

---

## 1. O que o kimi-cli é

Agent de terminal da Moonshot com:

- Tools nativas: Shell, Read/Write/StrReplace, Glob/Grep, web, plan mode, todos, background tasks, subagents
- **Wire** (`--wire`): JSON-RPC 2.0 stdin/stdout (v1.10) — UI custom, IDE embed, testes
- **ACP** (`kimi acp`): Agent Client Protocol multi-session
- **Print mode** (`--print` / `--quiet`): non-interactive, auto-AFK, stream-json
- **Hooks** (beta): Pre/PostToolUse, SessionStart/End, Pre/PostCompact, Notification…
- **MCP client** nativo + OAuth MCP
- **Sessions**: continue/resume/fork/export/import; persiste YOLO/AFK/plan/subagents
- **Ralph loop**: re-alimenta o mesmo prompt até STOP ou limite
- Subagents embutidos: **explore** (RO), **plan** (RO design), **coder** (implementa)

Arquitetura interna: packages `kimi-code` / `kosong` / `kaos` — runtime agent Python, **não** encaixa no Electron do Nexus.

---

## 2. O que o Nexus **já** cobre

| Capacidade kimi-cli | No Nexus |
|---------------------|----------|
| Spawn PTY `kimi` | `kimi.json` interactive |
| Headless prompt | `kimi -p {{PROMPT}}` (sem `--print`/`--quiet` ainda) |
| Resume | `resumeArgs: --continue`, `resumeIdArgs: --session` |
| Autonomia | `control.permission.yolo: ["--yolo"]` + autonomous policy |
| Auth API key | `KIMI_MODEL_API_KEY` + `buildKimiApiKeyRuntimeEnv` |
| Auth OAuth | managed home `.kimi-code` / credentials |
| Model flag | `--model` + catálogo `kimi-code/*` |
| MCP Nexus → agente | quirk `nexusMcp: "kimi"` |
| Skills scan | `~/.kimi-code/skills` em catalog |
| Multi-CLI + PREVC | Superior ao plan mode interno do Kimi (autoridade Nexus) |
| Background tasks | `nexus_bg_*` (host), não `TaskList` do Kimi |
| Plan lane | `lane=plan` Nexus (plan.md), não `EnterPlanMode` do Kimi |
| Circuit / route | task-router multi-score |

**Conclusão:** Kimi no Nexus é **CLI PTY bem integrada**. O gap não é “suportar Kimi”; é **tirar mais proveito dos modos headless/protocolo** e **não reinventar subagents** que o Kimi já faz *dentro* do processo.

---

## 3. Matriz de valor (o que transplantar)

### P1 — Headless de produção (flags do binário real)

**Importante (2026-07-18):** o binário instalado via `@moonshot-ai/kimi-code`
(`kimi --help`) **não** expõe `--print` / `--quiet` da doc legada kimi-cli.
Flags reais:

| Flag | Efeito |
|------|--------|
| `-p` / `--prompt` | Uma prompt **non-interactive** e imprime a resposta |
| `--output-format text\|stream-json` | Formato de saída no prompt mode |
| `-y` / `--yolo` | Auto-aprova ações |
| `--auto` | Permission mode “auto” |
| `--plan` | Plan mode nativo do Kimi (preferir lane=plan do host) |

**Entrega Nexus (implementada):**

```jsonc
// src/adapters/builtin/kimi.json
"headless": ["kimi", "-y", "--output-format", "text", "-p", "{{PROMPT}}"]
"permission.yolo": ["-y"]
```

- Usar em **eval/benchmark** e spawns headless.
- Critério: termina sem hang em confirmação de tool.

### P2 — Flags de autonomia alinhadas ao produto

| Flag Kimi | Uso Nexus |
|-----------|-----------|
| `--yolo` | Já no adapter |
| AFK (implícito no `--print`) | Preferir print headless a inventar `--afk` se a doc mutar |
| YOLO session persistence | Não portar store do Kimi; nosso yolo é por pane/mission |

**Não** relaxar sandbox Electron nem PREVC.

### P3 — Subagent roles como *roster pattern* (inspiração, não fork)

Kimi define subagents:

| Role | Tools | Análogo Nexus |
|------|-------|---------------|
| **explore** | read + shell RO | worker `consult` / scout no harness-enrich |
| **plan** | read + web, sem write/shell | **lane=plan** + plan.md (já shipped) |
| **coder** | write + shell | worker standard PREVC |

**Aproveitar:** nomes/`when_to_use` em squad recipes e harness blurb — **não** spawner de subagent YAML do Kimi. Orquestração de workers é do Nexus (worktrees + MCP).

### P4 — Wire mode (só se doer PTY)

**Wire** = JSON-RPC + `initialize` + `external_tools` + approvals + hooks no cliente.

| Comparável | Estado |
|------------|--------|
| omp-rpc | Já existe no Nexus (RPC UI/host tools) |
| Wire Kimi | Protocolo **diferente**, Python-centric |

**Veredito:** **não implementar Wire agora**. Se Kimi PTY + injectPrompt continuar frágil (menus, CR), reavaliar um **kimi-wire thin client** no main (mesmo espírito omp-rpc). Prioridade abaixo de print/quiet.

### P5 — ACP

`kimi acp` é para Zed/JetBrains. Nexus é host PTY + MCP, não ACP client genérico.

**Fora:** ACP server/client no Electron.  
**Ok:** documentar que utilizadores Zed usam `kimi acp` *fora* do Nexus.

### P6 — Hooks lifecycle

13 eventos (PreToolUse… PreCompact). Nexus já tem hook pipeline multi-CLI + seatbelt.

**Aproveitar (leve):** se Kimi hooks forem estáveis, mapear `PreCompact`/`SessionEnd` para telemetria — **não** reimplementar engine TOML de hooks.

### P7 — Sessions export/import/fork

Kimi: `/export` markdown, resume state (approvals, plan mode).

**Aproveitar:** ideia de *resume hint* e compact handoff (já temos session-compaction + handoffs). Não copiar store `~/.kimi/sessions`.

### P8 — Ralph loop

Loop do mesmo prompt até STOP.

**Nexus:** mission driver / stall recovery / maxSteps já cobrem “não desistir cedo”. Ralph genérico **não** entra no core (risco de custo infinito).

### P9 — Multi-provider dentro do Kimi

Kimi pode falar Anthropic/OpenAI/Gemini via `providers` no config.toml.

**Rejeitar no Nexus:** cada adapter é um CLI; se o user quer Claude, spawna `claude`. Não transformamos Kimi num meta-router (isso é omp / route_task).

---

## 4. Riscos e armadilhas

1. **Wind-down de kimi-cli** — docs/flags podem divergir de `kimi-code`. Pinar testes de smoke em `kimi --help` real do bin instalado.  
2. **Headless sem `--print`** — `-p` sozinho pode ainda esperar TUI; print/AFK é o caminho seguro.  
3. **Duplicate MCP** — Kimi como *client* MCP + Nexus como *host* MCP: risco de tool soup. Preferir **só** Nexus MCP inject no pane (já é o modelo).  
4. **`--add-dir`** — expandir FS do Kimi além do checkout quebra o isolation Nexus; **não** passar add-dir por omissão.  
5. **Plan mode dual** — `EnterPlanMode` do Kimi vs `lane=plan` Nexus. Em missões Nexus, o gate de tools do host manda; não depender do plan mode interno do Kimi.

---

## 5. Plano de ação recomendado

| PR | Escopo | Prioridade |
|----|--------|------------|
| **K1** | `kimi.json` headless → `-y --output-format text -p` (+ testes) | **done** |
| **K2** | Alinhar yolo a `-y`; validar help real do bin | **done** |
| **K3** | Docs `adding-a-cli.md` / orchestration: Kimi Code canónico | **done** |
| **K4** | Squad builtin `kimi-code-cell` (explore/plan/coder) | **done** |
| **K5** | Wire RPC client | **só se** PTY Kimi falhar em produção |
| — | Fork monorepo / ACP host / Ralph default | **não** |

---

## 6. Comparação rápida com análises anteriores

| Origem | O que valeu a pena no Nexus |
|--------|-----------------------------|
| **x-algorithm / grok-build** | Route multi-score, CoW, plan lane host, bg MCP, sandbox profiles |
| **omp** | RPC UI, zero-friction spawn, diversity no router |
| **kimi-cli** | Headless print/quiet, subagent *roles* como inspiração de squad, Wire só se PTY doer; resto já coberto |

---

## 7. Decisão

**Sim, há o que aproveitar — mas é estreito e pragmático.**

1. Tratar Kimi como **motor de código Moonshot bem hospedado** (já é).  
2. Subir qualidade **headless** com print/quiet.  
3. Usar taxonomia explore/plan/coder só como **linguagem de squad**, espelhando o que já fizemos com lane=plan no host.  
4. **Não** reescrever harness Nexus, **não** portar Wire/ACP/hooks engine, **não** multi-provider dentro do Kimi.

Próximo passo de implementação (se aprovado): **PR-K1** no `kimi.json` + testes de spawn headless.
