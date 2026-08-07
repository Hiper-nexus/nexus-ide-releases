# NexusIDE × BridgeSpace — herança útil, travas reais e ordem de ataque

> **Status:** baseline canônica verificada em 2026-08-06, com estado de implementação atualizado para a release 0.28.1 em 2026-08-07.
> **Tese:** herdar do Bridge a casca legível e degradável, sem trocar o motor mais forte do Nexus por uma orquestração mais fraca.

## Estado de implementação na 0.28.1

A ordem H1–H6 abaixo registra a decisão e os critérios originais. O estado
entregue, verificado contra o `HEAD` da release, é:

| Frente                | Estado na 0.28.1                                                                                                                                        | Limite preservado                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| H1 — scope legível    | **Entregue:** `BOARD.md`, `status.json` e `events.jsonl`, derivados do SQLite com escrita atômica, isolamento, redação e guardas contra symlink/escape. | Não há transcript PTY bruto nem edição do board como fonte de verdade.                            |
| H2 — fachada canônica | **Parcial:** `nx-mail`, `nx-task` e `nx-notify` entram no `PATH` com capability e terminam no journal Main-owned.                                       | Os slash commands de produto ainda não foram unificados.                                          |
| H3 — degradação       | **Parcial:** inbox/handoff, PREVC e dispatch ganharam caminhos explícitos; causa de bloqueio chega à evidência do gate.                                 | Reroute automático de worker vivo/mudo e cobertura tier-by-tier de todo gate continuam pendentes. |
| H4 — Markdown         | **Entregue na entrada segura:** conteúdo humano é validado, redigido, deduplicado e indexado; a identidade de missão é atribuída pelo Main.             | A experiência completa de edição/conflito por CAS ainda não existe.                               |
| H5 — command refinery | **Entregue:** frequência, sucesso, recência/decay e dismiss alimentam sugestões por contexto.                                                           | O tier mais amplo ainda é checkout-local, não global entre projetos.                              |
| H6 — caminho/overlay  | **Parcial:** ações operacionais, atalhos e caminho do wizard foram enxugados; overlay próprio corrige continuidade e stacking.                          | A convergência total Rail/Ops/Orchestration e a decomposição dos god-components seguem abertas.   |

As seções em modo imperativo preservam o plano original para auditoria; esta
tabela é a leitura autoritativa do que já foi fechado versus o que permanece.

## Veredito executivo

O Bridge não é mais poderoso que o Nexus. Ele opera com menos atrito porque duas
propriedades aparecem em todo o produto:

1. **Legibilidade:** missão, agentes, mensagens, plano e status têm representação
   simples em disco. Um humano ou agente consegue inspecionar o estado sem abrir
   o banco certo nem conhecer a arquitetura interna.
2. **Degradação:** mailbox, transcript, nudge e detecção de inatividade formam
   caminhos redundantes. A perda de um sinal tende a reduzir a qualidade da
   coordenação, não a transformar imediatamente a missão numa parede.

O Nexus já é superior onde não pode regredir: PTY isolado e com ownership,
multi-CLI e multi-conta, worktrees, políticas de efeito default-deny, schemas nos
boundaries, recibos físicos imutáveis e cadeia de hash. O alvo correto é:

> **Bridge por fora, Nexus por dentro:** caminho leve, estado explicável e
> comandos canônicos sobre a autoridade, os receipts e os fences atuais.

## Limites de evidência

- O scope, as CLIs, o mailbox, o plano e o status do Bridge foram observados em
  artefatos vivos e estão documentados em
  `/Users/cleofasrocha/bridge-reverse-swarm/F5-swarm-missoes.md`.
- O command refinery foi extraído do schema/SQL em
  `/Users/cleofasrocha/bridge-reverse-swarm/F4-dados-runtime.md`.
- O BridgeMemory foi lido do servidor MCP em
  `/Users/cleofasrocha/bridge-reverse-swarm/F2-bridgememory-mcp.md`.
- Parte do motion e do efeito visual builder-to-builder é reconstrução por
  assets/chunks, não observação visual completa. Deve ser tratada como direção,
  não como especificação exata.
- A auditoria da interface do Nexus abaixo é baseada em código, testes e no
  `DESIGN.md`. Não houve captura visual do app em execução nesta sessão.

## Correções importantes aos handoffs

Os handoffs encontraram o eixo certo, mas quatro afirmações já estavam
desatualizadas em relação ao código atual:

| Afirmação recebida              | Estado atual verificado                                                                                                                                                                          | Consequência                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| “TTL pós-handoff é opt-in”      | A implementação ainda tem comentário antigo, mas a flag está `defaultEnabled: true` em `src/shared/feature-flags.ts:143-153`.                                                                    | Corrigir comentário e copy de Labs; não planejar novamente o que já foi ligado.                                                                |
| “Worker mudo trava para sempre” | `worker-handoff-enforcement.ts:20-32` já faz carência → nudge → handoff sintético `blocked/failed`; falha ao escrever o nudge cobra direto (`:271-294`).                                         | O gap restante é obter o **resultado real** sem MCP/hook e tornar a degradação visível, não criar o primeiro fallback.                         |
| “NL sempre vira um escritor”    | O planner já sela wave packs multi-writer para arquivos/áreas disjuntas (`guided-mission-planner-seal.test.ts:900-935`) e o claim valida disjunção (`task-dispatch-claim-authority.ts:413-452`). | O problema residual é cobertura/explicação da inferência de ownership e o caminho de fallback quando ela falha.                                |
| “Missão bloqueada não volta”    | Há recuperação Main-owned e reopen explícito (`confirm-reopen-mission.ts:69-81`; `mission-orchestrator-bootstrap.ts:2927-3103`).                                                                 | “Bloqueada para sempre” não é a regra atual; a sensação persiste quando causa, retry e próximo passo ficam escondidos em projeções diferentes. |

Também não há motivo para copiar `z-index: 100000` ou motion elástico. O Nexus já
tem portals pontuais, pilha dinâmica de painéis e ladder semântica de overlays
(`panel-stack.ts`, `base.css:99-110`). O `DESIGN.md:93-99` proíbe bounce/elastic e
exige motion de estado. Do Bridge interessa a **continuidade espacial do
handoff**, adaptada aos tokens do Nexus.

## Mapa cruzado

| Capacidade                 | Bridge                                                                                   | Nexus hoje                                                                                                                                             | Decisão                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Estado da missão           | Scope legível com board, prompts, inbox, transcript, events e status.                    | Estado canônico e robusto em `runtime.sqlite3` por checkout; diretórios usam digests (`project-runtime-manager.ts:200-223`).                           | **Herdar como projeção**, nunca como nova fonte da verdade.                         |
| Coordenação do worker      | `bs-mail`, `bs-swarm` e `bs-notify` no `PATH`, sem depender do MCP do provider.          | MCP + hooks + entrega por PTY; enforcement cobre silêncio, mas não recupera o resultado real quando o canal falha.                                     | **Herdar uma via CLI capability-scoped** que termina no journal canônico.           |
| Plano e ownership          | Eventos append-only, `ownedFiles`, dependências e critérios de aceite, legíveis por CLI. | Scheduler, receipts, ACK físico, worktrees e escritores disjuntos são mais fortes.                                                                     | **Manter o motor Nexus** e expor a projeção/explicação.                             |
| Liveness                   | Transcript-first, nudge e fallback de inatividade.                                       | TTL default-on, auto-close no spawn, nudge + handoff sintético, stall/recovery watchdogs.                                                              | Paridade estrutural parcial; falta independência de canal e UX única de degradação. |
| Memória                    | Markdown é canônico e navegável por wikilinks.                                           | SQLite/FTS5 é canônico; `.nexus-memory` é view gerada e edições são sobrescritas (`nexus-memory.ts:7-14`).                                             | **Aceitar Markdown humano como entrada segura**, mantendo FTS, audit e dedupe.      |
| Histórico de shell         | `command_stats` com frequência, sucesso, recência, dismiss e decay.                      | OSC 133, redaction, CommandBlocks, busca recente e stats globais já existem. Não há frecency/dismiss/decay.                                            | **Gap real e barato:** construir refinery sobre o dado existente.                   |
| Wizard e contexto          | Brief curto, pasta e context files/`@`.                                                  | Todos os ingredientes existem, inclusive anexos de texto/código, imagem e áudio. O fluxo pode repetir o objetivo e abre detalhes de roster por padrão. | **Simplificar o caminho padrão**, não criar outro wizard paralelo.                  |
| Handoff visual             | Overlay dá continuidade espacial entre origem e destino.                                 | Há portals, panel stack e `MissionEndorphinFx`, mas o handoff é um burst genérico.                                                                     | Herdar apenas a direção origem→destino e o feedback de chegada.                     |
| Browser/inspector          | Picker/inspector injetado no webview.                                                    | Design session main-owned, seleção validada e sidebar já existem.                                                                                      | Gap antigo fechado; polir, não portar o hack de `document.title`.                   |
| MCP Hub                    | Projeções locais para CLIs.                                                              | Sync multi-tool, dry-run, backup e fill-gaps sem apagar segredos já existem.                                                                           | Nexus já iguala ou supera.                                                          |
| Voz/mobile                 | Satélite de ditado separado e controle mobile.                                           | Jarvis/ClockVoice, relay E2E, companion e remoto já existem.                                                                                           | Satélite global é opção de produto, não lacuna do motor.                            |
| PTY, segurança e multi-CLI | PTY Rust e gates locais.                                                                 | Utility process recuperável, nove adapters, multi-conta, effect policy, receipts e worktrees.                                                          | **Preservar Nexus.**                                                                |

## O que herdar, em ordem de alavancagem

### H1. Scope de missão legível em disco

Criar uma projeção derivada por missão, por exemplo:

```text
<project-runtime>/missions/<mission-id>/
├── SCOPE.json
├── BRIEF.md
├── BOARD.md
├── agents.json
├── events/
├── handoffs/
│   └── transcript.jsonl
└── status/
    └── <worker-incarnation>.json
```

Regras:

- `runtime.sqlite3` continua autoritativo.
- O projector consome os stores/journal existentes; `ProjectDomainStoreRegistry`
  já oferece os seams `onChange` e `onScope` (`project-domain-store-registry.ts:137-158`).
- Snapshots usam escrita atômica, `lstat`/no-follow, permissões restritas e
  redação. Não exportar output bruto de PTY nem segredos.
- `BOARD.md` explica estado, owner, dependências, bloqueio atual e próximo passo.
- A UI ganha “Abrir pasta da missão” e uma CLI resolve o caminho sem exigir que
  o operador conheça os digests do runtime.
- A primeira versão é **read-only projection**. Inputs humanos entram por APIs
  explícitas com CAS, nunca por last-write-wins silencioso.

Aceite: um diagnóstico de missão deve ser possível com `ls` + leitura de
`BOARD.md`, sem consultar SQLite.

### H2. Fachada canônica: shims no PATH + slash commands

Adicionar um diretório privado e versionado ao `PATH` de cada worker, com três
comandos estreitos:

- `nx-mail`: enviar/listar/consumir mensagens da missão;
- `nx-task`: listar, assumir e atualizar a task autorizada;
- `nx-notify`: publicar status/heartbeat e pedir wake.

Os shims não devem escrever SQLite diretamente. Eles escrevem intents
autenticadas numa dropbox do scope; o Main valida mission, session, incarnation,
sequência e operação permitida, então grava no journal e em um receipt físico
com proveniência própria (`mission-shim`). O token de capacidade deve ter curta
duração, ser revogável no exit e limitado à missão/worker.

Na UX, a mesma fachada vira poucos comandos canônicos, em vez de expor o
catálogo MCP inteiro:

- `/missão <objetivo>`
- `/delegar @agente <tarefa>`
- `/status`
- `/entregas`
- `/bloqueios`
- `/retomar`
- `/parar`

Aceite: desligar MCP e hooks de um worker não pode impedir que ele entregue um
resultado real pelo shim, e a UI deve mostrar a mesma entrega sem caminho
especial.

### H3. Degradação por tier aplicada aos gates

O tipo `MissionDegradation` já existe (`mission-degradation.ts:19-43`), mas ainda
é majoritariamente doutrina/apresentação. A allowlist atual chama todos os 19
blocos de legítimos (`:54-87`), portanto o teste não força um tier alternativo.

Transformar cada falta de capacidade em uma destas saídas:

| Condição                | Tier degradado                                                                                               | Quando ainda bloquear                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Ownership não inferida  | Um escritor em `same_checkout`, com superfície e motivo visíveis.                                            | Nenhum limite seguro de escrita pode ser definido.                                                                      |
| PREVC não disponível    | Antes de qualquer freeze/efeito, resele a missão no caminho simples sem PREVC e marque a redução no receipt. | Nunca degradar depois de freeze parcial; bloquear se a ausência compromete autoridade, CAS, cronologia ou prova física. |
| Squad ausente/stale     | Antes da execução, propor/selar um roster default qualificado e informar a troca.                            | Nunca trocar um roster já selado; bloquear se não existe rota autenticada/launchable.                                   |
| Roster acima do teto    | Usar o teto e enfileirar o restante.                                                                         | Nunca por tamanho apenas.                                                                                               |
| Recovery lock ocupado   | Enfileirar e reentrar com ETA/estado.                                                                        | Corrupção ou perda de autoridade.                                                                                       |
| Canal de handoff falhou | Shim → nudge → fallback sintético, nessa ordem.                                                              | O resultado segue desconhecido após todas as vias; bloquear com evidência preservada.                                   |

Bloqueios que devem continuar fail-closed: perda de CAS, receipt físico ausente,
topologia corrompida, escopo escapando, conflito real de ownership e ação
irreversível/externa sem autoridade adequada.

Aceite: todo block code novo precisa declarar `degradeTo` ou justificar por que
qualquer saída menor produziria uma mentira.

### H4. Markdown como entrada de memória, sem perder FTS5

Não inverter a arquitetura para “só arquivos”. Criar duas classes claras:

1. `generated: true`: projeções do SQLite, somente leitura;
2. `authored: true`: Markdown do usuário, importável e editável.

O import calcula hash/revisão, valida H1/wikilinks/tamanho, rejeita symlink,
faz CAS contra a revisão anterior e atualiza SQLite/FTS5. Conflito abre revisão,
nunca sobrescreve. Isso herda a propriedade humana/Git-native do Bridge sem
herdar seu last-write-wins nem sua busca linear sem teto.

Aceite: editar uma nota `authored` e sincronizar deve mudar o recall; editar uma
projeção `generated` deve produzir uma mensagem clara, não desaparecer em
silêncio no próximo sync.

### H5. Command refinery sobre CommandBlocks

O Nexus já persiste comandos redigidos, cwd, project root, branch, duração e
exit code (`command-block-store.ts:18-62`) e oferece ações no pane. Falta o
produto de sugestão:

- agregado por `(cwd, command)`;
- frequência, sucesso, dias distintos e first/last used;
- feedback negativo (`dismissedCount`, `lastDismissedAt`);
- decay periódico e prune;
- ranking em três níveis: cwd → project root → global;
- autocomplete explicável, com ação de dispensar.

Aceite: o usuário encontra/reexecuta um comando frequente sem abrir histórico e
uma sugestão dispensada perde ranking de modo mensurável.

### H6. Caminho padrão de missão + continuidade do handoff

O fluxo alvo tem três decisões, não nove superfícies possíveis:

1. **Objetivo e contexto:** digitar uma vez; `@arquivo`, drop e botão explícito
   para arquivo de contexto.
2. **Rota pronta:** resumo do time, custo/teto e somente exceções que exigem ação.
   CLI, modelo, roles, tools, budget, PREVC e receipts ficam em “Avançado”.
3. **Iniciar:** um CTA. Depois, timeline `Brief → Trabalho → Entrega → Concluído`.

Hoje o Home passa o objetivo para `openAgentic` (`HomeDeck.tsx:209-225`), mas o
wizard mostra o mesmo textarea e exige “Preparar missão”
(`MissionWizard.tsx:2128-2204`). A revisão também inicia a personalização aberta
(`MissionWizardReview.tsx:158-162`). São fricções concretas a remover.

Para handoff, estender a infraestrutura existente: um traço curto ou destaque
de origem→destino no canvas, com opacity/transform, 150–220 ms e
`prefers-reduced-motion`. Não copiar spring, halo permanente ou `z-index`
mágico; seguir `DESIGN.md:93-99` e a ladder de `base.css`.

## As travas reais do Nexus hoje

### 1. Estado operacional opaco

O banco por checkout é correto para autoridade, mas ruim como instrumento. O
path usa digests e o erro relevante pode estar em uma tabela que só o autor da
arquitetura conhece. O scope legível resolve observabilidade sem enfraquecer a
persistência.

### 2. Gates com fallback ainda incompleto

PREVC, ownership, roster e recovery protegem invariantes reais, mas o runtime
ainda possui estados de espera/bloqueio sem tier menor. O próprio schema registra
o caso de missão entregue que permanece `running` porque PREVC responde
`not-ready` (`project-runtime-orchestration-migrations.ts:494-514`). O
diagnóstico ficou durável; a saída automática ainda precisa ser decidida por
classe de risco.

### 3. Descoberta fragmentada

O produto monta simultaneamente Rail, Home, OrchestrationPanel, Memory,
ContextualPanel e OpsBoard (`App.tsx:572-647`). O OpsBoard admite ser outra
projeção do mesmo domínio (`OpsBoard.tsx:47-52`). Settings possui 31 destinos
planos (`settings-nav.ts:1-31`). Há capacidade, mas o operador precisa conhecer
onde ela mora.

Hierarquia recomendada: **rail quieto → detalhe único da missão → Operações
avançadas**. Preservar as projeções internas, unificar entrada, vocabulário e
próximo passo.

### 4. Readiness técnico demais no caminho leigo

A revisão valida corretamente instalação, autenticação, launch, prompt e status,
mas expõe “injeção de prompt”, “status observável” e “gate de Maestro”
(`MissionWizardReview.tsx:281-354`). O CTA pode ficar desabilitado enquanto a
correção vive em outra configuração.

Mostrar uma causa humana e uma ação: “Claude precisa entrar na conta — Corrigir”.
Detalhes técnicos continuam acessíveis em expansão/Doctor.

### 5. Copy e política de aprovação divergentes

Onboarding e review prometem uma aprovação (`ProgressiveOnboarding.tsx:76-79`;
`MissionWizardReview.tsx:822-825`), mas o runtime autoautoriza inclusive risco
destrutivo (`orch-ipc.ts:843-871`) e o release exige zero diálogos
(`real-mission-e2e-evidence.ts:1039-1059`). Isso quebra a previsibilidade do
produto.

Decisão recomendada: sem prompt para leitura e mutações locais reversíveis; uma
revisão compacta apenas para efeito irreversível, externo ou de alto impacto.
Receipts e reversibilidade permanecem sempre. Qualquer decisão diferente exige
alinhar código, `DESIGN.md`, onboarding e testes no mesmo change.

### 6. Componentes-monólito elevam o custo de simplificar

`MissionWizard.tsx` tem 2.826 linhas, `MissionRail.tsx` 1.179 e
`MissionWizardReview.tsx` 861, acima do hard max de 800 do projeto. O problema
não é estético: cada correção de fluxo toca múltiplos estados e reabre regressões
de draft, roster, reopen e gate. Fatiar por feature é parte da correção de UX.

## O que não herdar do Bridge

- Filesystem/React como autoridade total da orquestração.
- Escrita concorrente last-write-wins em Markdown.
- Mailbox sem receipt, ACK físico, idempotência e cadeia de hash.
- Busca de memória linear como solução de escala.
- Hacks de `document.title` quando o preload tipado do Nexus já resolve IPC.
- `z-index: 100000`, paleta hardcoded ou motion elástico em conflito com o
  design system do Nexus.
- Premissas macOS-only, gating comercial do runtime ou PTY sem ownership.

## Ordem de ataque

### P0 — devolver instrumentos e uma rota que sempre termina

1. Projector de scope legível, com `BOARD.md`, status e transcript de handoffs.
2. `nx-mail`/`nx-task`/`nx-notify` capability-scoped, ingeridos pelo Main.
3. Wire real de `MissionDegradation` para ownership, PREVC, roster e recovery;
   manter allowlist apenas para invariantes sem saída verdadeira.
4. Corrigir a copy stale de TTL/aprovação e exibir um próximo passo único em
   todo estado bloqueado/esperando.

### P1 — reduzir o caminho padrão

5. Objetivo digitado uma vez, `@`/arquivo de contexto explícito e roster
   avançado fechado por default.
6. Unificar Rail/Ops/Orchestration sob um detalhe de missão com timeline + board.
7. Slash commands canônicos e readiness Doctor inline.
8. Command refinery e autocomplete em três escopos.

### P2 — tornar o sistema humano sem perder rigor

9. Ingestão Markdown com CAS para memória authored.
10. Handoff espacial adaptado ao motion Nexus.
11. Avaliar satélite global de ditado como produto separado.
12. Fatiar Wizard, Review e Rail em domínios testáveis.

## Métricas de aceite do programa

- Objetivo → início em no máximo três telas, sem redigitar o objetivo.
- Zero ida a Settings quando já existe uma rota qualificada.
- Toda espera/bloqueio mostra causa, tier escolhido e próxima ação na mesma
  superfície.
- Estado de uma missão diagnosticável sem query SQL.
- Falha simultânea de MCP/hook ainda permite entrega real via shim.
- Nenhuma regressão em effect policy, scope containment, worktree disjointness,
  receipt físico, ACK ou hash chain.
