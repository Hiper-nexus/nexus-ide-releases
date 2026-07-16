# oh-my-pi × NexusIDE — análise senior de crossover

Data: 2026-07-15
Escopo: leitura profunda do repositório [oh-my-pi](https://github.com/can1357/oh-my-pi) (clone completo, v17.0.0)
cruzada com o código atual do NexusIDE (v0.16.6), via 5 auditorias paralelas
(embedding/RPC, providers/multi-conta, edição/code-intelligence, collab/swarm/memória,
mapa interno Nexus) + leitura direta de docs/protocolos dos dois lados.
Branch: `worktree-oh-my-pi-deep-dive` (isolada).

---

## 1. Sumário executivo

**Veredito: mina de ouro confirmada — mas o ouro não está onde parece.** O omp
não é concorrente do Nexus: é um **motor** (coding agent standalone de terminal),
enquanto o Nexus é um **cockpit** (orquestrador multi-CLI). A jogada errada seria
"virar um omp"; a jogada certa é dupla:

1. **Hospedar o omp como o primeiro agente de primeira classe do grid** — via
   `omp --mode rpc-ui` (NDJSON tipado por stdio), eliminando PTY-scraping para
   esse pane: estado determinístico, aprovações na nossa UI, custo/contexto em
   tempo real, troca de modelo cross-provider no meio da sessão (a feature que
   nossa matriz multi-conta declara "não suportado").
2. **Transplantar órgãos MIT pequenos e maduros** para dentro dos NOSSOS
   mecanismos — sem substituir o que já temos de melhor (segurança 9/10,
   orquestração de 114 tools, failover Keychain+resume que cobre CLIs que o omp
   jamais cobrirá).

Números do omp: MIT limpo, ~18k stars em 6,5 meses, 13.4k commits (4.9k só em
junho/2026), v17.0.0, ~650k linhas TS + ~170k Rust, 1.624 arquivos de teste,
~70 docs técnicos que batem com o código (verificado por amostragem linha a
linha). Qualidade média dos subsistemas auditados: 8.5–9/10. É fork do Pi
(Mario Zechner) mantido essencialmente por um autor (can1357) em velocidade
industrial — o que impõe a regra de ouro do vendoring (§6).

**Encaixe com nosso produto** (vibe coder, segurança, engenharia, multi-CLI):
cada lacuna estrutural nossa tem uma peça deles pronta —

| Lacuna nossa (documentada no nosso repo) | Peça deles | Rota |
|---|---|---|
| Editor = `<textarea>` (maturidade 4/10) | hashline + pi-natives + LSP | vendorar/portar |
| Idle por timeout 800ms, permissão invisível fora de Claude/Codex | `--mode rpc-ui` + ACP | hospedar |
| Companion mobile sem E2EE (admitido em `device-pairing.ts`) e LAN-only | pi-wire + codec AES-256-GCM + relay | vendorar |
| Cross-provider "não suportado" na matriz multi-conta | `set_model` mid-session do pane omp | hospedar |
| Failover reativo, cooldown binário | árvore 429 + cooldown escopado + drain-rate | portar ~400 linhas |
| Sem preço/janela/capacidade por modelo | `models.json` (59 providers, 3.841 modelos) | vendorar JSON |
| Sem memória com recall ranqueado, sem compaction | mnemopi (roda FTS-only) | sidecar MCP |
| Squads sem revisor sistemático | Advisor design + /review P0–P3 | portar design |

---

## 2. O que é o omp (retrato técnico)

- **Stack:** TypeScript sobre **Bun** (lock-in profundo: `bun:sqlite`, `Bun.serve`,
  workers via `Bun.main`, text-imports) + 4 crates Rust N-API (`pi-natives`,
  `pi-shell` com bash embutido, `pi-ast` com 56 grammars tree-sitter, `pi-iso`).
  Distribuído como binário standalone (embute o runtime Bun — usuário não precisa
  de Bun instalado).
- **Superfícies:** TUI interativa, `-p` one-shot, **`--mode rpc`/`rpc-ui`**
  (NDJSON stdio), **ACP** (protocolo do Zed, SDK oficial), SDK Node in-process
  (inviável para nós — Bun-only na prática: 669 usos de `Bun.*` no coding-agent).
- **Diferenciais medidos:** hashline (Grok Code Fast 6.7%→68.3% pass@1; −61%
  tokens no Grok 4 Fast — benchmark reproduzível em
  `packages/typescript-edit-benchmark/`), LSP em 53 servidores com
  writethrough de diagnostics, DAP com 14 adapters, TTSR (regras que abortam
  stream mid-token e regeneram), subagents tipados com isolamento CoW,
  advisor (segundo modelo revisando cada turno), collab E2E com QR,
  40+ providers com fallback chains e rotação de credenciais, mnemopi
  (memória SQLite+vetores local), snapcompact (compaction via PNG pixel-font
  sem LLM), `omp usage` (quota por conta/janela com sparklines).

## 3. Tese estrutural: motor × cockpit

O omp resolve *por dentro do agente* o que nós resolvemos *por fora* (orquestrando
CLIs alheias). Por isso:

- **Eles nunca terão**: grid de panes de CLIs heterogêneas (claude/codex/agy/kimi/
  grok/aider/opencode), failover de credencial de **assinatura** via Keychain,
  squads/missões/handoffs entre agentes de fornecedores diferentes, voz Jarvis,
  canvas, marketplace de agentes de terceiros. Isso é o Nexus.
- **Nós nunca teremos via PTY**: headers de rate-limit, eventos de streaming,
  aprovação estruturada, custo por token em tempo real das CLIs fechadas. Isso o
  omp tem porque ELE é o cliente da API.
- **Síntese:** hospedar o motor deles no nosso cockpit (ganhamos telemetria de
  dentro do request em pelo menos um pane) e transplantar a inteligência de
  decisão deles para os nossos mecanismos (ganhamos o refinamento sem perder a
  cobertura multi-CLI).

## 4. Mapa de cruzamento por subsistema

Notas de maturidade: N = Nexus hoje, O = omp hoje (auditorias 1–5).

| Subsistema | N | O | Leitura senior |
|---|---|---|---|
| Segurança de plataforma | **9** | 6.5 | Nossa vantagem. Sandbox Electron, IPC zod, Keychain, fail-closed. omp guarda credencial **em claro** no SQLite 0600 e tem default `yolo`. Nada a importar; muito a proteger. |
| Orquestração multi-agente | **8** | 7 | Nosso MCP embutido (114 tools `nexus_*`, skill-gate duplo, handoffs SQLite idle-delivery) supera o swarm deles (1.2k linhas, raso). Importar só: contrato de yields tipados, taxonomia IrcBus, presets. |
| Multi-conta/failover | 8 | **9** | Empate técnico com forças opostas: nós cobrimos qualquer CLI via Keychain+resume; eles têm a inteligência (árvore 429, cooldown por tier, drain-rate, afinidade de sessão p/ prompt-cache). Transplantar a inteligência. |
| Superfície de agente (estado/aprovação/custo) | 5 | **9** | PTY-scraping vs RPC/ACP tipado. Hospedar omp via rpc-ui resolve para um pane; ACP genérico resolve para o ecossistema. |
| Editor/code-intelligence | **4** | 9 | Nossa maior lacuna vs. o melhor deles. hashline (vendorável hoje), pi-natives (N-API carrega em Electron), LSP/DAP (extração L/XL). |
| Companion/colaboração remota | 6 | **9** | pi-wire+codec+relay = exatamente o E2EE+relay que nosso código admite não ter. Manter nossa política de RPCs destrutivos por cima. |
| Memória/compaction | 5 | **8.5** | mnemopi sidecar (FTS-only dia 1) + política de compaction. snapcompact: acompanhar, não vendorar (Rust interno deles). |
| Observabilidade de custo | 7 | **8** | Nosso usage_events SQLite já tem os dados; falta visualização (dashboard deles como referência) e dimensão por conta. |
| Qualidade/review | 6 | **8.5** | /review deles porta em horas (prompts + schema P0–P3). Advisor = blueprint do pane revisor. |
| Descoberta de configs de ecossistemas | 3 | **8.5** | `capability/`+`discovery/` deles lê `.claude/.cursor/.codex/AGENTS.md/GEMINI.md` com prioridades/dedup — sem Bun, isolável em 2–4 dias. Um IDE multi-CLI precisa disso. |

## 5. Top 10 — ranqueado por valor/esforço para o NOSSO produto

### #1 — Pane omp de primeira classe via `--mode rpc-ui` (M · TRANSFORMADOR)
Spawn do binário standalone com pipes (sem PTY), cliente NDJSON próprio (~300
linhas; vendorar/reescrever os types de `packages/coding-agent/src/modes/rpc/rpc-types.ts`
— 501 linhas, zero deps). Ganhos imediatos num pane:
`agent_start/end` determinístico (fim do timeout 800ms), deltas de streaming,
`tool_execution_*` para cards, `contextUsage` (tokens/%) ao vivo,
`set_model`/`cycle_model` mid-session (**cross-provider na mesma conversa**),
`branch`/`handoff`/`compact`, aprovações como `extension_ui_request` na nossa UI,
e OAuth via RPC (`login` + `open_url`).
**Regras inegociáveis:** (a) spawn sempre com `--approval-mode write` — o default
de fábrica deles é `yolo` (auto-aprova até bash destrutivo); (b) pinar a versão
do binário + testes de contrato — o protocolo **não tem campo de versão** no
frame `ready`; (c) **não redistribuir** o binário dentro do nosso .dmg sem
revisão jurídica — embute `mupdf` **AGPL-3.0**; instalar via `curl omp.sh/install`
/brew no primeiro uso (nosso fluxo de install de adapter já cobre isso).
**Bônus:** `set_host_tools` expõe as tools `nexus_*` diretamente ao modelo
(sem MCP) e `set_host_uri_schemes` monta `nexus://mission/current` como arquivo
virtual. O omp vira cidadão pleno de squad.

### #2 — Transporte E2E do companion mobile via pi-wire/collab (M · MUITO ALTO)
Vendorar: `packages/wire` (445 linhas, **zero dependências**), codec
AES-256-GCM (`collab-web/src/lib/codec.ts` — WebCrypto puro: roda em Electron
main, renderer e Safari/Chrome mobile sem polyfill), relay de referência
portado Bun→Node `ws` (~200–300 linhas; ou Durable Object) e `relay-client.ts`
(reconexão backoff 1s→30s, buffer 256 frames, backpressure 64/32KB).
Modelo de permissão criptográfico: chave da sala + write-token viajam **no
fragment da URL/QR** (relay cego); view-only = só a chave. Verificação
`timingSafeEqual` no host. Fecha exatamente as duas lacunas que
`device-pairing.ts` admite por escrito (key agreement real; alcance além da LAN).
**Manter por cima** nossa política existente (`mobile-companion-policy.ts`):
RPCs destrutivos confirmados no device, `mission.complete` negado do mobile.
Para panes não-omp, adicionar frame `t:"pty"` selado no mesmo envelope.
**Cuidados:** self-host do relay (o Go de produção deles não está no repo; a
referência TS não tem rate-limit/cap de salas — adicionar); QR = segredo total
(screenshot vaza controle — documentar e expirar salas).

### #3 — hashline como "patch bus" do editor (M · MUITO ALTO)
`@oh-my-pi/hashline`: pacote isolado, 5.7k linhas + 3k de testes, deps só
`diff`+`lru-cache`, seams abstratos (`Filesystem`, `SnapshotStore`,
`BlockResolver` injetável). Tag 4-hex = xxHash32 do arquivo normalizado;
aplicação all-or-nothing multi-arquivo; anchor stale → recovery por diff com
**fail-closed**; guard de "linhas vistas" impede edit cego (com erro que ensina
o modelo a corrigir sem re-read). Únicos pontos Bun: `Bun.hash.xxHash32`
(trocável em ~10 linhas; hash deve ser idêntico) e o FS default (implementamos
o nosso sobre buffers do editor — edits aplicam em documento aberto não salvo).
É a evolução natural do nosso CAS por `contentHash` (já existe em
`workspace-file.ts`/`editor-document.ts`) para CAS por trecho — a rede de
segurança que vibe coders não sabem que precisam. `diff-preview.ts` pronto para
UI de review; `prompt.md`+`grammar.lark` prontos se expusermos o formato a
agentes nossos. Casa com o CodeMirror deferido: motor primeiro, UI depois.

### #4 — Turbinar nosso failover com a inteligência deles (S+M · ALTO)
Três transplantes cirúrgicos, todos `fetch`/TS puro, para DENTRO do nosso
mecanismo Keychain+resume:
- **`models.json` + `identity/`** (S): 59 providers/3.841 modelos com
  custo/MTok, contextWindow, capacidades, wire-protocol — inclui GLM/z.ai,
  DeepSeek, Sakana Fugu, OpenRouter. Vira fonte de verdade do nosso
  model-catalog (hoje sem preço/janela). Re-sync do npm deles a cada release.
- **Árvore 429 + retry-after** (S): `error/rate-limit.ts` + `utils/retry-after.ts`
  — distinguir quota (rotaciona) de rate-limit transitório (espera, **não queima
  a conta irmã**), extrair reset de headers/texto multilíngue (EN/zh; nosso
  limit-detector já tem EN/PT-BR — somar). Aplicável ao texto do PTY como
  heurística com telemetria.
- **Cooldown escopado + ranking** (M): blocos por credencial **e por
  tier/modelo** (limite semanal do Fable não bloqueia a conta pro Sonnet),
  `retryAtMs` da irmã (esperar 60s em vez da janela de 3h), restauração
  automática pós-cooldown, afinidade sessão→conta por hash (preserva
  prompt-cache do provider = custo menor), ranking "use-it-or-lose-it" por
  drain-rate (N assinaturas rendendo ~100% — argumento de marketing mensurável).
  Portar `markUsageLimitReached` + `auth_credential_blocks` (~400 linhas) com os
  testes deles como mapa. Upgrade do nosso `provider-live-usage.ts` com limites
  semanais por família e auto-redeem de resets bancados do Codex.

### #5 — `capability/` + `discovery/` vendorados (M · ALTO)
O registry deles lê 8 ecossistemas (`.claude/`, `.cursor/`, `.codex/`,
`.gemini/`, `.cline/`, copilot, vscode, AGENTS.md) com prioridades, dedup,
`_source` attribution e cache — **sem Bun, sem natives**, ~4–6k linhas, 2–4
dias com testes. Para o Nexus: pré-popular o MCP hub, mostrar "o que cada CLI
hospedada vai enxergar neste projeto", detectar conflitos de config — o tipo de
inteligência que um cockpit multi-CLI deve ter e nenhum tem.

### #6 — Preset de review P0–P3 (S · ALTO)
Portar `reviewer.md` (schema JTD: verdict correct/incorrect, findings com
priority P0–P3 + confidence + line anchors ≤10 linhas + regra cross-boundary),
`review-request.md` (agrupamento por localidade) e a lista de exclusão de ruído
(locks/minified/generated/vendor). Vira preset de squad "review" com findings
renderizados por prioridade na UI de missões. Markdown/regex autocontidos —
horas de trabalho, qualidade de engenharia imediata para o vibe coder.

### #7 — pi-iso: clones APFS instantâneos por squad member (S/M · ALTO)
`clonefile(2)` = worktree copy-on-write em milissegundos, custo de disco zero
até divergir. Nosso `mission-scheduler` (recém-ligado, 0.16.1) já usa worktrees
git — upgrade para clones CoW elimina a dor nº 1 de multi-agente (duas CLIs no
mesmo working tree) com a vantagem nativa do nosso foco macOS. Se carregar
`pi-natives` inteiro pesar, o crate `pi-iso` é puro (8k linhas) — compilável num
addon mínimo nosso, ou replicar só o backend APFS (~150 linhas + libc).
`isoDiff` devolve patch git-aplicável para a UI de merge.

### #8 — mnemopi como memória de workspace multi-CLI (M · ALTO)
Rodar o MCP server pronto deles (sidecar Bun) com bank por workspace, exposto
no nosso namespace (`nexus_memory_*`): `retain/recall/reflect/memory_edit` para
TODAS as CLIs hospedadas. Começar `noEmbeddings: true` (FTS5 puro — funciona de
verdade) e evoluir para vetores depois. Scoping `per-project-tagged` = semântica
workspace+global correta. Preenche o vão entre `.nexus-memory/` (simples demais)
e o truth-graph (formal demais). Adotar a fachada, não a superfície experimental
(SHMR/AAAK ficam de fora).

### #9 — Pane revisor estilo Advisor (M · ALTO)
Portar o **design**, não o código: segundo modelo/CLI recebe deltas do
transcript do pane observado a cada turno; severidades `nit/concern/blocker`
(aside vs interrupção); injeção como `<advisory ... guidance="weigh, don't
blindly obey">`; **emission guard** (dedupe FIFO 4096 + filtro de frases vazias
+ 1 nota/ciclo — ~200 linhas portáveis); `immuneTurns` e `syncBacklog` com teto.
Resolve de fábrica os failure modes (spam, loop, lockstep) que matariam um
revisor ingênuo. Para vibe coders: engenharia sênior olhando por cima do ombro,
nativa do squad.

### #10 — LSP sidecar compartilhado (L · MUITO ALTO estratégico)
Extração (não import): `defaults.json` (53 servidores, dados puros) +
auto-detect por rootMarkers/binário + client com warmup/idle/negative-cache +
**writethrough** (diagnostics frescos inline no resultado de cada write) +
`workspace/willRenameFiles` (rename no explorer atualiza imports do projeto
inteiro). Exposto: (a) ao nosso editor; (b) via MCP `nexus_lsp_*` a TODAS as
CLIs hospedadas — o Nexus deixa de ser "host de PTYs" e vira **host que melhora
as CLIs que hospeda**. É o mesmo insight que fez o omp vencer: o harness importa
mais que o modelo. Esforço L (~7k linhas a revisar, de-Bunificação de spawn) —
planejar como onda própria.

**Menções honoráveis:** cliente ACP genérico (M — ganha omp+Gemini CLI+ecossistema;
permissões estruturadas `allow_always`; `fs/read_text_file` = agente lê buffers
não salvos); tool-card renderers React vendorados (`collab-web/src/tool-render/`,
~30 renderers + web component — transcript rico sem escrever renderer); interop
de sessões JSONL deles (S — listar/retomar sessões omp no Nexus, leitura pura);
taxonomia IrcBus nos handoffs (S/M); yields tipados como contrato do scheduler
(S/M); `summarizeCode` ao anexar arquivos a prompts (S, requer natives);
dashboard de custo estilo `omp stats` sobre nosso `usage_events` (M);
formatos de preset importáveis (agents .md + swarm YAML) (S).

## 6. Regras de vendoring (obrigatórias)

1. **Cópia cirúrgica pinada, nunca dependência npm viva.** Autor único, v17,
   commits diários, renomeações frequentes; pacotes publicam TS cru com
   `engines.bun`. Pin de commit + testes próprios sobre cada peça vendorada
   (portar os testes deles junto — são o mapa). Atribuição MIT nos arquivos.
2. **De-Bunificação orçada em 30–50% do esforço** em qualquer extração de TS
   (`bun:sqlite`→better-sqlite3, `Bun.serve`→http/ws, `Bun.hash`→xxhash JS,
   text-imports→raw-loader). Exceções limpas já auditadas: `pi-wire` (zero
   deps), `hashline` (2 touchpoints), `capability/discovery` (sem Bun),
   `models.json` (JSON), prompts de review (markdown).
3. **Crates Rust são a rota sem atrito**: N-API/napi-rs v3 carrega em Electron
   (Node ≥20.12 — validar nossa versão; assinar/notarizar os `.node` no bundle;
   testar crash handler deles vs crashpad). Medir tamanho do cdylib antes
   (56 grammars + syntect + BPE + coreutils); se pesar, feature-gate num fork
   "nexus-natives" (o workspace Cargo deles já separa os crates).
4. **AGPL alert**: `mupdf` embutido no binário omp. Consumir omp como processo
   que o usuário instala = seguro; redistribuir no nosso .dmg = revisão jurídica
   ou build sem mupdf.
5. **Nunca fazer downgrade de segurança para adotar algo deles**: Keychain >
   SQLite em claro; nossa política de aprovação > default yolo; nossa
   mobile-policy fica por cima do relay E2E.
6. **OAuth deles é zona cinza de ToS** (client_ids dos CLIs oficiais imitados).
   Nossa abordagem (CLI oficial + snapshot Keychain) é mais defensável — manter.
   Os *usage probes* (GET de quota com o bearer que já temos) são o pedaço
   aproveitável de menor risco.

## 7. Roadmap sugerido (3 ondas)

**Onda A — quick wins (dias, S):**
adapter JSON `omp` básico (cli-pty, entra no grid hoje) · vendorar `models.json`
+ identity · classificadores 429/retry-after somados ao limit-detector · preset
/review P0–P3 · interop de leitura de sessões omp · spec de yields tipados no
scheduler.

**Onda B — as três cirurgias (semanas, M):**
pane RPC-UI de primeira classe com host tools (#1) · relay E2E pi-wire no
companion (#2) · hashline no editor (#3) · cooldown escopado + ranking no
failover (#4) · capability/discovery (#5) · mnemopi sidecar (#8) · pane revisor
(#9) · pi-iso APFS no scheduler (#7).

**Onda C — estruturais (meses, L):**
LSP sidecar `nexus_lsp_*` (#10) · pi-natives toolkit no explorer/editor ·
cliente ACP genérico · dashboard de custo por conta/modelo/período.

**Acompanhar sem vendorar:** snapcompact (compaction via PNG — conceito genial,
renderer Rust interno), TTSR (exige controlar o agent loop — vira relevante se
tivermos agente próprio; versão degradada hoje: regex sobre PTY para avisos de
UI), auth-broker/gateway (blueprint para multi-conta em time, L).

## 8. Apêndice — paths-chave

**Deles (clone em scratchpad; re-clonar de github.com/can1357/oh-my-pi):**
`packages/coding-agent/src/modes/rpc/{rpc-mode,rpc-types,host-tools,host-uris}.ts` ·
`src/modes/acp/acp-agent.ts` · `src/tools/approval.ts` · `src/capability/` +
`src/discovery/` · `packages/hashline/` · `packages/wire/` ·
`packages/collab-web/src/{lib/codec.ts,tool-render/}` ·
`packages/coding-agent/src/collab/{host,relay-client,crypto}.ts` ·
`packages/ai/src/{error/rate-limit.ts,utils/retry-after.ts,auth-storage.ts}` ·
`packages/catalog/src/{models.json,identity/}` · `packages/mnemopi/` ·
`packages/coding-agent/src/{advisor/,lsp/,dap/}` · `crates/pi-iso/` ·
`packages/coding-agent/src/extensibility/custom-commands/bundled/review/` ·
docs: `rpc.md, sdk.md, approval-mode.md, session.md, collab.md, compaction.md,
advisor-watchdog.md, auth-broker-gateway.md, lsp-config.md, natives-*.md`.

**Nossos (pontos de encaixe):**
`src/main/adapters/{adapter-registry,model-catalog,managed-credentials}.ts` ·
`src/main/orch/{limit-detector,failover,mission-scheduler,tools-*.ts}` ·
`src/main/quota/provider-live-usage.ts` · `src/main/remote/{remote-bridge,
device-pairing,mobile-companion-policy}.ts` · `src/main/editor/editor-document.ts` ·
`src/main/security/workspace-file.ts` · `src/main/memory/nexus-memory.ts` ·
`src/main/usage/{usage-service,usage-store}.ts` · `docs/{multi-account-matrix,
orchestration,EDITOR,adding-a-cli}.md`.
