# Análise Senior — Orquestração LLM, Overclock, Orca, GitHub, Mobile, UI e Squads

**Data:** 2026-07-15 · **Worktree:** `llm-orchestration-analysis-22d545` · **Método:** 7 mergulhos paralelos read-only + verificação adversarial em 2 lentes (trace de código e evidência de runtime) + crítico de completude. 10 agentes, ~1,65M tokens, 0 edits no código. Toda afirmação central tem `arquivo:linha` e foi tentada de refutar por céticos independentes.

---

## 1. Veredito executivo

1. **O bug "só chama Codex e Grok" tem causa-raiz CONFIRMADA e é mecânico, não aleatório.** São 4 mecanismos confirmados que se somam (+1 bug latente). O fix mínimo é pequeno (Fase 0, ~4 pontos de código); o refactor senior completo é um plano de 7 fases.
2. **GitHub funciona por baixo e está quebrado por cima.** Backend com 23 testes verdes; o que falha é exposição (flag default-off sem toggle), erros engolidos (parece "não funciona nada") e um fluxo de PR que falha no caminho mais comum.
3. **Mobile tem UM bloqueio fatal:** a bridge só escuta `127.0.0.1` e a UI não permite expor na LAN — o celular *literalmente não consegue conectar* no produto shipped. O resto (57/57 testes, pairing, TLS) é sólido.
4. **A decisão de NÃO importar o mobile do Orca está documentada e travada** em `docs/analysis/2026-07-11-mobile-plan.md:4-5`. Seu pedido contradiz o plano registrado — precisa de decisão sua (seção 12).
5. **A UI tem fundação de identidade forte (não é template)** — o problema é que o produto-core (orquestração) está enterrado num menu `⋯` e os 3 momentos de maior dopamina (lançar missão, handoff chegando, milestone) não têm endorfina nenhuma.
6. **Editar squad é impossível por design atual:** a UI só tem delete/import/export, e squads builtin são re-sobrescritos a cada boot.

---

## 2. Causa-raiz: por que a missão só chamou Codex e Grok

Evidência de runtime localizada: banco real da missão auditada em
`~/Library/Application Support/NexusIDE/project-runtime/projects/project-337a4e65…/checkout-adae268c…/runtime.sqlite3`, tabela `audit_events`, missão `mission-49c99cf8…` (hoje, 17:39–17:48). Nela: **1** chamada `nexus_route_task` para **3** `nexus_pane_spawn` (2× codex/gpt-5.5, 1× grok/grok-4.5) — nenhum spawn usou `agentName`, logo o campo `cli` do roster (kimi etc.) **nunca entrou no fluxo**.

### RC1 — Ranking por catálogo pre-empta a tabela de diversidade (CONFIRMADA, 2/2 céticos)

- `routeTask` → `evaluatedCandidates()` só emite candidato quando o modelo tem `quality` no catálogo ([task-router.ts:219](../../src/main/orch/task-router.ts)).
- O catálogo efetivo tem quality em **apenas 6 modelos** — opus-4-8, haiku-4-5, gpt-5.5, grok-4.1, grok-4-fast, glm-5.2 — todos com `source: 'nexus-eval/v1/fixture'` (**dado de fixture, não avaliação real**; confirmado também no bundle do app instalado 0.16.6).
- Os avaliados entram **na frente** de toda a tabela de diversidade ([task-router.ts:276-277](../../src/main/orch/task-router.ts)) e o pick é `ranked[0]` (:309). Kimi/AGY/LongCat, sem nota, **matematicamente nunca alcançam o topo**.
- Com `reserveClaude=true` p/ workers (:310-314) → vencedor é sempre codex, grok ou glm. Nesta máquina, glm/longcat estão `login-needed` (sem token z.ai em `~/.nexus/providers.json`) e são filtrados ([tools-domain.ts:853-857](../../src/main/orch/tools-domain.ts)) → **sobram Codex e Grok. QED.**
- Kimi e AGY estão instalados E logados (`~/.kimi-code/oauth/`, `~/.gemini/antigravity` verificados) — o problema não é auth deles.
- O comentário do próprio código (:272-275, "o catálogo só bloqueia riscos e anota custo, sem promover…") **contradiz o comportamento implementado** — comportamento não-intencional, não decisão.

### RC2 — Sinal `'cript'` casa com "TypeScript" por substring (BUG LATENTE confirmado; refutado como causa desta missão)

- `matchSignals` usa `includes()` sem fronteira de palavra ([task-router.ts:115-117](../../src/main/orch/task-router.ts)); `'cript'` está em CRITICAL_SIGNALS (:87). `"typescript".includes('cript') === true` → tasks rotineiras viram tier `critical`, cuja tabela (:72-77) só tem claude/codex/glm.
- **Reconciliação do cético de runtime:** na missão auditada a chamada real passou `{"tier":"medium"}` (override explícito) — a classificação nem foi usada ali. Portanto: corrigir mesmo assim (é bomba armada), mas sem atribuir a missão auditada a ele. Termos curtos a revisar junto: `'auth'`, `'token'`, `'secret'`, `'race'`.

### RC3 — O router é consultivo; o orquestrador spawna o que quiser (CONFIRMADA, 2/2)

- `nexus_pane_spawn` aceita `adapterId/model` arbitrários sem validar contra qualquer decisão do router ([tools-panes.ts:229-247](../../src/main/orch/tools-panes.ts)); a obrigação de usar o router existe **só como texto de prompt** ([mission-launcher.ts:214-215](../../src/renderer/orch/mission-launcher.ts)), e o kickoff declara o roster como "um MENU, não obrigação" (:249-255).
- Runtime: 1 route_task para 3 spawns; o spawn grok usou **grok-4.5** — modelo sem avaliação e com warning explícito de catálogo ("verify tier/pricing before making it the default", [model-catalog.ts:90-95](../../src/main/adapters/model-catalog.ts)) — que o router jamais escolheria; é apenas o default do adapter (grok.json) e de squad ([squad-model-defaults.ts:3](../../src/shared/squad-model-defaults.ts)).

### RC4 — Em missão agêntica/voz, o squad salvo NEM É USADO (CONFIRMADA, 2/2)

- `designSquadFromIntent` retorna **incondicionalmente** `deterministicSquadFallback` ([squad-architect.ts:260-274](../../src/main/orch/squad-architect.ts)) — cria squad novo `agentic-fallback-<ts>` com round-robin sobre os adapters builtin e `models.default` de cada um. O roster kimi/agy que você configurou é ignorado nesse modo (runtime confirma: missão com `squad_id='agentic-fallback-1784118710650'`).
- Agravante no wizard: ao trocar o `cli` de um agente, `balanceSquadRosterCli` põe `defaultSquadModelForAdapter(cli)` que é `undefined` para todo cli exceto grok e agy ([squad-model-defaults.ts:2-17](../../src/shared/squad-model-defaults.ts)).

### RC5 — Revisão de context drafts é estruturalmente codex-only (CONFIRMADA, 2/2)

- `selectIndependentContextReviewerRoute` exige `adapterId==='codex' || quirks.mcpAutoload` ([cli-context-draft-reviewer.ts:141-146](../../src/main/context/cli-context-draft-reviewer.ts)); `mcpAutoload` só é true em claude/glm/longcat. Autor claude excluído por `sameProvider`, glm/longcat login-needed → **único revisor possível: codex**. Explica os panes "context-reviewer-codex" que você viu sem pedir.

### Fator de máquina (não é bug, mas contribui)

GLM/LongCat sem token z.ai nesta máquina → `login-needed` → fora do roteamento (regra correta de negócio). Com eles logados, a monocultura ficaria menor — mas RC1/RC3/RC4 continuariam.

---

## 3. Fix mínimo (Fase 0) e refactor em fases

### Fase 0 — Hotfix da queixa (S)

| Onde | O quê |
|---|---|
| [task-router.ts:276-277](../../src/main/orch/task-router.ts) | Quality vira critério de ordenação **dentro do tier da tabela** (ou só pre-empta quando TODO adapter instalado tem ≥1 modelo avaliado) — alinha código ao próprio comentário :272-275 |
| `resources/model-catalog.json` | Remover blocos `quality` com source `nexus-eval/v1/fixture` (ou publicar avaliação real cobrindo kimi/agy/longcat) |
| [task-router.ts:87,115-117](../../src/main/orch/task-router.ts) | Word-boundary no matchSignals; `'cript'`→`'criptograf'/'crypto'`; revisar `auth/token/secret/race` |
| [task-router.ts:72-77](../../src/main/orch/task-router.ts) | Tier critical ganha candidatos de diversidade (kimi high, agy pro-high) atrás de claude/codex |
| [squad-architect.ts:260-274](../../src/main/orch/squad-architect.ts) | Modo agêntico reutiliza squad salvo compatível antes de sintetizar fallback |
| [tools-panes.ts:189-247](../../src/main/orch/tools-panes.ts) | Registrar proveniência da rota no spawn; recusar auto-spawn de modelo com warning de catálogo (grok-4.5) sem decisão do router |

### Fases 1–6 (plano do review de arquitetura)

1. **Persistir e expor RouteDecision** (M) — observabilidade primeiro: você precisa VER por que cada adapter foi escolhido (hoje a decisão não é persistida nem visível).
2. **Enforcement de rota** (M) — `route_task` emite reserva; `pane_spawn` valida contra ela. Sai de "prompt-hope" para garantia mecânica.
3. **Reconciler único** (L) — hoje são 5 loops supervisores independentes sem coordenação; re-route do driver é stub; `accountFailed` nunca é alimentado.
4. **Renderer fora do caminho crítico** (L) — autoridade de missão hoje depende de renderer vivo ([renderer-mission-authority.ts](../../src/main/orch/renderer-mission-authority.ts)); fonte de verdade fragmentada em 3 lugares.
5. **Task-queue como único dispatcher** (XL) — LLM propõe, motor executa. Elimina os dois dispatchers concorrentes (orquestrador-LLM vs mission-scheduler).
6. **Higiene estrutural** (L) — singletons de módulo nas cascas, prompts gigantes no renderer.

### Regras de negócio que NENHUM refactor pode quebrar (inventário verificado)

1. `reserveClaude` p/ workers (N instâncias claude corrompem o keychain "Claude Code-credentials" — todos deslogam).
2. Modelos `api-only`/`deprecated` nunca em roteamento automático (fable-5 só manual).
3. `adapterId` explícito do route_task vence o default do roster (anti-monocultura de custo) — honrar roster não pode inverter isso.
4. Spawn MCP sem `agentName` nasce worker gated; workers não criam orquestradores.
5. Invariante maxWorkers: slot só libera após row durável de `mission_panes`.
6. Revisor de context draft: provider ≠ autor, read-only confinado, 1 call.
7. `login-needed` fora do roteamento (não spawnar CLI que vai parar em prompt de login).
8. Failover de rate-limit via `exclude` no route_task.
9. Sinais de risco genuínos mantêm floor de tier (word-boundary não pode remover isso).
10. Validação estrita de quality no catálogo (source `nexus-eval/…`, overall 0-100).
11. Contrato de intenção obrigatório p/ spawn em missão; `same_checkout` com máx. 1 escritor.
12. Skill-gate duplo (server autoritativo + hooks client) e handoff entregue só em idle.

---

## 4. Overclock — onde ele ganha de nós hoje

Teardown do 1.1.0 local (Tauri/Rust 16MB + sidecar Node 110MB com `@anthropic-ai/claude-agent-sdk`; system prompts e allowlists extraídos de `~/Overclock/…/.overclock-app/panes.json` e defs compiladas no binário):

| # | Onde ganham | Severidade |
|---|---|---|
| 1 | **Voz**: ClockVoice é produto acabado; nosso Jarvis é transplante pela metade com 8-18s de latência (P0-2 aberto) | CRITICAL |
| 2 | **Topologia imposta por mecanismo**: piloto delegate-only + 4 chefes in-binary + gates — não doutrina em markdown | HIGH |
| 3 | **Onboarding activation-first**: "duas portas", receita Original baked-in, instalador de CLI in-app | HIGH |
| 4 | **Multi-plataforma shipped** (Mac/Win/Linux + auto-update); Nexus é macOS-only | HIGH |
| 5 | `overclock_clarify` estruturado com chips clicáveis e roteamento determinístico da resposta | MEDIUM |
| 6 | **Checkpoint/undo por turno** via shadow-git — "reverter com um clique" | MEDIUM |
| 7 | Packs verticais nomeados por RESULTADO (PLAYBOOK + agents + skills) | MEDIUM |
| 8 | Calibração com runbook anti-deadlock imposto (nós portamos os primitivos sem o runbook) | MEDIUM |

**Adotar/superar:** fast-lane da voz como default (fecha P0-2), modo Piloto delegate-only imposto, `nexus_clarify` com chips, onboarding activation-first, CheckpointManager shadow-git, re-embalar squads builtin como packs por resultado. Port Windows/Linux é XL e já é regra do produto (multiplataforma obrigatório).

---

## 5. Orca — a verdade sobre mobile e "design/landing"

- O mobile do Orca é **app nativo Expo/React Native publicado** (App Store + APK), com transporte dual-path: LAN direto (wss+TLS) e **relay cloud E2EE que é FECHADO** (`relay.onorca.dev` não está no repo). Terminal xterm WebGL real, diff review, PR compose, ditado por voz, notificações locais com catch-up.
- A **landing (onorca.dev) NÃO está no repositório** — impossível "trazer a página do Orca"; o que existe no repo é o Design Mode (grab de elemento no Chromium embutido → HTML+CSS+screenshot no prompt).
- "Nada ficou operacional" é impreciso no nível de código: o Nexus **já vendoriza** partes do Orca (ex.: `forge-flags.ts` adaptado de `stablyai/orca @ 143c36e`, MIT em `third_party/licenses/orca-MIT.txt`) e a bridge remota existe com 57/57 testes — o que falta é o degrau final de operação (seções 6-7).
- **Conflito de decisão:** `docs/analysis/2026-07-11-mobile-plan.md:4-5` rejeita importar o React Native do Orca (decisão travada). Recomendação técnica: manter a decisão (não importar o app RN agora — XL, manutenção pesada), mas **fechar os gaps do thin client** que deixam o nosso mobile inoperante (é S/M, não XL).

---

## 6. GitHub — funciona por baixo, quebrado por cima

**Backend real e verde** (23 testes rodados nesta auditoria: github-api, forge-provider, hosted-remote-url, token-resolver, git-workspace com git real). IPC registrado no boot, bridge no preload. O que mata a experiência:

1. **Painel Git SCM invisível**: flag `contextualPanel` default-off **sem nenhum mecanismo de ativação para o usuário** (HIGH).
2. **Erros engolidos**: `IntegrationsPanel` transforma token inválido/origin não-GitHub/offline em **listas vazias silenciosas** — é exatamente o seu "parece não funcionar nada" (HIGH).
3. **Criar PR sem push e com `targetBranch` hardcoded 'main'** → falha "http-422" críptica no caminho mais comum (HIGH).
4. Enterrado atrás de `⋯ → Apps` (ícone de config), fora do ⌘K; "Entrar com GitHub" (conta Nexus) não dá acesso à API do GitHub — que exige PAT manual escondido (MEDIUM).

**Plano:** expor erros (S) → ⌘K + renomear (S) → PR com push automático + branch default real (M) → painel Git default-on (M) → Device Flow OAuth no lugar de PAT colado (L).

---

## 7. Mobile — um bloqueio fatal e degraus curtos

- **CRITICAL:** bridge só faz bind em `127.0.0.1` e a UI não oferece bind LAN → celular não conecta, ponto. Fix: toggle na UI com aviso de segurança (S).
- Sem QR (previsto em `docs/remote-ops.md:42` e nunca feito — S), sem persistência de token no cliente (re-pareamento a cada reload — M), thin client faz **poll de 2.5s em `<pre>`** enquanto o streaming binário JÁ EXISTE server-side sem uso (M), `mobile-companion-policy` é dead code (ligar ou deletar — M), PWA/push inexistentes apesar de docs afirmarem (L), fora-da-LAN: recomendação Tailscale-first, **não** construir relay próprio (S de docs vs XL de infra).
- Sequência que torna operacional em device real: bind LAN → QR → token persistente → stream real → PWA/push.

---

## 8. UI — "endorfinada para vibe coder"

**A fundação já é anti-template** (preservar): tokens de cockpit disciplinados, doutrina de cor aviônica com semântica de estado única, VT323 como pontuação, copy de endorfina PT com kickers por hora, empty-states com pet, reduced-motion/focus-ring globais.

**Onde dói:**
1. **CRITICAL — o produto-core não tem porta de entrada**: orquestração enterrada no `⋯` com 3 nomes diferentes e sem atalho.
2. Onboarding guia o usuário PARA LONGE do core: default "terminal-only" e "Abrir sem IA" pré-marcado.
3. **Endorfina ausente exatamente nos 3 picos de dopamina**: lançar missão, handoff chegar, milestone completar — sem batida, sem progresso visível.
4. Jargão de engenharia em inglês nas superfícies core (viola o "FALE HUMANO" do próprio código); missão fragmentada em 6 projeções com nomes inconsistentes; wizard monolito de 59KB como porta única do ⌘N; metas em 10px.

**Plano:** botão inline de orquestração com badge vivo + um nome + atalho (S) → onboarding mission-first prompt-first (M) → endorfina nos 3 momentos + barra de progresso da missão (M) → GitHub de primeira classe com logo e gh CLI (L) → fast-path ⌘N de uma tela (L) → consolidar projeções de missão (L).

### Referência visual: BridgeMind v3.4.9 (prints fornecidos pelo usuário)

O que faz o BridgeMind parecer "incrível e organizado" **não é a tinta rosa** (que colide com as anti-referências do PRODUCT.md) — é o esqueleto. Sete padrões transferíveis, mapeados no Nexus:

| # | Padrão BridgeMind | Gap do Nexus que resolve | Onde aplicar |
|---|---|---|---|
| 1 | **Launcher "escolha como quer trabalhar"**: 4 cards grandes nomeados por modo (Space/Swarm/Board/Memory), cada um com atalho visível; rodapé com ⌘N/⌘D/⌘, | Onboarding que guia PARA LONGE do core; orquestração sem porta de entrada | Home/onboarding: cards "Missão · Terminal · Squads · Remote" com atalhos — mission-first |
| 2 | **Central de notificações acionável**: por agente (COMPLETED / NEEDS INPUT), chip "Jump to pane", mark read, timestamp | Nexus não tem superfície única de "o que precisa de mim agora" — prontidão é o princípio nº 2 do PRODUCT.md | Sino na barra: eventos de missão/handoff/idle com jump-to-pane |
| 3 | **Skills como chips arrastáveis** ("drag onto a terminal"), categorizadas com tag colorida (SECURITY/WORKFLOW/MEMORY) | Skills/allowlists do Nexus são invisíveis fora do wizard | Painel Skills arrastável para pane/agente; mesma taxonomia nos squads |
| 4 | **Menu de contexto do pane com ações de valor**: Generate handoff, Create Git worktree, Open Git panel, Copy output | GitHub/handoff enterrados em menus globais; ações longe do ponto de uso | Right-click no pane do Nexus: handoff, worktree, painel Git, copiar output |
| 5 | **Settings com IA limpa** (YOU/APPLICATION/AGENTS & AI/SYSTEM) e **Mobile como item de primeira classe** | Remote/mobile enterrado num catálogo de Settings | Reorganizar SettingsDrawer; "Mobile" nomeado na nav |
| 6 | **Multi-conta legível**: perfis por CLI, política de limite explícita ("Off/Ask — switching is always your choice"), callout honesto sobre Keychain do Claude no macOS | Nexus TEM multi-conta+failover mas a política é opaca pro usuário | AccountsManager: expor política de failover como escolha; callout do keychain (valida nossa regra de negócio nº 1 — até concorrente documenta o problema) |
| 7 | **Motor de temas**: 23 temas com preview, filtro Dark/Light, aplicação instantânea em sidebar+terminal+editor | "Vibe coder se sentir em casa" = personalização; hoje o Nexus tem 1 cara | Theme engine sobre os tokens já existentes (base.css) — default continua cockpit aviônico; "Pink City" vira escolha do usuário, não identidade do produto |

Mais quatro padrões dos wizards deles (2ª leva de prints):

| # | Padrão BridgeMind | Gap do Nexus que resolve | Onde aplicar |
|---|---|---|---|
| 8 | **Wizard de missão em 3 passos** (MISSION → ROSTER → LAUNCH): o brief prompt-first É o passo 1, com "@" para referenciar arquivos, contador de chars, callout "shared with all agents" e context files drag&drop inline | Nosso MissionWizard: monolito 59KB, breadcrumb de até 5 etapas como porta única do ⌘N | Valida a recomendação do fast-path ⌘N: objetivo em uma tela; anexos inline (MissionAttachmentPicker já existe); "mais opções" vira o wizard completo |
| 9 | **Escape hatch com hierarquia certa**: "Open without AI" existe, mas é botão-texto secundário; o CTA primário (pink, cheio) é "Next: Add AI agents" | Nexus faz o INVERSO: default terminal-only e "Abrir sem IA" pré-marcado — o onboarding empurra pra longe do core | Inverter pesos no onboarding: missão/agentes como primário, terminal puro como saída discreta |
| 10 | **Presets one-click + Recent**: "Save current setup as a preset — One-click launch" e lista de workspaces recentes | Reabrir missão existe (mission-reopen) mas escondido; squads não têm launch de 1 clique | Home: presets de squad/workspace por RESULTADO (casa com os packs do Overclock, §4) |
| 11 | **Tile-picker visual do grid** (1–12 terminais) com feedback vivo ("1 terminal · 1×1 grid") | O grid de panes é literalmente o produto do Nexus e não tem seletor visual no onboarding | Passo de layout do onboarding/preset com tiles + chip de estado |

**Regra de ouro:** copiar os ossos (hierarquia, whitespace, cards grandes, chips, agrupamento contextual, wizard curto e prompt-first), não a pele — a identidade sci-fi operacional do PRODUCT.md fica; a personalização vira feature via temas.

---

## 9. Squads não-editáveis (item novo desta sessão)

Confirmado nos dois níveis:
- **UI**: a aba Squads do OrchestrationPanel só tem **delete** e **import/export** ([OrchestrationPanel.tsx:496](../../src/renderer/components/OrchestrationPanel.tsx)) — não existe editar nome, roster, modelo, instruções ou allowlists. "Editar" hoje = exportar JSON, editar na mão, re-importar.
- **Motor**: `syncBuiltins()` re-sobrescreve squads builtin **a cada boot** ([squad-store.ts:213-231](../../src/main/orch/squad-store.ts)) — alterações neles são perdidas por design ("rosters/instruções evoluem com o produto"). Squads do usuário nunca são tocados, mas não têm UI de edição.

**Proposta (M):** Squad Editor no painel — para squads do usuário, edição plena (nome, roster com cli+model+categoria+effort, instruções, allowlists); para builtin, botão **"Duplicar e personalizar"** (edit-as-copy preserva a regra de negócio de builtins gerenciados pelo app). Aproveitar o fluxo do wizard que já monta roster, corrigindo o `balanceSquadRosterCli` (RC4).

---

## 10. Missão consolidada — ondas de execução

| Onda | Conteúdo | Tamanho |
|---|---|---|
| **0. Hotfix router** | Fase 0 completa (seção 3) + teste de regressão de diversidade | S |
| **1. Ver para crer** | RouteDecision persistida + visível na UI; erros de GitHub expostos; bind LAN + QR do mobile | S/M |
| **2. Motor senior** | Enforcement de rota; squad salvo honrado no agêntico; Squad Editor + duplicar builtin | M |
| **3. Vibe coder em casa** | Orquestração 1ª classe + onboarding mission-first + endorfina nos 3 picos; GitHub 1ª classe c/ PR completo; padrões BridgeMind (launcher de modos, central de notificações, menu de contexto do pane, skills arrastáveis, theme engine) | M/L |
| **4. Superar Overclock** | Voz fast-lane default (P0-2); nexus_clarify; checkpoint shadow-git; packs por resultado | L |
| **5. Plataforma** | Reconciler único; renderer fora do caminho crítico; mobile PWA+push; Win/Linux | L/XL |

## 11. Decisões que preciso de você

1. **Mobile vs. Orca:** manter a decisão travada (não importar RN; evoluir thin client — recomendado) ou revertê-la formalmente?
2. **GLM/LongCat nesta máquina:** configurar token z.ai para ampliar a diversidade real de roteamento?
3. **Catálogo:** remover as notas fixture já (diversidade volta imediatamente) ou esperar avaliação real de todos os adapters?
4. **Ordem das ondas:** aprovar 0→1→2 como início imediato?
