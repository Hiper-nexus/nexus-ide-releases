# PROMPT DE MISSÃO — cole numa nova sessão (Claude Code, repo ~/nexus-ide)

---

Você é o executor da integração **oh-my-pi × NexusIDE**. A análise senior já foi feita; sua missão é EXECUTAR: pegar código pronto (MIT) do oh-my-pi, vendorar e integrar com o que já temos. NUNCA reescreva do zero o que existe pronto lá. Trabalhe rápido e autônomo (modo yolo): não pare para perguntar — decida, implemente, teste, commite. Só pare se algo for destrutivo fora da sua branch.

## CONTEXTO

- **NexusIDE** (este repo): IDE Electron macOS multi-agente — grid de panes PTY com CLIs de IA (claude, codex, agy, kimi, grok...), orquestração de squads/missões/handoffs via MCP embutido (114 tools `nexus_*`), multi-conta com failover (Keychain + resume), companion mobile com QR, voz Jarvis. Electron + React + TS strict, better-sqlite3, zod em toda fronteira. 4.649 testes passando — mantenha verde.
- **oh-my-pi (omp)**: coding agent standalone de terminal (github.com/can1357/oh-my-pi, MIT, v17), TS/Bun + Rust. Tem pronto o que nos falta: modo RPC tipado, hashline (edições por hash), collab E2E com QR, catálogo de 3.841 modelos com preços, classificadores de rate-limit, memória SQLite, LSP/DAP.
- **A análise completa com o racional de cada decisão** está commitada na branch `worktree-oh-my-pi-deep-dive`. LEIA ANTES DE CODAR:
  ```bash
  git show worktree-oh-my-pi-deep-dive:docs/analysis/2026-07-15-oh-my-pi-crossover-senior.md
  ```

## FASE 0 — SETUP (faça exatamente isto)

```bash
# 1. Worktree isolado (outras LLMs codam em paralelo — NUNCA trabalhe no checkout principal)
#    Use a tool EnterWorktree se disponível; senão:
git worktree add .claude/worktrees/omp-integration -b feat/omp-crossover origin/main

# 2. Traga a análise para sua branch (o doc guia tudo)
git cherry-pick a805941

# 3. Clone o omp PINADO no commit auditado (a análise refere esse estado)
git clone https://github.com/can1357/oh-my-pi /tmp/omp-src
cd /tmp/omp-src && git checkout 03c48d073 && cd -   # SHA auditado em 2026-07-15

# 4. (Se gh estiver autenticado) fork para nossa org — referência estável p/ diffs futuros
gh repo fork can1357/oh-my-pi --clone=false || true

# 5. Baseline verde ANTES de mexer (Node 22/24 LTS obrigatório — Node 26 quebra o make)
node --version && npm install && npm run typecheck && npm test
```

## REGRAS INVIOLÁVEIS

1. **Vendoring**: código deles vai para `src/vendor/omp/<pacote>/` com o LICENSE original + header `// Vendored from can1357/oh-my-pi@03c48d073 — MIT` + entrada nova no `THIRD_PARTY_NOTICES.md` (siga o formato das entradas Orca existentes). Cópia pinada — **PROIBIDO** adicionar dependência npm `@oh-my-pi/*`.
2. **De-Bunificação**: o código deles usa APIs Bun. Trocas padrão: `bun:sqlite`→`better-sqlite3` (já usamos), `Bun.serve`→`node:http`/`ws`, `Bun.file/write`→`node:fs`, `Bun.hash.xxHash32`→pacote xxhash JS/WASM (**o valor do hash tem que ser idêntico** — valide contra fixtures deles), text-imports `with {type:"text"}`→string/raw-loader. Porte os TESTES deles junto — são o mapa.
3. **Licença**: NUNCA copiar nada de `src/markit/` nem qualquer coisa que toque mupdf (**AGPL**). NUNCA embutir o binário omp no repo ou no instalador — o usuário instala via brew/curl (nosso adapter já tem fluxo `install`).
4. **Segurança**: NUNCA portar o `auth-storage` deles (credenciais em claro — as nossas ficam no Keychain). NUNCA afrouxar nada em `src/main/security/`. A `mobile-companion-policy.ts` fica POR CIMA de qualquer transporte novo.
5. **Git**: tudo na sua branch. Push da branch ok. **NUNCA** merge/push em main. Um commit por entrega no mínimo, mensagens em pt-BR no padrão do repo (`feat(omp-a1): ...`). `npm run typecheck && npm test` verdes em CADA commit.
6. **Leia o doc do omp antes de cada entrega** — eles documentam bem: `/tmp/omp-src/docs/{rpc,mcp-config,session,collab,lsp-config}.md`.
7. Use subagents para paralelizar (portar testes, ler código deles) quando ajudar.

## ENTREGAS (nesta ordem — cada uma é um commit independente e testável)

### A1 — Adapter omp no grid (esforço XS — o omp vira mais uma CLI hospedada HOJE)
- **Criar** `src/adapters/builtin/omp.json` seguindo `docs/adding-a-cli.md`: `bin: "omp"`, `detect: "omp --version"`, install `brew install can1357/tap/omp` (+ hint curl `https://omp.sh/install`), spawn interactive `["omp"]`, headless `["omp","-p","{{PROMPT}}"]`, `resumeArgs: ["--continue"]`, `resumeIdArgs: ["--resume"]`, models flag `--model` (lista: deixe 3-4 ids reais do catálogo deles), `quirks.altScreen: true`.
- **Aprovação**: use o bloco `control` (veja como `claude.json` mapeia `--permission-mode`): mapear os modos do omp via flag de approval (`/tmp/omp-src/docs/approval-mode.md`) com **default yolo** (preferência do operador) e opção safe/write no launcher.
- **MCP**: implementar injeção `quirks.nexusMcp: "omp"` no wiring existente (como fizemos p/ codex/agy/kimi): escrever `.omp/mcp.json` no workspace apontando para `NEXUS_MCP_URL` com o bearer token (confira transport http em `/tmp/omp-src/docs/mcp-protocol-transports.md`). Com isso o omp já entra em squad como worker/orquestrador.
- **Aceite**: pane omp abre no grid, responde prompt, aparece no picker de squad, chama tools `nexus_*` via MCP.

### A2 — Catálogo rico de modelos (S)
- **Fonte**: `/tmp/omp-src/packages/catalog/src/models.json` (59 providers, 3.841 modelos: custo/MTok, contextWindow, capabilities) + `/tmp/omp-src/packages/catalog/src/identity/` (TS puro, sem Bun).
- **Destino**: `src/vendor/omp/catalog/` + integrar em `src/main/adapters/model-catalog.ts` como camada de metadados ricos (preço/janela/capacidades por modelo). Nosso schema atual (availability/costTier) continua autoridade; o deles enriquece. Atualizar o `resources/model-catalog.json` publicável se fizer sentido.
- **Aceite**: teste que resolve preço+janela para ≥5 modelos que usamos (claude, codex, glm, deepseek, kimi); UI de launcher mostra janela/custo quando disponível.

### A3 — Classificadores de rate-limit somados ao limit-detector (S)
- **Fonte**: `/tmp/omp-src/packages/ai/src/error/rate-limit.ts` (`parseRateLimitReason` — distingue QUOTA_EXHAUSTED de RATE_LIMIT transitório, padrões EN/zh) + `/tmp/omp-src/packages/ai/src/utils/retry-after.ts`.
- **Destino**: `src/vendor/omp/rate-limit/` + integrar em `src/main/orch/limit-detector.ts` SEM remover nossos padrões PT-BR. Regra nova de decisão: transitório NÃO entra em cooldown de conta (hoje somos binários).
- **Aceite**: casos deles + nossos passam em `limit-detector.test.ts` estendido; falso-positivo de "rate limit" citado em prosa continua não disparando (tem teste nosso disso — não quebre).

### A4 — Squad builtin "Review P0–P3" (S)
- **Fonte**: `/tmp/omp-src/packages/coding-agent/src/prompts/agents/reviewer.md` + `src/prompts/review-request.md` + lista de exclusão de ruído (locks/minified/generated/vendor) em `src/extensibility/custom-commands/bundled/review/index.ts`.
- **Destino**: novo squad em `src/main/orch/builtin-squads.ts` (orquestrador + N reviewers read-only agrupados por localidade) com schema de findings no handoff: `{priority: P0|P1|P2|P3, confidence: 0-1, title ≤80ch, file, lines, verdict}` validado por zod.
- **Aceite**: squad aparece na UI ⛭ Orch; missão de review num diff de teste produz handoff com findings tipados; UI lista por prioridade (mínimo: tabela no painel de handoffs).

### B1 — Pane omp de PRIMEIRA CLASSE via RPC (M — a entrega mais transformadora)
- **Fonte de referência** (não vendorar o server, só os types): `/tmp/omp-src/packages/coding-agent/src/modes/rpc/rpc-types.ts` (501 linhas, zero deps — reescreva/copie os frames que usar) + doc `/tmp/omp-src/docs/rpc.md`.
- **Implementar**:
  1. Novo `kind: "cli-rpc"` no schema de adapter (`src/main/adapters/adapter-registry.ts`, zod) — spawn com **pipes** (`omp --mode rpc-ui`, SEM PTY), cwd do workspace.
  2. `src/main/adapters/omp-rpc-service.ts`: cliente NDJSON (~300 linhas): correlação por `id`, parse de eventos `agent_start/end`, `message_update` (deltas), `tool_execution_*`, `extension_ui_request`, `available_commands_update`, `get_state` (contextUsage!).
  3. Mapear para nosso estado de pane: `busy/idle` vem de `agent_start/agent_end` (**determinístico — fim do timeout de 800ms para este pane**).
  4. **Aprovações**: em modo yolo do pane → auto-responder `extension_ui_request` (confirm→confirmed:true, select de approval→"Approve") **com registro no audit log** (`src/main/orch/` tem trilha de auditoria — use-a). Em modo safe → dialog nativo no renderer.
  5. `set_host_tools`: expor 3-5 tools nexus (`nexus_pane_list`, `nexus_handoff_submit`, `nexus_mission_get`) direto pelo RPC — schema JSON deles, execução roteada ao nosso dispatcher MCP existente com o MESMO enforcement de allowlist do token do pane (skill-gate continua autoridade).
  6. UI mínima no renderer: pane mostra streaming de texto, chip de contexto (`contextUsage.percent`), e dropdown `set_model`/`cycle_model` (cross-provider mid-session!).
- **Pinagem**: registre a versão do binário omp testada (o protocolo não tem versionamento) + teste de contrato (spawn real do omp se instalado, senão fixture de frames gravados).
- **Aceite**: pane omp-rpc roda prompt de ponta a ponta com estado determinístico, troca de modelo pela UI no meio da sessão, aprovação auto-respondida com entrada no audit, host tool chamada pelo modelo chega ao nosso dispatcher e respeita allowlist.

### B2 — Companion mobile E2E via pi-wire (M)
- **Fonte**: `/tmp/omp-src/packages/wire/src/index.ts` (445 linhas, ZERO deps — vendorar as-is) + `/tmp/omp-src/packages/collab-web/src/lib/codec.ts` (AES-256-GCM WebCrypto — roda em Electron e mobile browser) + `/tmp/omp-src/packages/collab-web/scripts/local-relay.ts` (portar Bun→Node `ws`, ~200-300 linhas) + `/tmp/omp-src/packages/coding-agent/src/collab/relay-client.ts` (reconexão/backpressure — portar).
- **Destino**: `src/vendor/omp/wire/` + `src/main/remote/relay/`. Integrar como transporte v2 do `remote-bridge.ts`: sala com chave+write-token no fragment do QR (view-only = só chave), relay cego self-hosted (adicionar rate-limit + cap de salas + check de origin que a referência não tem). Frame novo `t:"pty"` selado no mesmo envelope para stream de panes não-omp. `mobile-companion-policy.ts` continua decidindo o que o mobile pode (destrutivo = confirmação no device; `mission.complete` negado).
- **Aceite**: parear celular via QR e assistir um pane read-only **fora da LAN** (relay local + túnel de teste); write-token dá controle; revogação fecha sessão; testes do codec (roundtrip + tamper) verdes.

### B3 — hashline no editor como "patch bus" (M)
- **Fonte**: `/tmp/omp-src/packages/hashline/` inteiro (5.7k src + 3k testes; deps só `diff`+`lru-cache`).
- **Destino**: `src/vendor/omp/hashline/`. Trocar `Bun.hash.xxHash32` por xxhash JS/WASM com **fixtures validando tags idênticos aos deles**. Implementar: `Filesystem` sobre `editor-document.ts`/`workspace-file.ts` (aplica em buffer aberto não salvo) e `SnapshotStore` por missão. Expor tool MCP nova `nexus_editor_apply_patch` (formato hashline) ao lado das existentes em `tools-editor.ts` — validação de staleness fail-closed + all-or-nothing multi-arquivo.
- **Aceite**: suíte deles portada verde (boundary-repair, recovery, leniency); patch multi-arquivo com anchor stale é rejeitado com erro orientador; agente aplica patch via MCP num arquivo aberto e o buffer reflete.

### B4 — Descoberta universal de configs (M)
- **Fonte**: `/tmp/omp-src/packages/coding-agent/src/capability/` + `src/discovery/` (SEM Bun — os providers claude/cursor/codex/gemini/cline/copilot/vscode/agents-md, ~4-6k linhas).
- **Destino**: `src/vendor/omp/discovery/` + serviço no main que alimenta o MCP hub (`src/main/mcp-hub/`) e um painel "o que cada CLI enxerga neste workspace" (MCP servers, rules, skills por ecossistema, com `_source` e conflitos).
- **Aceite**: num workspace com `.claude/` + `.cursor/` de teste, o painel lista servers/rules/skills com origem correta e dedup por prioridade; testes dos providers portados.

### STRETCH (se sobrar fôlego, nesta ordem)
- **C1 — Cooldown escopado no failover**: portar a lógica de blocos por tier/modelo + `retryAtMs` da irmã + restauração pós-cooldown de `/tmp/omp-src/packages/ai/src/auth-storage.ts` (`markUsageLimitReached`, ~400 linhas + testes `auth-storage-*.test.ts`) para `src/main/orch/failover.ts`.
- **C2 — mnemopi sidecar**: rodar o MCP server de `/tmp/omp-src/packages/mnemopi/` sob Bun como sidecar opcional, bank por workspace, exposto como `nexus_memory_*` (modo `noEmbeddings: true` no dia 1).

## COMO TRABALHAR E TERMINAR

- Ritmo: uma entrega por vez, commit, typecheck+test, próxima. Não misture entregas num commit.
- Se algo do omp não bater com a análise (eles andam rápido), confie no CÓDIGO deles no SHA pinado e anote a divergência.
- Ao final (ou se o contexto apertar): escreva `docs/analysis/2026-07-XX-omp-crossover-status.md` com: entregas concluídas (commits), o que ficou, pegadinhas encontradas, próximo passo exato. Faça push da branch.
- Critério de sucesso da missão: **A1–A4 completos no mínimo**; B1 é o alvo grande; B2–B4 conforme render.
