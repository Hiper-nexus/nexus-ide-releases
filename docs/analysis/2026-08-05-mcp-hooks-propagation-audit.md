# Auditoria: o que o Nexus propaga para os panes de worker (MCP + hooks)

**Data:** 2026-08-05 · **Lane:** garantia de handoff (pane-244) · **Motivador:** "o Overclock passa os MCPs dele para TODOS os panes — o Nexus faz o mesmo, ou faz melhor?"

## Veredito em uma linha

O Nexus **já tem o Stop-hook do Overclock** — inclusive a semântica exata de "worker não para sem handoff" — mas a **propagação dele tem um furo no modo padrão do operador**, e é um furo maior do que "só Claude": nem o Claude nativo o recebe quando a política é `operator-choice`. A cobertura uniforme entre CLIs não vem (e não pode vir) de hooks; vem da camada app-side entregue nesta lane.

## O Stop-hook existe, e é forte

| Peça | Onde | O que faz |
|---|---|---|
| Política | `gate.ts:619-639` (`evaluateStop`) | Worker sem handsoff confiável recebe `allow:false` com instrução de submeter; escape após `MAX_STOP_ATTEMPTS` para nunca prender o agente para sempre. Não-worker nunca é bloqueado. |
| Autoridade | `mcp-server.ts:443-463` | O evento `stop` revalida no store: `hasTrustedFromSession(sessionId, workerIncarnationId)`. Erro de leitura **bloqueia** (fail-closed) — não fabrica aceitação. |
| Cliente | `hooks-gen.ts:260-266` + `HOOK_SCRIPT` (`:19-59`) | Hook `Stop` que consulta o gate por HTTP local e **`process.exit(2)` bloqueia a parada**. |

Isso é paridade real com o mecanismo do Overclock, não uma aproximação.

## O furo: quem realmente recebe esse hook

`shouldUseEphemeralHome` (`spawn-home-policy.ts:37-59`) decide se o HOME efêmero — **o único lugar onde `hooks-gen.ts` escreve o `Stop` do gate** — é usado:

- `:42` — `if (!adapter.quirks.mcpAutoload) return false` → **todo CLI fora da família Claude** já sai aqui;
- `:48-56` — `gated && mode === 'operator-choice' && !isThirdParty` → **o Claude nativo também sai**, para preservar Keychain/login nativos.

E o caminho de HOME real (`mcp-server.ts:798-805`) passa `--settings writeClaudeFamilyZeroClickSettings(...)`, que em `hooks-gen.ts:186-203` escreve `hooks: mergeClaudeStatusHooks({})` — **base vazia**: só os hooks aditivos de STATUS (`UserPromptSubmit`/`Notification`/`Stop` → `/hook/status`). O `Stop` do **gate** não está lá.

**Consequência concreta:** com a política `operator-choice` (a do operador), um worker Claude governado roda **sem o Stop bloqueante**. `evaluateStop` continua correto e ninguém o chama. Isso casa com o gate de 0.20.3 registrado na memória do projeto: "claude saudável mas UserPromptSubmit nunca chegou; turnStart=0/0".

## Matriz real hoje

| CLI | Superfície MCP `nexus_*` | Stop que BLOQUEIA | Rota de conclusão |
|---|---|---|---|
| Claude nativo, política `hardened` | sim (HOME efêmero) | **sim** | MCP |
| Claude nativo, política `operator-choice` (padrão) | sim (`--mcp-config` + `--strict-mcp-config`) | **NÃO** | MCP |
| GLM / LongCat (família de terceiro) | sim (HOME isolado) | não — só status | MCP |
| Codex | sim (`-c mcp_servers.*`, `mcp-server.ts:833`) | não — só status | MCP |
| OpenCode / Kimi / Grok | sim (overlay governado) | não — só status | MCP |
| AGY / Gemini | **não** (`cli-mcp-inject.ts:62`) | não | marcador no PTY stream |

## Onde o Nexus é melhor — e por quê isso não é consolo

O Stop-hook é um mecanismo **do Claude Code**. O Overclock não consegue estendê-lo a CLI nenhum fora da família — é por isso que a propagação dele é monocultura em missões de squad. Um Codex ou um Kimi no Overclock reporta por boa vontade; não há hook que os impeça de parar.

A vantagem estrutural do Nexus é o binding multi-CLI por membro, e a garantia tinha de nascer nessa camada. `worker-handoff-enforcement.ts` (commit `4ded5947`, endurecido em `b9739896`) **não depende de hook nenhum**: observa status semântico + exit de PTY, que todo CLI produz, e cobra igual em Claude, Codex, Kimi, Grok, OpenCode e AGY. Escada: carência → cutucada no pane → handoff `blocked` submetido pelo Nexus → `failed` se a sessão morreu. E, desde `b9739896`, **independente do estado da missão** — inclusive missão que se auto-encerrou enquanto o worker ainda codificava.

Ou seja: a cobertura uniforme que o item pedia **já está entregue**, por um caminho que alcança onde o modelo do Overclock não alcança.

## Delta que sobra (P1, deliberadamente FORA do hotfix)

Instalar o `Stop` do gate também no caminho de HOME real, para fechar o furo do `operator-choice`. Escrever o `nexus-gate.mjs` ao lado do arquivo de settings por token e mesclá-lo em `writeClaudeFamilyZeroClickSettings` quando `gated` é o suficiente.

**Por que não agora:** o `HOOK_SCRIPT` é fail-closed por projeto — gate inalcançável **bloqueia**. No `Stop` isso significa um worker que não consegue encerrar enquanto o gate estiver indisponível, e a contagem de `MAX_STOP_ATTEMPTS` vive no servidor, logo não protege quando é o próprio servidor que está fora. Mexer no script compartilhado do skill-gate (o mesmo que bloqueia tool calls) num hotfix, sem o E2E completo do gate de release, troca um furo conhecido e já mitigado por um risco desconhecido. A mitigação existe e está commitada: a cobrança app-side cobre exatamente esse worker.

Spec para o P1: `Stop` do gate no caminho de HOME real, com política de indisponibilidade **fail-open apenas no evento `stop`** (nunca em `pretool`), tendo `worker-handoff-enforcement` como backstop.
