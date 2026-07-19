# Análise sênior — NexusIDE × Overclock × Orca × oh-my-pi (2026-07-18)

**Escopo:** entender como o Nexus opera hoje (0.19.19), cruzar com os três artefatos externos (Orca MIT da StablyAI, oh-my-pi MIT do can1357, Overclock.app instalado localmente) e traçar o plano para sermos superiores na tese do produto: **vibe coder construir sistema com segurança, planejamento e regras enforced**.

Método: 5 frentes paralelas — (1) síntese das 8 análises sênior anteriores (07/07→16/07), (2) auditoria da arquitetura real em `src/main`, (3) teardown do `/Applications/Overclock.app` v1.1.0, (4) verificação de status do crossover omp no código e no git, (5) panorama externo 2026 via web.

---

## 1. Correção de premissas (importante antes de qualquer plano)

- **Overclock NÃO é da StablyAI.** É produto **brasileiro independente** (evidência: site 100% pt-BR com preço em R$, gate de feature por e-mail hardcoded `guilherme@laschuk.com.br` em `clockVoiceAccess.ts:14`, repo de releases `ustoppble/overclock-releases`). Tauri (Rust) + sidecar Node, v1.1.0 local / site anuncia v0.2.x — versioning inconsistente, típico de build-in-public.
- **Orca** (stablyai/orca, MIT) é o ADE da StablyAI (YC W22) em hipercrescimento (~18.8k stars em meados de jul/26). É nossa fonte de módulos de infra, não nosso concorrente direto de tese.
- **oh-my-pi** está em **v17.0.4 (hoje, 18/jul)**. Nosso vendor está pinado em `03c48d073` (limiar do v17.0.0). Mudanças relevantes desde então: protocolo `xd://` (tools como devices/URLs, prompt cache intacto), tool `hub` unificado, fim do BM25 discovery, **rotação automática de credencial OAuth invalidada (v17.0.1)** e **usage-aware credential ranking (v16.3+)** — os dois últimos são exatamente o nosso jogo de multi-conta.

## 2. Como o Nexus opera hoje (verificado em código)

Ciclo real: renderer pede spawn → `spawn-authority` constrói prova imutável (renderer carrega só `requestId` opaco) → `gate` minta bearer token por agente + HOME efêmero/overlays por flavor → pane PTY amarrado ao `WebContents` dono → agente fala com 114+ tools `nexus_*` via MCP HTTP loopback com token → missão vive sob **intent gate** (contrato aprovado + budget reservado atomicamente) e **PREVC** (contractHash/contextRevision) → **scheduler de waves** com ownership por arquivos/símbolos/domains, cap adaptativo 2→6, worktrees + MergeQueue serial → **mission driver** (tick 30s + wake por evento, default `shadow`) → **handoff trusted** com evidence binding (evidência de outro scope rejeitada) → **stop-gate** revalidado no DB → **failover** multi-conta com cooldown escopado por tier/modelo e espera-pela-irmã → **audit fail-closed** em todo dispatch.

Forças reais (acima da média do segmento, incluindo Orca e Overclock):

1. **Segurança estrutural enforced no main**: token↔session 1:1 com revogação no exit; skill-gate duplo (server + hooks `.mjs` fail-closed); `pane-authz` objeto-nível (worker não toca shell do usuário nem pane orquestrador); containment com realpath+symlink walk (com gate test anti-`startsWith`); env allowlist com recusa de `DYLD_*`; isolamento de credenciais (Claude em Keychain, GLM/LongCat nunca veem OAuth da assinatura); audit que nega a operação se não gravar.
2. **Orquestração com garantias formais**: intent/PREVC binding, ownership enforcement pós-diff, evidence trust cross-mission rejeitado.
3. **Crossover omp 100% executado** (A1–A4, B1–B4, C1–C2 — ver §5).
4. **Mobile E2E** com relay cego self-hosted (pi-wire vendored + endurecimentos que a referência não tinha).
5. Jarvis/voz pt-BR superior ao ClockVoice (conclusão do audit 13/07, mantida).

O calcanhar de Aquiles é o **plano de observação**: detecção de limite (regex em stream PTY), idle/busy (timeout 800ms + hooks best-effort), autoresponder de prompts e handoff legado in-band — todos heurísticas sobre canal não confiável, com incidentes reais documentados no próprio código. Um agente (ou página lida por ele) pode ecoar `HTTP 429` e forçar rotação de conta (DoS de quota por prompt injection). E o tier de custo + security floor do router dependem de keyword PT/EN — classificador de brinquedo decidindo tier crítico.

## 3. Comparativo direto

### vs Overclock (o concorrente de tese, BR)

**Onde ele ganha hoje:**
- Arquitetura Tauri+sidecar: crash do core não derruba UI, sem ABI hell de nativos com Electron.
- MCP-first radical: agentes enxergam/operam o app (`appWatch`, `appScreenshot`, `navigate`).
- Runtime de orquestração determinístico (`task()` com output validado por JSON-Schema, journal/resume, pipeline sem barreira).
- Hibernação/wake de panes (RAM); watchers de transcript por vendor → contabilidade unificada de tokens; presets playbook (`qa-swarm` é um tratado de orquestração pt-BR); licença SaaS simples (R$48,50/mês).

**Onde nós ganhamos (e é decisivo):**
- **Ele migra Electron→Tauri e deixou a segurança para trás**: panes rodam **SEM sandbox de OS** (Seatbelt omitido), skill gate PreToolUse não portado, `requireHandoff` omitido, dangerous-command gate é warn-only default-off. Ou seja: **o produto dele para vibe coder não tem nenhuma das três coisas da nossa tese (segurança/planejamento/regra) enforced por mecanismo** — só por prompt.
- Sem telemetria/crash reporting; remote LAN-only; whisper.cpp manual; ships **sourcemaps + src/ TS + testes no bundle de produção** (vazamento de IP — foi o que permitiu o teardown); licença dependente de rede.
- Sem editor/LSP real; nós temos editor + hashline patch bus + review P0–P3.

**Lição estratégica:** não migrar para Tauri agora. A migração dele provou o custo — enforcement de segurança mora no processo que controla o spawn, e portar isso é a parte que fica para trás. Nossa escolha de manter autoridade no main Electron é, hoje, **vantagem competitiva**, não dívida.

### vs Orca (StablyAI, MIT — fonte, não alvo)

Table stakes que o Orca popularizou e o mercado inteiro tem: worktree por agente, notificações de atenção, mobile companion com approve, **annotate-diff → prompt**, design mode (click→screenshot+HTML→prompt), SSH worktrees, GitHub/Linear in-app, CLI para os próprios agentes scriptarem o orquestrador. Nós temos worktrees/merge queue/mobile; **annotate-diff e design mode são as duas ausências mais visíveis**.

### vs oh-my-pi (motor, não cockpit)

Já transplantamos os órgãos (ver §5). O que o v17 trouxe DEPOIS do nosso pin e importa: (a) **usage-aware credential ranking** — nenhum orquestrador (Orca/Superset/Conductor) roteia por quota restante; diferencial portável e aberto; (b) rotação automática de credencial OAuth invalidada — caso real do nosso failover; (c) `xd://` devices — observar, não portar (mudança de paradigma de prompt, risco alto).

## 4. Panorama: o que é commodity e o que está aberto

Commodity 2026 (não diferencia ninguém): worktrees paralelos, notificações/mobile, review de diff, agent-neutral BYOS, MCP central, hooks/CLI do orquestrador.

**Aberto e explorável (ranking por fit com nossa tese):**
1. **Guardrails para não-técnico enforced por mecanismo** — approvals granulares existem mas são dev-facing; ninguém faz "regras obrigatórias + planejamento enforced" para quem não sabe ler diff. **É exatamente a nossa tese, e já temos o motor (intent gate + PREVC + skill gate) — falta a UX.**
2. **Decomposição missão→plano→swarm agnóstica de CLI** — só o Overclock tenta (e é Claude-only, sem enforcement).
3. **Roteamento por quota restante cross-conta** — código MIT disponível (omp v16.3+), ninguém integrou.
4. **Vácuo do Vibe Kanban** (26.5k stars órfãos) — kanban de planejamento acoplado à execução; nosso scheduler de waves + missions é tecnicamente superior ao que eles tinham.
5. Voz/wake pt-BR + preço em R$ — nicho validado pelo Overclock, vazio entre os grandes.

## 5. Status do crossover omp (fecha a lacuna do doc de status nunca escrito)

A missão (`TASK/omp-crossover-mission-prompt.md`) foi **executada inteira em `main`** — 11 commits `feat(omp-*)` + follow-ups:

| Entrega | Status | Âncora | Ressalva |
|---|---|---|---|
| A1 adapter omp | ✅ | `1f5e350` | MCP via HOME-overlay privado (superior ao plano) |
| A2 catálogo rico | ✅ | `1347d55` | subset curado 144KB, não os 3.841 |
| A3 rate-limit | ✅ | `4bb2946` | kind `transient` com cooldown curto implementado |
| A4 review P0–P3 | ✅ | `ef515c1`/`d6719ff` | tabela por prioridade na UI não confirmada |
| B1 pane RPC | ✅ | `8cc7393` | **divergência: cockpit fora do grid** (sem `kind: "cli-rpc"` no registry) |
| B2 companion E2E | ✅ | `589728f` | aceite fora-da-LAN não verificável estaticamente |
| B3 hashline | ✅ | `1d92b2f` | xxhash32 TS com fixtures idênticos |
| B4 discovery | ✅ | `aa3472f` | provider vscode fora do subset |
| C1 cooldown escopado | ✅ | `2f46e66` | — |
| C2 memória | ✅ | `4b207b5` | porte FTS-only; `reflect()` LLM pendente |

Pendências reais: doc de status (esta seção cobre), B1 na forma grid, expansão do catálogo, provider vscode, `reflect()`, revalidar pin do protocolo RPC contra omp v17.0.4 (protocolo não é versionado — nosso teste de contrato precisa rodar contra o binário atual).

## 5.1 Adendo (18/07 ~19h36): commits `9f1470a` + `f24c682` — omp vira cidadão de primeira classe

Duas entregas de outra sessão pousaram em `main` durante esta análise e mudam o quadro:

**`9f1470a` — corrige a SELEÇÃO.** O problema diagnosticado: omp integrado mas nunca selecionado (0 panes de missão), por ladder tardio + overrides de roster + drawer RPC silencioso. Entregou: `ompParticipation` (`off|fallback|diversity|prefer`, default `diversity`) em settings; ladder do router com omp cedo (medium #2, hard #3, critical por último) e `securityFloorActive` bloqueando promoção em security/critical; diversity boost mission-aware (omp vira #2 se a missão já usou outro CLI, via `missionUsedAdapters` no scheduler); **sticky roster enforced no `pane_spawn`** (`tools-panes.ts:230-247` — roster omp força `adapterId:'omp'` mesmo com route pedindo outro CLI); squads builtin com reviewers/generalists omp obrigatórios; UI: pulse ambiente na WorkspaceBar, auto-start do painel RPC, toast "OMP pede aprovação", selects em OrchestratorDefaults. "Fallback demotion" fail-closed: `fallback` rebaixa omp de verdade (label não mente), com fail-safe contra lista vazia. Testes bons na camada pura (policy + router + schema); UI e wiring sem teste.

**`f24c682` — corrige a EXECUÇÃO.** `ompMissionTransport` (`pty|rpc|auto`, default `auto`); worker omp de missão nasce via `omp --mode rpc-ui` (`spawnMissionOmpRpcWorker`, `omp-rpc-ipc.ts:272-382`) com token de gate real (allowlist = roster ∩ host set, dispatch pelo dispatcher MCP — não é bypass); fallback auto→PTY apenas em falha de spawn; host tools 3→**15 curadas** (mission/handoff/route_task + file/git); FleetChip conta sessões RPC; painel RPC ganha as 15 tools e bind de missão.

**Fecha da análise:** "omp nunca selecionado" (caminho completo router→spawn→frota); drawer RPC silencioso; RC3 **parcial** (roster sticky é enforcement real no spawn; o gate de proveniência do `9c08c57` segue só warning para spawn ad-hoc); B1 **parcial** (workers rpc-ui aparecem na frota com `paneId` sintético, mas `kind: "cli-rpc"` segue fora do adapter-registry).

**Novos red flags (revisão sênior, por severidade):**

1. **Broadcast de eventos RPC para TODAS as janelas** (`omp-rpc-ipc.ts:186-197`) — vaza eventos entre janelas/projetos; dado o histórico de multi-workspace-isolation, é regressão de isolamento. Há bloco morto em `pushToOwner` sugerindo intenção não concluída. **→ vira P0.**
2. **Sticky roster cego a quota/cooldown** — força omp sem consultar `exclude` do route nem estado de quota: missão com conta omp sem quota spawna e falha em runtime. Amarra com P2.9: roteamento quota-aware vira pré-requisito do sticky, não só diferencial.
3. **Regressão de capacidade por default**: worker de missão omp passa a receber 15 tools curadas em vez das ~114 do MCP PTY — briefs que usem `nexus_context_*`/memória/skills levam `tool negada`; o fallback só dispara em falha de spawn, nunca em tool-denied. Decisão de produto a revisitar (ampliar o set ou escolher transporte por brief).
4. `parseOmpModelRef` falha em silêncio (`omp-rpc-ipc.ts:233-246`): modelo sem `/` cai no default do omp, sem warn — mesma classe de "modelo fantasma silencioso" combatida no caminho PTY.
5. Cobertura assimétrica: o caminho mais perigoso (`spawnMissionOmpRpcWorker` + fallback + interseção de allowlist) tem **zero teste**; o teste de host tools testa contagem (≥10), não comportamento do gate.
6. Menores: comentário do schema mentindo (diz default `pty`, código é `auto`; diz "orchestrator spawns" mas rpc exclui orquestrador); ciclo de import `tool-util→omp-rpc-ipc→…→tool-util` (call-time, seguro, mas lintável); sessão rpc de missão efêmera (reopen não recupera); label do `off` omite o canto fail-safe.

**Continua aberto após os commits:** security floor por keyword (P0.2 — "na dúvida sobe o tier" não implementado); 6 blocos `quality` de fixture em `resources/model-catalog.json`; quota-aware routing; pin RPC × omp v17.0.4; `kind: "cli-rpc"` no registry.

## 6. Plano de melhoria priorizado

### P0 — Fechar o que derruba confiança (fundação "segurança com regra")

1. **Auditoria XSS do renderer** (SEC T1 — maior risco não coberto desde 16/07). Qualquer XSS = RCE via preload; para um produto cujo público instala qualquer coisa, é o chão. Incluir checklist de packaging: garantir que o .dmg **não** shipa `src/`, sourcemaps nem testes (lição inversa do Overclock).
2. **Tirar decisões de segurança do scraping**:
   - Router (RC3): enforcement **parcial entregue** em `9f1470a` (sticky roster no `pane_spawn`); falta proveniência obrigatória para spawn ad-hoc (hoje só warning) e **security floor nunca por keyword**: na dúvida o tier sobe, não desce; remover os 6 blocos `quality` de fixture de `resources/model-catalog.json`.
   - Failover: promover refutação-por-API a **condição obrigatória** para cooldown longo; tratar padrão de limite detectado dentro de output citado/bloco como suspeito, não como sinal.
3. **Regressões do `f24c682` a fechar imediatamente**: escopar eventos RPC por janela/projeto (hoje broadcast global — vazamento cross-workspace); `parseOmpModelRef` fail-loud; testes no caminho `spawnMissionOmpRpcWorker`/fallback/interseção de allowlist; varredura dos comentários que mentem no schema.
4. **E2E empacotado**: Playwright cobrindo M1–M4 + `smoke:package` em CI de release. Sem isso, cada release é fé.

### P1 — Productizar a tese (o que ninguém no mercado tem)

4. **Fluxo guiado "descreva → aprove → execute → valide"**: intent gate já existe como motor; falta a UX — plano de waves com custo estimado por modelo (já temos catálogo rico) apresentado para aprovação em 1 tela, execução, review P0–P3 automático ao final, e resultado explicado em linguagem não-técnica. Isso É "segurança + planejamento + regra" empacotado para vibe coder.
5. **Porta de entrada da orquestração** (ORQ §8): badge vivo de atenção ("qual agente precisa de mim" — a dor nº1 do segmento segundo as reviews), ⌘N fast-path, onboarding mission-first. Hoje a orquestração está enterrada no menu `⋯`.
6. **Annotate-diff → prompt** (colher do Orca, MIT): comentário na linha do diff volta como instrução ao worker via handoff. Fecha o loop de review que o squad P0–P3 começou.
7. **Squad Editor UI** + packs nomeados por resultado ("Landing page", "Bug fix", "Loja") — hoje edição é JSON na mão; builtins re-sobrescritos a cada boot.
8. **GitHub first-class**: erros expostos no painel (fim das listas vazias silenciosas), PR com push + branch default real, Device Flow OAuth, painel default-on.

### P2 — Superioridade técnica (puxar vantagem defensável)

9. **Roteamento por quota restante**: portar usage-aware credential ranking do omp v16.3+ para o `failover.ts`/`task-router.ts` — nenhum orquestrador tem; agora é também **pré-requisito do sticky roster** (red flag 2 do §5.1); + dashboard de custo por conta (referência: transcript watchers do Overclock).
10. **omp-RPC dentro do grid**: `kind: "cli-rpc"` no registry + spawn por pipes — estado busy/idle determinístico **para o pane**, matando de vez o timeout de 800ms no caminho que mais importa; revisitar o set de 15 host tools curadas vs. as ~114 do MCP PTY (red flag 3 do §5.1); + painel Advisor-style para review contínuo.
11. **Hibernação/wake de panes** (referência Overclock) — RAM é o gargalo prático de 8–12 panes.
12. **Mobile**: aprovação de device, confirmação dirigida pelo desktop, cert pinning (SEC H5/H6 abertos).
13. **LSP sidecar `nexus_lsp_*`** e **pi-iso APFS clones** (worktrees instantâneos) — ambos com código-fonte de referência MIT no omp.
14. **Revalidação do pin omp** contra v17.0.4 + política de tracking semanal (cadência deles é quase diária).

### P3 — Higiene estrutural (pagar antes que vire incidente)

15. Reconciler único dos 5 loops supervisores; renderer fora do caminho de autoridade de missão; fila de confirmação **por agente** com rate limit (hoje 1 modal serializa todos); kill switch do prompt-autoresponder.
16. SEC-R1/R2: SBOM + vuln scan + cosign na imagem de sensores; perfil formal OWASP ASVS L2.
17. Telemetria de produto local-first (tokens por pane/workspace à la Overclock) — hoje somos tão cegos quanto ele para uso real.

### Não fazer (reafirmando decisões travadas)

Não migrar para Tauri agora; não importar app RN do Orca; não copiar memória global textual (risco cross-projeto); nunca default `yolo`; não redistribuir binário omp (AGPL/mupdf); não perseguir contagem de tools como métrica; não copiar leaderboard/gamificação (distração de tese); não portar `xd://` (observar maturação); não afrouxar nada em `src/main/security/` por velocidade.

## 7. Veredito

O Nexus já é **estruturalmente superior** ao Overclock naquilo que é a tese do produto (segurança/planejamento/regra por mecanismo) e já absorveu o melhor do Orca e do omp. O gap não é de arquitetura — é de **produtização**: a segurança é invisível, a orquestração está enterrada na UI, e decisões críticas ainda dependem de regex sobre stream de terminal. A sequência P0→P1 acima transforma vantagem estrutural em vantagem visível, que é o que convence vibe coder a pagar. Ordem recomendada das ondas: **P0.1–P0.3 (confiança) → P1.4+P1.5 (a tese visível) → P1.6–P1.8 (loop de review) → P2 conforme tração.**

---

## 8. Execução desta análise (18/07 à noite) — o que já foi resolvido

Trabalho executado em lanes paralelas (esta sessão + sessão omp concorrente). Itens marcados ✅ em `fb41d33` já estão commitados; os demais aguardam commit (ver fim da seção).

**Bugs de produção (NEXUS-UI-BUGS-001):**
- ✅ **T1 — corrida de credenciais Claude**: read-back Keychain→vault (`syncClaudeBlobFromKeychainIfNative`, `account-store.ts:273-303`) antes de qualquer uso do blob; `activateAccount` sincroniza a conta que sai ANTES de escrever a nova; `claudeAuthEnvFromBlob` não injeta mais `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` (contrato de recuperação via failover auth-401 verificado em `limit-detector.ts:167-176` + `failover.ts:341,364`). 6 testes novos + contrato antigo atualizado em `account-store-spawn.test.ts`.
- ✅ **T2 — omp "não instalado"**: `resolveOmpBin` com fallback ao vivo de login-shell PATH (padrão `isBinInstalled`), PATH efetivo usado no `--version`; 3 testes. Follow-up menor (não feito): chamar `clearOmpBinCache()` no handler de install (`provider-config-store.ts:990`) — redundante na prática.
- ✅ **T3 — badge do sino**: causa raiz real era o `overflow:hidden` da `.workspace-bar__zone--status` (26px) recortando qualquer `top` negativo — a sugestão do handoff pioraria. Fix: `top:0; right:-5px` com comentário de restrição (`base.css:1934-1950`).
- ✅ **T4 — e-mail no painel de cotas**: `EntryCard` resolve e-mail via `useAccountStore` (sem mudar contrato IPC), padrão `AccountSwitcher`.
- Item 6 (toolbar cortando) segue **aberto** — precisa repro ao vivo.

**Red flags dos commits omp (§5.1):**
- ✅ **R1 — vazamento de eventos RPC**: broadcast global removido; painel → só owner; missão → só janelas do mesmo projeto (`renderer-workspace-scope` + `sameProjectScope`). 10 testes novos. **Follow-up aberto**: `requireSession` ainda permite renderer de outro projeto CONTROLAR sessão mission pelo sessionId — mesma classe, caminho de comandos (`omp-rpc-ipc.ts:232`).
- ✅ **R4 — `parseOmpModelRef`**: fail-loud em ref malformada, parse movido para antes de `mintToken` (sem vazar gate session em erro).
- ✅ **R5 parcial**: caminho de spawn mission coberto pelos 10 testes novos + hardening da sessão paralela (`ab9269c`).
- ✅ **R6**: comentários do schema corrigidos (pela sessão paralela).
- **R2 — sticky/auto-spawn cego a quota: ABERTO e AGORA CRÍTICO.** O commit `3504cbe` mudou os defaults para `ompParticipation:'prefer'` + `ompAutoSpawn:true` — o sistema puxa worker omp automaticamente SEM consultar cooldown/quota. Spec do fix: em `resolveStickyOmpAdapter`/auto-spawn, consultar os blocos de cooldown (`account-store` cooldown scopes) e o estado de quota antes de forçar omp; se indisponível, cair para o próximo candidato do ranked. É a prioridade técnica imediata.
- **R3**: mitigado pela sessão paralela (`ab9269c` — mission yolo auditado + host tools só gate-allowed).

**Outros:**
- ✅ **R7 — fixture de quality removido** de `resources/model-catalog.json` (6 modelos); 5 testes reescritos para o novo contrato (tabela de diversidade decide até haver avaliação real). **Pendente**: `resources/model-ranking.json` ainda serve fixture como 1º fallback do ranking público — decisão de produto (remover → IPC cai no pipeline offline com os mesmos números).
- ✅ **Typecheck vermelho do `fb41d33` destravado** (4 erros: fixture sem `contextPolicy`, comparação morta no intent-gate, `onBgTaskEvent` ausente do tipo `NexusApi` em `src/shared/types.ts`).
- **Atenção — mudança de defaults de risco**: `ompParticipation:'prefer'` + `ompAutoSpawn:true` + `ompMissionTransport:'auto'` + `ompRpcAutoStart:true` = toda missão ganha worker omp RPC por padrão. Direção de produto legítima (zero-fricção), mas amplifica R2 e exige observar custo/comportamento em campo.

**Higiene da suíte (5.589 testes):**
- ✅ `vitest.config.ts`: `assets/**` excluído — os 8 `.mjs` do archify (skill vendored) rodam no runner próprio (`node --test`, ver `assets/skills/archify/package.json`), não sob vitest; eram 8 das 10 falhas.
- ✅ `operational-surfaces.test.tsx`: mock de `window.nexus` ganhou `ompRpc.listSessions/onEvent` (MissionRail agora lista sessões RPC — a mudança de código veio sem o mock).
- ✅ `voice-wake-order.test.ts`: assertion de fonte atualizada para o guard atual (`!isJarvisNarrationHalted()`, do commit 7e06e36) — comportamento de retry-on-idle preservado, só a forma mudou.
- ⚠️ **Risco de processo (multi-sessão)**: a suíte "explodiu" (266 falhas `ERR_DLOPEN_FAILED`) porque outra sessão rodou o fluxo de app (`rebuild:electron`) entre duas corridas — os nativos (`better-sqlite3` etc.) ficam ping-pongando entre ABI de Electron e de Node. Vale um guard: `check-node-natives.mjs` como pre-test no CI local, ou envvar `npm test` que falha cedo com mensagem clara ("rode npm run rebuild:node") em vez de 266 falhas espúrias.

---

## 9. Adendo 2 — Overclock v1.2.0 (teardown do instalado, 18/07 noite)

A v1.2 **fechou o código** (V8 bytecode via bytenode, sem `src/` nem sourcemaps — resposta direta a teardowns como o nosso da v1.1.0; método: análise do constant pool). Eles também estão nos estudando: a skill `oc-design-dna` bundleada cita "Open Design (`nexu-io/open-design`)".

### Onde eles avançaram (e o que colher)

1. **Soft-status normalizado por hooks nativos (a maior lição)** — um script único `soft-status.mjs` instalado nas 6 CLIs (cada uma no seu dialeto: Claude `settings.json`, Gemini `hooks.json`, Codex TOML com `trusted_hash=sha256:`, Kimi/Grok TOML) gravando `overclock-soft-status.json` com eventos canônicos (`pre_tool_use` ⇒ busy real; `stop`/`notification` ⇒ idle/aguardando), fundidos em 2 eventos ao renderer (hard/soft). **Ataca nossa fragilidade #1** (idle/busy por timeout 800ms + hooks best-effort). Nós JÁ temos a infra de hooks (`hooks-gen.ts`); o delta é a normalização cross-flavor + a semântica de fusão + fallback gracioso por CLI (falha de instalação vira log, não quebra). → **P1 imediato.**
2. **xterm headless no processo servidor como verdade do terminal** + `readSerialized` (resync total em reload) + seq por pane **persistida** (`pane-seq.json`). Nosso sequenciamento vive no preload com recovery de chunks; o modelo deles (renderer = view burra, estado autoritativo no server) é mais robusto a crash/reload/reconnect. → **P2 alto** (temos o protocolo de stream do Orca como base; o delta é SerializeAddon no main + seq durável).
3. **tmux como camada de durabilidade** (`overclock_<id>` + metadata `@ovc_*`, scan de adoção no boot, `startKey` anti-PID-reuse, janitor com leases): panes sobrevivem a crash do app inteiro. Nós re-spawnamos do zero. → **P2 médio** — avaliar contra nosso modelo de containment (Seatbelt) antes; o janitor/startKey são colhíveis independentemente.
4. **Cards de pane com atividade real, zero LLM**: 1ª `user_message` do transcript nativo de cada CLI + última linha significativa + mtime. Já temos acesso aos transcripts (discovery B4). → **P1 barato e visível.**
5. **Probe de credencial pré-spawn + watchdog de TUI presa** (`--device-auth` direto, marker + leader socket, recheck sobre o tail do pane — fix do "Signing in eterno" do Grok). Generaliza o padrão do nosso T2 para qualquer CLI/qualquer prompt travado; complementa o stall-watchdog (que cobre busy-silêncio, não login-stuck). → **P1/P2.**
6. **Hardening de adapters**: system prompt por ARQUIVO em vez de argv (`--append-system-prompt-file` — evita E2BIG), trust pre-seed por pane (pula first-run dialogs em homes gerenciados), version floor de CLI com cache por mtime. → **P2** (verificar o que já fazemos; copiar o que faltar).
7. **codexChatProxy** (proxy local que emula a Responses API e destrava o Codex CLI para qualquer provider) — esperto, mas de valor menor para nós (usamos a CLI nativa de cada provider). → **P3.**
8. **Segurança deles é catch-up, não referência**: licença Ed25519 offline-first com SPKI no cliente + grace period é o desenho certo (referência para quando monetizarmos — temos `docs/billing-stripe.md`); mas a "build verification" usa **chave privada embutida no bundle** (anti-lição: se assinarmos chamadas, chave por instalação com TOFU, nunca segredo de fábrica). Panes deles seguem **sem sandbox de OS** — nossa vantagem estrutural intacta. Release lock = lição de CI para o nosso `make:release`.

### Multi-CLI como orquestrador: eles alcançaram o que já temos

O FEAT flagship deles (Grok/Kimi/Gemini/Codex como workers E orquestradores, system-prompt/skills/tools em todas as CLIs) é o nosso desenho desde sempre (adapters declarativos + injeção MCP por flavor + `orchestratorCapable`). A validação é forte: convergiram para o mesmo modelo (MCP host local + config por flavor + envelope de prompt idêntico). O colhível aqui são os **detalhes de wiring** (itens 1 e 6 acima), não a arquitetura.

### Jarvis deles × nosso

Nosso Jarvis segue superior (wake-word, full-duplex, política de eco, pt-BR nativo — conclusão mantida). Colhível do deles:
- **Ops por voz com ack** (`restore_panes` + `ackId`/`waitForAck`: "Pedi pra restaurar" → "Restaurado") — padrão de confirmação falada que torna ação de voz confiável. → P1 para o nosso modo agêntico.
- **`synthesizePaneTail`** — sintetiza o tail do pane em fala ("o que esse pane está fazendo"). Casa com o item 4 e alimenta o "qual agente precisa de mim". → P1/P2.
- Soft-status (item 1) como fonte de verdade para respostas de estado do Jarvis. → vem junto do item 1.

### Ordem sugerida de colheita

**(1) soft-status normalizado → (4) cards de atividade → (5) probe pré-spawn + watchdog de login-stuck → (2) xterm headless no main → (6) hardening de adapters → (3) tmux (avaliação) → (7)/(8) quando couber.**

---

## 10. Adendo 3 — emdash (generalaction/emdash, Apache-2.0, pin `c1af543`)

Mapa das 3 frentes (repo clonado em `/tmp/emdash-src`, monorepo Nx/pnpm, Electron + better-sqlite3 + zod v4 — stack quase idêntica à nossa). Licença Apache-2.0 = vendoring OK (preservar LICENSE.md + notices; policy igual Orca, sem dependência viva).

### A grande peça: hook protocol = o soft-status com código pronto e testes

O emdash implementa EXATAMENTE a lição #1 do Overclock v1.2, em Apache-2.0: hooks **declarativos no config nativo de cada CLI** (Claude `settings.local.json`, Codex TOML, etc.), comandos de uma linha auto-silenciosos (curl `|| true` / PowerShell `SilentlyContinue` — nunca bloqueiam a CLI), reescritos a cada spawn (resolve "config limpo no meio da task"), marker p/ separar hooks do app dos do usuário, e normalização para eventos canônicos (`status{start|stop|error|notification}`, `notificationType: permission_prompt|idle_prompt|…`). Redução para UI: `start→working`, `stop→completed`, `notification→awaiting-input`, `resetToIdle` quando o PTY morre sem hook de stop, fallback `input-submitted` para CLIs sem hook nativo, som/toast só em transição. Fontes: `packages/core/src/agents/plugins/{helpers/hooks.ts,hook-config.ts,helpers/parse-hook-event.ts,capabilities/hooks-types.ts}` + `apps/emdash-desktop/src/main/core/agent-hooks/hook-server.ts`. **Ataca nossa fragilidade #1 (timeout 800ms + hooks best-effort).**

Desenho Nexus-native da wave 1 (divergências deliberadas, mesmo espírito do HOME-overlay do omp): (a) o endpoint `/hook` entra no NOSSO servidor loopback existente (gate/MCP com bearer por pane) em vez de um 2º servidor HTTP com token próprio; (b) nossos hooks `.mjs` de skill-gate (enforcement, fail-closed) **permanecem** — o canal de status é ADITIVO, não substitui enforcement; (c) timeout 800ms degrada para fallback quando não há hook nativo.

### Restante do mapa de colheita (waves seguintes)

| # | Peça | Origem | Valor/Esforço |
|---|---|---|---|
| W2 | GitHub Device Flow OAuth + taxonomia de erros + gate push→PR | `main/core/github/services/github-device-flow-service.ts`, `pull-requests/pr-sync-errors.ts`, padrão de `create-pr-modal.tsx` | Ataca P1.8 (GitHub "quebrado por cima") / 1-2d. ⚠️ registrar OAuth App própria |
| W3 | pty-session registry (batch 16ms + ring 64KB + subscribe atômico) | `main/core/pty/pty-session-registry.ts` | Robustez de stream (lição Overclock #2, versão IPC local) / ½-1d |
| W4 | SSH stack (relay remoto) + `IdentityFilteredAgent` (peça rara) | `main/core/ssh/{lifecycle,connect,config,transport}/` | Remote-ops aberto / médio. **Corrigir: eles não verificam host key** |
| W5 | Spawn hardening (quoting Win/POSIX, kill de árvore) + `pty-env` allowlist + `AGENT_ENV_VARS` | `main/core/pty/pty-spawn-platform.ts`, `pty-env.ts` | 1-2d, parcial já coberto pelo nosso baseChildEnv |
| W6 | Telemetria opt-in com allowlist anti-PII + heartbeat crash-detection | `main/lib/telemetry.ts`, `shared/telemetry.ts` | P3.17 / baixo (trocar PostHog por buffer local) |
| W7 | Micro-padrões: KV namespaced, versioned JSON column (upgrade chain na leitura), migrations bundling, resume-fallback 3s | `main/db/{kv,initialize,versioned-column}.ts`, runtime | baixo |
| — | NÃO vendorar | wire/workspace-server (imaturo), ACP, registry 34 providers (SDKs pesados), pr-sync-engine inteiro (drizzle-acoplado), worktree-lifecycle (duplica o nosso), MobX/Monaco glue | — |

Gap deles que NÃO trazemos: sem host-key verification no SSH; telemetria default-on em prod; sandbox renderer off. Segredos/clientIds deles jamais entram na cópia.

---

## 11. Execução das waves W2–W4 + colheitas Overclock + decisões (19/07 madrugada)

Tudo commitado na main nesta rodada:

- **W2 — GitHub** (`fcd7cba`): Device Flow OAuth (vendor `github-device-flow.ts` + service `integrations/github-device-auth.ts`; clientId por setting/env, sem clientId a opção fica oculta — **ativar exige registrar a OAuth App do Nexus no GitHub**); taxonomia de erros tipados (sso/rate-limit+resetAt/forbidden/unreachable) até a UI; gate push→PR (push antes do create, branch default real). 88 testes de integrations.
- **W4 — SSH** (`86ae1a7`): transports ProxyJump, parser `~/.ssh/config` (Include + cycle-guard), `ssh -G`, client-proxy resiliente, port-forward IPv4/IPv6 — **sempre com nosso hostVerifier obrigatório** (upstream não verificava; `proxied-connect-config` é fail-closed). Próximos passos registrados no relatório da wave (connection manager com reconnect, remote-shell-profile, auth completa).
- **D1 — cards de atividade** (`0a4b857`): `pane-activity-summary` (1ª msg real do transcript claude/codex + última linha significativa + stoppedAt; cache 30s/mtime; nunca lança), servido em `activity` dos pane specs. **Follow-up**: consumir `activity` nos cards quando a refatoração da UI assentar (a lane paralela está mexendo nesses componentes).
- **D2 — probe + login-stuck** (`9980e3d`): probe pré-spawn tipado (<50ms, erro acionável em vez de pane morta); watchdog de login-stuck por flavor (ring buffer, tick 5s, 2×15s, nunca destrutivo, evento stuck/recovered ao renderer).
- **P1 — fixture rotulado** (`d3f1c4b`): ranking público marca `estimate:true` + badge "estimativa" para fontes fixture (catálogo, bundled, offline) — nunca posa de auditoria real.
- **P2 — floor fail-closed** (`f223f7f`): classificação incerta → security floor LIGADO (omp não passa claude/codex por falta de keyword).

**W3 — pty registry: NÃO implementado por já estar coberto.** Verificação em código: o protocolo Orca já dá sequência por chunk + high-water contíguo + dedup + buffer fora-de-ordem no preload (`preload.ts:159-204`) e, crucial, **recovery pull imediato** (`PTY_CHANNELS.recover` → `recoverSessionOutput`, pty-ipc.ts:359 → pty-manager.ts:883) com replay do ring buffer de 256KB/sessão (pane-registry). É exatamente o desenho que Overclock v1.2 acabou de construir e que o emdash tem no `LiveLog/LiveFollower`. A race de subscribe já é coberta por gap→resync. Sobraria só o batching de 16ms (perf, sem dor atual) — adiado até haver evidência de custo.

**P3 — `kind: "cli-rpc"` no adapter registry: fica para missão dedicada.** É a forma grid do B1 (omp-RPC como pane): mudança de schema zod + spawn por pipes no caminho de panes + picker/lifecycle. Grande demais para uma madrugada com lane paralela quente; spec completa em §6 P2.10.

**Guard de processo entregue junto** (`4c8600e`): `pretest` com `check-node-natives.mjs` — fim das corridas de suíte com 270 falhas espúrias de ABI (mensagem orienta `rebuild:node`).
