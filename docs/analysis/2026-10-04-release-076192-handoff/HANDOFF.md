# Handoff — concluir a release macOS 0.76.192 completa

Atualizado em 04/10/2026, aproximadamente 22:20 BRT. **A release NÃO foi publicada e ainda NÃO existe candidato assinado/notarizado desta integração.**


## Atualização final solicitada pelo operador

O operador pediu commitar o que estava concluído e **encerrar esta sessão para outra LLM assumir**. O código F-907 está commitado em995c27284. Os WIPs Muse/AGY/startup continuam separados e preservados. A nova release NÃO está pronta/publicada.

A lista completa foi acrescentada **no próprio handoff abaixo**, além de `PEDIDOS-E-MELHORIAS.md`. As15 fontes integrais e seus hashes estão em `fontes/` e `FONTES-MANIFEST.json`. Não se trata apenas de apontadores para a matriz ignorada.

## 1. Objetivo e autorização

O operador pediu seguir até a nova release com **toda a integração pendente da Missão Terminais + F-764 completo + todas as melhorias solicitadas**, sem deixar itens para depois. Integração, push e publicação já estão autorizados. Não pedir novamente aprovação genérica para continuar.

Também autorizou:
- novas worktrees/candidatos com sufixo `.noindex`, preservando trabalhos existentes;
- rede e execução livres no padrão Autopilot do Nexus. O padrão já é full-auto/sem sandbox externo; não acrescentar barreiras. Preservar as escolhas explícitas de modo governado;
- provas reais pequenas de CLI autenticada quando necessárias, com workspace próprio, comando finito e teto físico de 30 s. Não fabricar autenticação/entitlement, copiar tokens de refresh ou registrar segredos.

A última solicitação foi **este handoff para outra LLM**. Os executores receberam instrução de não iniciar novas frentes e preservar seus WIPs. A tarefa global continua incompleta. Foi dito ao usuário que, depois de fechar o código, validar/assinar/testar/publicar pode levar aproximadamente 1–2 horas se os gates passarem; **não foi prometido prazo total**.

## 2. Trabalhe na árvore correta

- Checkout original: `/Users/cleofaspereirarocha/nexus-ide` — preservar trabalho do operador.
- **Integração principal:** `/Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final`
- Branch: `release/0.76.191-final`
- **Último commit de código: `995c27284498ea5d4137ccc81b7c937c338f84d9`**. O commit deste documento vem depois; conferir git log/status ao retomar.
- Nome antigo da pasta/branch foi mantido; a versão preparada é **0.76.192**.
- A tag local `v0.76.191` é histórica, em `6050422d`; **não reescrever**.
- Último remoto observado: `origin/main = d24073cb931d0be934fc4b43d5fe503c34825e07`, já integrado em `e03f1adf0`. A URL legacy do origin redireciona para a canônica. Revalidar remoto e disponibilidade de v192 antes de criar tag/publicar.

Leia `AGENTS.md`, `docs/RELEASE-CHECKLIST.md`, os documentos de segurança indicados pelo AGENTS antes de alterar orch/pty/runtime, e:
- `docs/analysis/2026-10-03-release-076191/PLAN.md`
- `docs/analysis/2026-10-03-release-076191/PENDENCIAS.md`
- `docs/analysis/2026-10-03-main-thread-hang/HANDOFF.md`
- `docs/analysis/2026-10-03-missao-terminais/HANDOFF-INTEGRACAO.md`
- `.superpowers/sdd/PLAN/coverage-current-final.md` — mapa de 104 requisitos; proveniência não equivale a aceite final.

## 3. Ambiente de validação — importante

Use Node **22.23.2**: `/opt/homebrew/opt/node@22/bin/node`. O Node padrão é 26; não o use nos gates. A única exceção histórica é a CLI MiniMax instalada com ABI147; os validadores continuam Node22.

**Nunca instalar/rebuild no node_modules compartilhado do checkout original.** O node_modules da integração é compartilhado. Existe uma árvore privada com dependências próprias:

`/Users/cleofaspereirarocha/.nexus-worktrees/release-validation-20261004-recreated.noindex/source.noindex`

Ela está em `3c23cc9a75386ab42f29007abcd74d0e41bea54f`, com WIP de validação do F-907 e cópia antiga do protótipo AGY. Não assumir que está limpa. Node22, npm12, Electron43.7.4; npm ci privado (902 pacotes), postinstall e rebuild:node passaram. O npm12 está em:

`/Users/cleofaspereirarocha/.nexus-worktrees/release-validation-20261004-recreated.noindex/npm-bootstrap/package/bin/npm-cli.js`

Caminhos atuais em `.superpowers/sdd/PLAN/private-verification-location.json`. Os diretórios de verificação antigos `release-verification-5f5a45f4-*` sumiram por mudança externa; não reutilizar seus caminhos.

**Um validador pesado por vez, com mutex compartilhado:**

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
python3 /Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/with-validation-lock.py \
/opt/homebrew/opt/node@22/bin/node ./node_modules/vitest/vitest.mjs run CAMINHO.test.ts --maxWorkers=1
```

Executar no cwd apropriado. Não reiniciar processo só porque uma consulta expirou; consumir o mesmo handle até conclusão. Todos os handles informados abaixo estavam terminados no handoff; se outra sessão reiniciou trabalho, conferir primeiro. Não matar processos do operador, não usar stash/reset/clean ou add -A/add .; commits por pathspec.

## 4. Já integrado e verificado em escopos delimitados

- 17 heads de origem integrados; cinco WIPs originais e três arquivos não rastreados conferidos contra snapshots. Onze diretórios antigos limpos foram removidos externamente; os commits continuam ancestrais e os seis checkouts restantes mantêm seus heads. Nenhuma remoção desses diretórios foi feita nesta etapa. Evidência: `PLAN/preservation-current.json`.
- Memória, retomada, diversidade/roteamento, navegador/handoff visual e N1–N14 estão na integração de fonte. Ainda exigem a auditoria final e os fluxos no app assinado.
- F-764: lotes/backpressure/créditos, análise em Worker, regexes limitadas, intervalos com orçamento, Git assíncrono, lint contra novos processos Sync, watchdog com profile e faixa ocupado.
- F-902 (`9beed545f`): contador de custo não copia/filtra toda a janela a cada lote. RED real 20 mil lotes em 5.740 ms; correção passou 17 testes/2 suítes e typecheck. Expiração exata permanece no snapshot periódico.
- F-903 autor `3fd5ff7a4`, importado como **`3c23cc9a7`**: reutiliza apenas normalização pura do texto de prompt, com cache limitado e limpo por sessão. Não cacheia decisões temporais. 51 testes/3 suítes e typecheck passaram.
- **Carga normal de 30 s passou:** 170.102.897 bytes, **5,613 MB/s**, p99 **11,969 ms**, máximo **219,231 ms**, bloqueio síncrono de spawn **33,996 ms**; hashes, barreiras, paste, PRONTO, handoff, OSC e supervisor passaram. Sem sessões degradadas.
- **Carga poison de 30 s passou:** Worker antigo terminou fisicamente, substituto processou a conclusão, sem fallback pesado no Main. p99 8,659 ms; máximo 202,415 ms. Sua vazão bruta elevada é transporte degradado, não throughput de análise saudável.
- Evidências copiadas para `PLAN/f764-normalization-3fd5ff7a4/`; relatório `PLAN/task-2-analysis-worker-throughput-report.md`. Corridas anteriores de 1,282 e 3,833 MB/s falharam e foram preservadas, não contam como aceite.
- Codex real: quatro controles baseline/fila em padrão livre e modo opcional restrito passaram. Uma falha era socket Unix de fixture longo demais, corrigida em `76ee1cf4e`. API/caller/canal receberam revisão independente de fonte.
- Aider real em PTY, aprovação única normal: baseline e fila passaram; a recusa original do modo --yes-always foi registrada separadamente. União Aider + billing: **46 testes/4 suítes**, 22,23 s; `PLAN/aider-63f-receipt.json`.
- Claude/Grok/Kimi/OpenCode/Qwen/MiMo/MiniMax têm controles privados delimitados e correções integradas; ver matriz `docs/analysis/2026-10-03-main-thread-hang/NATIVE-C6-ADAPTER-MATRIX.md`. Não extrapolar para app assinado nem outras plataformas.
- Audit privado de dependências de produção: zero vulnerabilidades. Preflight Developer ID e perfil `nexus-notary` passaram; isso NÃO é assinatura/notarização de um artifact.

## 5. WIP CRÍTICO na integração — não perder

### F-907: serviços MCP tomavam a vaga de build

Arquivos **commitados em `995c27284498ea5d4137ccc81b7c937c338f84d9`** na integração:
- `resources/heavy-command/catalog.cjs`
- `src/main/orch/native-heavy-mcp-services.test.ts` (novo)

Causa confirmada no Devin real com HOME nativo: primeiro Node de startup pega a única reserva e permanece vivo como serviço. Outros MCPs e o Make ficam na fila até o timeout. Não é falta de login.

Patch atual:
- identifica bin declarado de pacote MCP por `mcpName`, dependência SDK ou proxy legacy `mcp-remote`;
- identifica a ponte Nexus por caminho + cabeçalho;
- npx/npm exec deixam a reserva finita para o programa filho; **instrumentação dos filhos continua ativa**;
- não remove a proteção genérica de Node nem a de build/test/install.

**Validação observada:** RED 5/7 antes; GREEN 7/7; depois **59 testes/4 suítes passaram** em `PLAN/f907-native-union.log` (handle59589 terminou0). Inclui serviço/bridge e filho compilador bloqueado quando Main está indisponível. **Typecheck privado terminou0; QA F-907 e código foram commitados. Ainda faltam revisão e repetição do Devin real nos dois HOMEs após esta correção.** O código/teste também foram copiados para a árvore privada de validação, como WIP.

### Recuperação Muse no startup

Também WIP Root:
- `src/main/orch/mcp-server.ts`: import e await de `recoverMuseNativeHeavyLeases` antes dos purgers; falha é reportada só por contagens, sem vazar config nem bloquear outras CLIs.
- `src/main/orch/mcp-server-muse-recovery.test.ts`: novo, ordem real de startup e falha saneada.

RED: recuperação não chamada. GREEN: **5 testes/2 suítes** com supervisor, `PLAN/muse-startup-recovery-final.log`, handle90520 terminou0.

**O módulo `native-heavy-muse-lease.ts` AINDA NÃO ESTÁ NA INTEGRAÇÃO.** Está no WIP do executor abaixo. Logo um typecheck da árvore Root inteira pode falhar por esse import: integrar o módulo correto, não apagar o await para silenciar erro. O shutdown existente aguarda o start supervisor antes de desmontar MCP/stores.

### Protótipo AGY

`src/main/orch/native-heavy-agy.test.ts` na Root é um protótipo não commitado. Foi entregue ao executor AGY; não sobrepor a versão final dele com essa cópia antiga.

## 6. Trabalhos dos executores a recuperar

### Muse — executor heavy_command_completion

- Árvore: `/Users/cleofaspereirarocha/.nexus-worktrees/release-076191-heavy-completion`
- HEAD: `fbf24caa29a9113f239f6f85cd12ceb35a91cff2`
- WIP: `native-heavy-muse-lease.ts/.test.ts` novos; alterações em `native-heavy-muse-profile.ts`, `resources/heavy-command/muse-tool-hook.cjs` e região Muse/readiness de `pty-manager.ts`.
- **5 testes de lease passaram**, handle85981 terminou0. Sem handles vivos relatados.
- SDK real IGNORA `MUSE_AUTH_PATH`, confirmado por parser em arquivos sintéticos. Não voltar a usar esse override como solução.
- Solução em andamento: manter HOME/XDG/auth selecionados no lugar e alugar somente hook constante no settings; env do hook Muse é limpo, por isso o guard é no comando alvo. Ledger sem tokens/keys/URLs sob raiz padrão de mcp-clients.
- API congelada: `recoverMuseNativeHeavyLeases(options?: { artifactRoot?: string }): Promise<{ restored: number; retained: number; failed: number }>`.
- Root encontrou crash entre criar lock vazio e escrever dono. Executor mudou para arquivo de dono completo+fsync+link atômico; existe teste inicial. **Ainda precisa revisão e controle cross-process real.**
- Pendentes: adaptar testes do profile e fixture SDK, provar auth no lugar/edição estrangeira/refcount/recovery, quatro controles reais Muse, typecheck/sinks/Sync, QA F-904/F-905, commit e revisão independente.
- Revisão anterior que motivou isso: `PLAN/review-muse-caller-119e67127.md`; não é aprovação do novo lease.

### AGY — executor analysis_worker

- Árvore: `/Users/cleofaspereirarocha/.nexus-worktrees/f764-agy-heavy-command-20261004.noindex`
- Branch `fix/f764-agy-heavy-command`; HEAD `3c23cc9a75386ab42f29007abcd74d0e41bea54f`.
- Quatro arquivos novos WIP: `resources/heavy-command/agy-tool-hook.cjs`, `native-heavy-agy-plugin.ts`, `native-heavy-agy-plugin.test.ts`, `native-heavy-agy.test.ts`.
- **7 testes focados passaram**, handle84952 terminou0. Sem handles vivos relatados.
- Root provou AGY real carrega `.agents/hooks.json`; `overwrite.CommandLine` funciona. **Sem decision a ferramenta é negada**. `decision:'ask'` respeita o padrão full-auto e passou; não usar allow para pular a política.
- `agy plugin validate/install <dir>` aceitou plugin.json `{name,version,description,hooks:'./hooks.json'}`. Instalação de prova foi SOMENTE em HOME temporário; nenhuma instalação global do operador foi feita.
- Plugin vai para `HOME/.gemini/config/plugins/<nome>` + import_manifest. XDG_CONFIG_HOME/CASCADE_GLOBAL_CONFIG_OVERRIDE não mudaram esse local no teste.
- API proposta: `ensureAgyNativeHeavyPlugin({home, agyBin, node, resourceDirectory, signal?, assertCurrent?}) -> Promise<{registered:boolean, reason?:string}>`. Async, idempotente, nome exclusivo, não sobrescrever conflito estrangeiro, autoridade por chamador mesmo com instalação compartilhada.
- **Falta:** typecheck; substituir cópia da fixture `.agents` por teste real do plugin global + file channel + prova física baseline/fila; incorporar F-907 antes desse teste; QA F-906 e commit. Integrar readiness no `pty-manager` depois do Muse, revalidando após awaits. Usar o file channel já existente, sem acrescentar dependência de TCP no sandbox.
- Desabilitar updater apenas na fixture por `AGY_CLI_DISABLE_AUTO_UPDATE=1`; tempo nativo20 s e teto físico30 s. Fora de contexto Nexus: ask/sem overwrite; canal incompleto dentro do Nexus não pode executar pesado sem reserva.

### Devin — executor busy_banner_acceptance

- Árvore: `/Users/cleofaspereirarocha/.nexus-worktrees/release-native-remaining-be091fd6.noindex`
- HEAD `d42842c930ab8c7f5355dbb1200a2e5874038abe`.
- Commits 0e11a4293 (Aider) e d42842c93 (auth/doc) JÁ integrados no Root como 2f52822f9/63fdef76a. Não reaplicar.
- WIP: novo `src/main/orch/native-heavy-devin-authenticated.test.ts`; alteração `docs/analysis/2026-10-03-main-thread-hang/NATIVE-C6-REMAINING-PREFLIGHT.md`.
- Teste SHA256 `f8776d1f562489b9e6629dd89714941b60f18e9bfd4ff6ae4385a0e8a8d41e4f` no handoff.
- Typecheck70188, sinks94130 e Sync26477 terminaram0; sem handles vivos.
- HOME privado: baseline/fila **PASS**, receipt `/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-devin-auth-KfLDg6/receipt.json`.
- HOME nativo: baseline PASS; fila **RED** por MCP persistente, receipt `.../nexus-c6-devin-auth-NHNjYr/receipt.json`. Primeiro Node42342 segura vaga, Make42897 fica esperando; @playwright/mcp42344 também identificado. Todos os jobs estavam gone antes do drain, stopCalls0. Primeiro módulo específico não foi retido; diagnóstico adicional startup-only foi autorizado, mas não iniciado.
- Erro antigo r1fT2M/exit74 era agravado por timeout HTTP3s da fixture; já corrigido. Não usar aquele erro como evidência atual.
- Próximo passo: congelar teste/doc com status RED explícito, aplicar F-907 e repetir:

```sh
NEXUS_TEST_DEVIN_AUTHENTICATED=1 PATH=/opt/homebrew/opt/node@22/bin:$PATH \
python3 /Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/with-validation-lock.py \
/opt/homebrew/opt/node@22/bin/node ./node_modules/vitest/vitest.mjs run src/main/orch/native-heavy-devin-authenticated.test.ts --maxWorkers=1
# Repetir adicionando NEXUS_TEST_DEVIN_NATIVE_HOME=1.
```

Não declarar resolvido usando só o HOME privado: o produto pode preservar HOME nativo e autocarregar MCPs.

## 7. Snapshots de segurança do handoff

WIPs de **cinco árvores** foram copiados, sem reset/stash/remoção, para:

`/Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/handoff-20261004-2218/`

`manifest.json` contém HEAD, status, hash do patch e de cada arquivo novo. Subpastas `integration`, `muse`, `agy`, `devin`, `validation` têm `tracked.patch`, `staged.patch` e `untracked/`.

Primeiro prefira as árvores vivas. Snapshot é salvaguarda: **não aplicar patches por cima do mesmo WIP**. Compare hashes/HEAD antes. Todos os HEADs e patches estavam estáveis durante a captura. Revalidar estado, pois outra sessão pode continuar depois deste handoff.

## 8. Ordem recomendada para terminar — não abrir novas frentes

1. Conferir árvores/snapshots e trabalhos em execução. Preservar os WIPs.
2. F-907 já está no commit995c27284, com59 testes e typecheck0. Fazer revisão e prova Devin privada+nativa; não reaplicar o antigo snapshot desse diff.
3. Fechar Muse e incorporar módulo+profile+manager com o await Root; revisar a nova lease independentemente.
4. Fechar AGY plugin, prova real com file channel e integrar readiness. Preservar o comportamento de aprovação/rede.
5. Integrar tudo, atualizar QA/matriz de104 requisitos/release notes e congelar SHA limpo.
6. Sincronizar a árvore privada sem perder as cópias de teste (comparar/salvar antes de substituir); não usar git clean/reset.
7. Rodar gates finais da fonte. Os scripts `PLAN/run-final-private-gates.py <SHA>` e `PLAN/run-final-f764-gates.py <SHA>` leem private-verification-location.json e exigem Root/privado no SHA limpo. Suíte histórica levou~16 min com1 worker; não tratar a histórica como final.
8. Revalidar remoto/versão. Tag anotada v192 deve apontar **exatamente** para o SHA final validado. O builder pode aceitar tag ancestral e construir código antigo: conferir explicitamente.
9. Build assinado/notarizado em árvore privada com deps próprias. Ler `scripts/make-release.mjs`, `scripts/release-mac-detached.mjs` e runbook; usar `release:mac --no-publish` para não publicar antes dos testes adicionais. O wrapper faz rebuild:node no fim: **não rodá-lo sobre node_modules compartilhado**.
10. Executar candidate + hang40s com fuse inspect desligado, faixa ocupado, duas fases runtime (missão/worker/handoff/ACK/recovery/mover/pergunta/memória/resume), voz/TCC, N7 com inspeção da PNG, recursos300s, Keychain/update e quit sem órfãos. Scripts já existem: smoke-packaged-app, smoke-packaged-runtime-gates e smoke-packaged-soak. Ler argumentos; não inventar recibos nem substituir execução por testes unitários.
11. Publicar pelo script canônico (integra main/tag atomicamente), verificar canônica `Hiper-nexus/nexus-ide`, espelho `Hiper-nexus/nexus-ide-releases`, assets/hashes/recibos/feed/download. Só então auditar cada requisito e concluir a meta.

**Não marcar tudo concluído, não publicar subconjunto e não pedir novamente autorização geral que o operador já deu. Não fingir provas de Windows/Linux a partir de fixtures macOS.**


---

# Inventário completo incorporado ao handoff

# Lista completa dos pedidos, melhorias e pendências

Este arquivo integra o handoff a pedido explícito do operador: **nada solicitado deve desaparecer por ter sido resumido**. Estado de encerramento desta sessão em04/10/2026. A release0.76.192 ainda NÃO foi publicada.

**Legenda:** “fonte integrada” significa implementação na branch, com evidência indicada na matriz; não significa teste no aplicativo assinado. “Pendente” exige ação/prova. “Histórico” preserva o pedido original, mas os estados antigos não prevalecem sobre as atualizações deste arquivo e do HANDOFF. Não somar testes sobrepostos.

O código concluído F907 foi commitado em `995c27284498ea5d4137ccc81b7c937c338f84d9`:59 testes/4 suítes e typecheck privado passaram. A prova Devin real após essa correção continua pendente. WIPs Muse/AGY/startup não foram misturados nesse commit.

## 1. Todos os oito pedidos originais, com os subpedidos do pedido2

As descrições abaixo foram extraídas da auditoria original que leu o transcript. São22 linhas de rastreio, abrangendo os oito pedidos e2a–2o.

| ID | Pedido original | Estado nesta transferência | Entrega / o que falta |
|---|---|---|---|
| 1 | 10:46 "atualiza nosso repositório local com github" | Integrado | GitHub atualizado e main d24073cb9 preservado. Dependências privadas Electron43.7.4 prontas; conferir remoto de novo antes de publicar. |
| 2a | 10:56 análise refinada de toda a orquestração | Análise entregue; correções integradas | Orquestração, contratos, adoção e supervisão corrigidos. Validar fluxos no app final. |
| 2b | onde a memória realmente salva | Análise entregue | Mapa completo dos depósitos na análise01 copiada neste pacote. |
| 2c | memória de longa duração entre todas as LLMs | Fonte integrada; campo pendente | Retain/recall, camadas, retry e F798–801 implementados. Provar persistência e leitura entre CLIs no candidato. |
| 2d | estudar ai-memory (Akita)/graphify/Obsidian e trazer a tecnologia de grafos | Pesquisa e integração de relações entregues | Pesquisa08 completa; wikilinks/FTS/backlinks/raio de impacto. Não foi criado motor novo de grafos/vetores nem benchmark fictício. |
| 2e | saber a hora de usar grafo | Doutrina e recall de impacto integrados | FTS para fatos textuais; relações/arquivos para impacto. Validar o fluxo real de uso. |
| 2f | mapear o modelo de negócio para não quebrar features | Fonte integrada | Bloco de modelo de negócio e escritores de regras/preferências. Provar ingestão/recall e preservação de features no app. |
| 2g | libs/tecnologias mais novas e linguagem certa por alvo (Ruby, Go, Rust, C++…) | Fonte e documentação integradas | Stack-advisor, decisões via draft e sensor de frescor N8/N9. Não significa atualizar dependências automaticamente. |
| 2h | Nexus autônomo decide melhor e erra menos | Fonte integrada; qualificação final pendente | Diversidade/capacidade/skill, resultados por CLI/modelo, recuperação, entrega e críticos. Ainda há Muse/AGY/Devin e gates finais. |
| 2i | Jev e Clef usados de verdade | Fonte integrada; uso real final pendente | Jev/Clef, feedback ACK, superfícies e toggles. Não fabricar métricas de utilização. |
| 2j | navegador interno usado como deveria | Fonte integrada; candidato pendente | Browser-first e ferramentas de leitura/captura para workers. N7 exige evidência visual real. |
| 2k | skills, tools e agentes do Nexus sendo usados | Parcial/precisa conferir uso | Roteamento por skills e journal implementados. Uso efetivo do catálogo inteiro e squads antigos não são provados por essa implementação. |
| 2l | plano de melhoria robusta | Entregue | PLAN consolidado e este inventário completo, além das oito análises anexas. |
| 2m | soltar os panes e analisar como estão saindo | Executado historicamente | Análises e writers em várias CLIs geraram achados. Não é necessário retomar a missão antiga para reaproveitar as entregas. |
| 2n | corrigir os erros já nesta missão | Correções integradas + pendências explícitas | F7xx e follow-ups integrados; F904/F905/F906 em WIP e F907 ainda exige repetição do Devin real. |
| 2o | lançar uma melhoria robusta e versão | PENDENTE | Sem app assinado/notarizado, sem publicação. Todos os gates finais continuam obrigatórios. |
| 3 | 11:01 print do Codex 400 (`gpt-6.1-sol` não suportado) | Fonte e controle Codex implementados | Escolha da instalação mais nova, proveniência de cache e recuperação. Codex real4/4; candidato ainda pendente. |
| 4 | 11:02 saber qual modelo/quando/qual esforço; usar todas as LLMs, desde o Qwen | Fonte integrada + limites explícitos | Roteamento/esforço/diversidade/resultados. N1/D1/D2 não significam suporte ou benchmark inventado; conferir todas as CLIs no escopo prometido. |
| 5 | 11:04 "cadê muse, qwen, grok, devin, agy"; multiconta troca inteligente no meio da tarefa | Fonte integrada; campo real pendente | Continuity pack e troca de CLI quando contas esgotam. Falta cenário real com duas contas, sem comprometer logins. |
| 6 | 11:08 "por que não estava usando esses LLM? limitação do Nexus?" | Correções de produto integradas | CLI escolhida, boot/versão/modelo/flags e readiness. Credenciais/disabled históricos precisam revalidação, não suposições. |
| 7 | 11:13 "a animação visual não mostra o orquestrador e todos" + print | Fonte integrada; visual final pendente | Orquestrador/helpers/ACK no grafo corrigidos. Conferir app e densidade de20helpers; polimento de cabos não tem fechamento comprovado. |
| 8 | 11:20 "refazer mesmo sem pedir; usar tudo de forma inteligente; o multi-score favorece os mesmos CLIs" | Fonte integrada; validação final pendente | Fair-share, multiscore, lane de juízes e acesso provado. Segurança crítica mantém política própria; não inventar acesso a modelos. |

## 2. Memória — os12 passos da análise01

Os gatilhos, APIs, retenção e projeção foram integrados por F768/F769/F798–801 e follow-ups. Ainda falta provar a experiência no candidato e executar qualquer importação de dados reais pela autoridade apropriada. Não confundir rotina implementada com “todos os dados históricos já migrados”.

| Passo | Pedido completo | Estado / aceite que deve ser preservado |
|---|---|---|
| 1 | **Telemetria de descarte (faixa A).** Registrar o `reason` de cada tentativa (flag-off, unverified, jev-skip, sem rota, timeout) em contador exposto por `stats()` e em `recordJevDecision` com `decision: 'skip:<motivo>'`. Teste: `distillHandoffSummary` sem credencial deve gravar uma decisão `skip:no-route`; hoje não grava nada (jev-memory-distill.ts:160). | Fonte integrada; verificar comportamento no gate final de memória. |
| 2 | **Tools de memória sempre permitidas (faixa B).** Incluir `memory_recall`, `memory_stats`, `memory_retain` em `ALWAYS_ALLOWED` (gate.ts:116) e `memory_retain` no conjunto liberado para contexto read-only (mcp-effect-policy.ts:193). Teste: `isToolAllowed([], 'nexus_memory_retain')` deve ser `true`; hoje é `false`. | Fonte integrada; verificar comportamento no gate final de memória. |
| 3 | **Handoff de helper sem missão vira memória (faixa C).** No commit de um handoff `success` sem `taskDispatch` e sem missão, chamar a mesma destilação do F-703. Teste em handoff-store: submit de sucesso sem missão, com judge fake aprovando, deve criar 1 linha `trusted:accepted-handoff` com `Summary:`; hoje cria 0. | Fonte integrada; verificar comportamento no gate final de memória. |
| 4 | **Entrega ao Maestro não depende do ACK (faixa C).** Disparar a retenção quando o handoff de missão é marcado entregue, mantendo o dedupe por conteúdo já existente (trusted-memory.ts:397-400). Teste: handoff de missão entregue e nunca confirmado gera memória; hoje só em `outcome === 'created'` do ACK (handoff-store.ts:1920). | Fonte integrada; verificar comportamento no gate final de memória. |
| 5 | **Digest de sessão aceita resumo aprovado pelo Jev (faixa A).** Trocar o corte duro de session-exit-memory.ts:115-119 pela mesma barreira do F-703 (texto do agente só entra destilado). Teste: sessão com handoff `unverified` e judge aprovando deve devolver `reason: 'ok'`; hoje devolve `'unverified'`. | Fonte integrada; verificar comportamento no gate final de memória. |
| 6 | **Não gravar recibo sem conteúdo (faixa A).** Remover a linha-base só de identificadores (trusted-memory.ts:334) e esquecer as 6 existentes. Teste: aceite cujo resumo o Jev descarta não cria linha; hoje cria. | Não criar recibos vazios; não afirmar remoção efetiva dos6 registros históricos sem conferir o banco real. |
| 7 | **Injeção em duas camadas (faixa D).** Manter `trusted` como hoje e acrescentar uma seção "notas de agentes, não verificadas" com teto menor para `agent-authored:*` e notas do operador. Teste: `workspaceMemoryContextBlock` com uma linha `agent-authored` relevante deve trazê-la marcada como não verificada; hoje devolve `null` (workspace-memory-context.ts:186). | Fonte integrada; verificar comportamento no gate final de memória. |
| 8 | **Contador honesto (faixa A/D).** Somar `recall_count` só do que foi efetivamente injetado. Teste: recibo filtrado pelo formatador mantém `recall_count` inalterado; hoje sobe. | Fonte integrada; verificar comportamento no gate final de memória. |
| 9 | **Doutrina no brief (faixa E).** Duas linhas no contrato de handoff: consultar `nexus_memory_recall` antes de mexer em área desconhecida e gravar pegadinhas com `nexus_memory_retain` antes do handoff. Teste: o brief montado contém as duas instruções. | Fonte integrada; verificar comportamento no gate final de memória. |
| 10 | **Retry em vez de perda (faixa A).** Quando o Jev está fora ou dá timeout, enfileirar o resumo e redestilar no próximo boot. Teste: judge devolvendo `null` deixa 1 item pendente; hoje o resumo some. | Fonte integrada; verificar comportamento no gate final de memória. |
| 11 | **Backfill único.** Passar pela destilação os 26 handoffs de sucesso com resumo que ainda estão nos runtimes, os 8 arquivos da auto-memória do Claude e os 24 de `~/.claude/projects/-Users-cleofaspereirarocha-nexus-ide/memory`. Teste: script idempotente, segunda execução grava 0 (dedupe por `content_hash`, índice `idx_memories_hash_active`). | Backfill e importação explícita implementados. Execução sobre todos os arquivos/históricos reais NÃO foi comprovada; preservar proveniência e não copiar logins. |
| 12 | **Alarme visível.** Tela Memória mostra "última memória há N dias" e fica em alerta acima de 3 dias com handoffs no período. Teste de componente com banco parado. | Alarme implementado; conferir visualmente no candidato. |

Complementos do desenho também fazem parte do escopo: escritores de `resolved-problem`, `architecture-rule`, `operator-decision` e `operator-preference`; preferências globais com autoridade; dedupe por conteúdo/assunto e supersede; TTL somente para digests nunca injetados; fatos de arquivo a reverificar; regras/decisões/preferências não expiram; injeção por brief/hook/MCP; vault markdown com índice e wikilinks; integração lexical+relações+blast radius. A análise01 integral está em `fontes/analises/01-memoria.md`, e a pesquisa comparativa em `fontes/analises/08-pesquisa-memoria.md`.

## 3. Melhorias N1–N14, item por item

| ID | Melhoria pedida | Estado atual / o que ainda falta |
|---|---|---|
| N1 | Usar múltiplas CLIs também onde a lane governada limitava tudo ao Codex | Resolução de segurança documentada em F834: worktree não equivale a sandbox. Autopilot mantém liberdade; não foi implementado suporte Hardened universal novo. Não dizer que essa capacidade existe sem prova nativa. Preservar a orientação posterior do operador de rede/execução livres no padrão. |
| N2 | Comparar proveniência do cache de modelos com a versão do binário realmente executado | Implementado e testado em descoberta/cache/invalidação. Falta smoke final de versão/cache no app. |
| N3 | Chave inválida não aparecer como provider pronto nem entrar na rota | Readiness assíncrona com cache,401/redirect/host/rota implementados. Erro de rede permanece unknown. Revalidar estado real das credenciais; não gerar/alterar segredo do operador. |
| N4 | Auto-close não destruir o corpo de relatório quando só foi entregue resumo | F833 corrigido, inclusive fullText igual ao summary: preserva cauda Main saneada com procedência/aviso ou mantém pane. Revisão independente32568689. Campo final ainda pendente; cauda não é chamada de relatório completo. |
| N5 | Default Claude alinhado à linha mais nova suportada | Catálogo/descoberta/promoção/quarentena/recovery integrados. Não inventar versão mínima ou disponibilidade; validar versão final executada. |
| N6 | Git de failover assíncrono e com argv/config seguros | F822 integrado; sem consultas Sync no planejador. Falta teste de campo de failover e gates finais. |
| N7 | Tarefa visual exigir captura/DOM/browser vinculados à atribuição atual | Gate Main com UUID/sessão/incarnation/arquivo/hash implementado. Ainda faltam captura real no candidato e inspeção humana/LLM da imagem; existir PNG não prova qualidade. |
| N8 | Registrar a decisão de stack em .context/docs/stack-decision.md | Brief v3 e skill apontam o draft canônico e preservam v1/v2. Revisão/aplicação continuam pelos fluxos próprios, sem escrita direta não autorizada. |
| N9 | Sensor de dependências antigas/deprecated, limitado e não bloqueante | Sensor advisory de metadados públicos, budgets e comportamento offline implementados. Não faz update automático nem lê tokens/npmrc. Validar gate final. |
| N10 | Registrar origem real da entrada que abre um turno, inclusive “siga” | Recibos Main human/system/unknown e writer finito implementados. Não grava prompt/argv/token. Falta fluxo real no candidato. |
| N11 | Histórico de ciclo de vida por14dias, não só rotação por tamanho | Rotação diária, filas limitadas, contadores e flush/quit implementados. Falta prova final de saída; não alegar14dias já vividos. |
| N12 | Resume de missão sem exigir adapterId, preservando CLI/conta/conversa/cwd | Captura Main e fences após await implementados. Sem sessão/perfil exato não há fallback silencioso para conversa nova. Falta campo final. |
| N13 | Evitar indexação das novas worktrees/candidatos pelo Spotlight | Autorizado e implementado `.noindex` somente em novos caminhos, preservando layout legado. Não atribuir o travamento ao Spotlight sem medição. |
| N14 | Refazer e preservar a pesquisa ai-memory/Akita/Graphify/Obsidian e quando usar cada abordagem | Pesquisa08 integral e doutrina de recuperação entregues. Não existe novo motor vetorial/grafo ou benchmark medido inventado. As decisões D1/D2 continuam transparentes abaixo. |

## 4. Todas as frentes das análises02–07

| Fonte/ID | Pedido ou lacuna | Disposição atual |
|---|---|---|
| 02/G1 | Modelo validado contra instalação errada/cache mais novo | F790 e N2 integrados; smoke final pendente. |
| 02/G2 | Diversidade desligada em bug/security/visual | F770 e correções de política integrados; segurança crítica preserva regra explícita. |
| 02/G3 | Eixo de capacidade antes do ranking | F771 integrado. `maxContext` sem população/filtro efetivos era lacuna menor; não há fechamento comprovado nesta transferência. |
| 02/G4 | Aprender sucesso por CLI/modelo | F773 e ACK/resultados integrados, amostra mínima e janela explícitas; não inventar taxa por especialidade. |
| 02/G5 | Catálogo e linhas obsoletas/API-only | F774 e guards integrados; dados/versões reais precisam coerência final. |
| 02/G6 | Route log persistente | Ledger/migração/retenção integrados; conferir restart no candidato. |
| 02/G7 | Skill por papel/CLI; auditoria não virar bug por palavra solta | F772 e correções de classificação integrados. |
| 02/G8 | Escolha de esforço | A análise não exigiu mudança extra; conservar política/linha atual, sem afirmar benchmark próprio. |
| 02/G9 | Lane de juízes com outros laboratórios | F779/F817 e prova de acesso integrados; Argon sem acesso provado não vira juiz. |
| 03/1 | Pack de continuidade com motivo, janela, arquivos/diff, próximo passo, teto e anti-loop | F775 integrado em Main/renderer. |
| 03/2 | Trocar de CLI quando todas as contas da atual esgotam | F775 item2 integrado, com respawn real antes de switched. Campo de duas contas e transição real ainda pendente. |
| 03/3 | Preservar contexto sem transplantar transcript | Estratégia de pack mantida; identidade/conta/conversa não podem ser inventadas. |
| 03/4 | Git do pack fora do Main síncrono | F822/N6 integrado. |
| 04/A | Preços Argon/Qwen, aliases Kimi, Composer legado | Ajustes de catálogo/pricing integrados; estimativas continuam rotuladas. Divergência histórica de preço gpt-5.6-sol precisa conferência antes de afirmar fechamento. |
| 04/B | Modelos/default/deprecated | F774/N5 integrados; sem downgrade por cache incompatível. |
| 04/C | Trivial em modelo barato/rápido e aliases OpenCode reais | Rotas integradas conforme catálogo/descoberta; IDs legados oferecidos pela CLI não são removidos por palpite. |
| 04/D e D2 | Ranking medido em vez de fixture | Ranking continua explicitamente fixture; NÃO foi executado benchmark novo. Não chamar fixture de resultado real. |
| 04/D1 | Matriz modelo/esforço por especialidade | Overlay heurístico vazio por ausência de benchmark Nexus. Decisão/dado a conferir, não capacidade implementada por tabela inventada. |
| 04/esforço AGY | Não enviar --effort incompatível com modelo sem sufixo | F791 integrado. |
| 05/1 | Stack-advisor empacotado | Integrado. |
| 05/2 | Carta de engenharia: consultar registro, recusar deprecated, pin | Integrada. |
| 05/3 | Decisão de stack como draft canônico | N8 integrado. |
| 05/4 | Sensor de frescor/deprecated e offline não bloqueante | N9 integrado. |
| 06/L1–L6 | Telemetria/uso de ferramentas, navegador, feedback Jev, Clef, paralelismo e toggles | Frentes F780–784/F796/F797 integradas; tabela original completa preservada no anexo histórico e análise06. Utilização efetiva de todas as ferramentas não foi demonstrada. |
| 07/P1 | switched só após respawn, alternativa elegível e quarentena por conta/instalação | F765 e integração de failover implementados; campo pendente. |
| 07/P1 | Handoff mecânico não declarar sucesso sem revisão/evidência | F786/F823/N7 integrados; visual real ainda pendente. |
| 07/P2 | Proveniência catálogo/binário, sync fast-forward, entrega ops e telemetria | N2/F778/F785/F787/N10/N11 integrados. |
| 07/B0–B5 | Hang, flag AGY, morte no boot, helper/ACK fora do grafo, writer sem commit, spool de handoff | F764/F791–795 integrados; C6 nativo e prova assinada ainda abertos. |
| 07/experimento | Comparação controlada Nexus×CLI direto com mesma tarefa/modelo/credenciais | Não há experimento completo comprovado. Controles individuais de CLI não substituem comparação geral. |

As tabelas detalhadas originais (incluindo cada L1–L6 e subitem) estão integralmente copiadas em `fontes/AUDITORIA-PEDIDOS-ORIGINAL.md`; os estados daquele snapshot são históricos, não atuais.

## 5. Achados da revisão adversarial original — todos20

Todos têm remediação de fonte indicada na matriz posterior. Isso NÃO aprova automaticamente o diff final: a suíte/revisão/candidato finais permanecem obrigatórios.

| ID | Defeito a tratar | Estado nesta transferência |
|---|---|---|
| C1 | F-785: a missão criada pela mão do operador nasce com `maxWorkers: 0` e o helper da aba é recusado | Correção/rastreio integrados conforme matriz; revalidar união final. |
| A1 | A integração quebra 12 testes existentes (a base passa) | Correção/rastreio integrados conforme matriz; revalidar união final. |
| A2 | F-778: o hook passa a bloquear `git merge --abort/--continue`, `git merge-base`, `merge-tree` e `merge-file` em checkout no `main`, inclusive no meio de um conflito | Correção/rastreio integrados conforme matriz; revalidar união final. |
| A3 | F-769: o vault `.nexus-memory/` é escrito no checkout do operador a cada retain ou forget, inclusive a partir de pane read-only e de missão consult | Correção/rastreio integrados conforme matriz; revalidar união final. |
| A4 | F-769: exportação síncrona O(N) no Main a cada retain ou forget, com raiz que troca em leituras | Correção/rastreio integrados conforme matriz; revalidar união final. |
| A5 | F-785: o classificador "só sincronização" é largo e transforma tarefas de escrita em `ops` | Correção/rastreio integrados conforme matriz; revalidar união final. |
| M1 | F-769: a "camada não verificada" cria um canal persistente de prompt injection entre agentes | Correção/rastreio integrados conforme matriz; revalidar união final. |
| M2 | F-766: a distância de 1 edição faz palavras comuns "provarem" que o operador nomeou uma CLI | Correção/rastreio integrados conforme matriz; revalidar união final. |
| M3 | F-771: `WEB_SEARCH_NEED` dispara em texto comum de código | Correção/rastreio integrados conforme matriz; revalidar união final. |
| M4 | F-775: o planejador "puro" do failover roda 3 processos git síncronos no Main, com git cru | Correção/rastreio integrados conforme matriz; revalidar união final. |
| M5 | F-776: o brief canônico mudou sem trocar o marcador, e briefs gravados pela 0.76.190 deixam de valer | Correção/rastreio integrados conforme matriz; revalidar união final. |
| M6 | F-779: a lane de julgamento prioriza modelos de acesso incerto | Correção/rastreio integrados conforme matriz; revalidar união final. |
| M7 | F-786: a regex de admissão rebaixa entrega boa e cria assimetria com o MCP | Correção/rastreio integrados conforme matriz; revalidar união final. |
| B1 | Sonda de versão Codex síncrona no spawn | Correção/rastreio integrados conforme matriz; revalidar união final. |
| B2 | Git síncrono no portão de integração | Correção/rastreio integrados conforme matriz; revalidar união final. |
| B3 | Variante paga OpenCode DeepSeek com preço zero | Correção/rastreio integrados conforme matriz; revalidar união final. |
| B4 | Classificação de falha em tarefa de inventário | Correção/rastreio integrados conforme matriz; revalidar união final. |
| B5 | Segurança crítica entrando em rotação/fair-share | Correção/rastreio integrados conforme matriz; revalidar união final. |
| B6 | Testes que não demonstravam o comportamento alegado | Correção/rastreio integrados conforme matriz; revalidar união final. |
| B7 | Uma causa por QA item; rastreabilidade de achados | Correção/rastreio integrados conforme matriz; revalidar união final. |

N4/F833 foi reaberto depois da auditoria congelada e corrigido novamente com revisão independente32568689. F802/F815 receberam seus registros QA posteriores. Não ressuscitar o estado antigo “arquivo QA ausente” como pendência atual, nem transformar o antigo REJECT em aprovação do pacote final.

## 6. F-764 completo — cada obrigação e critério

| ID | Obrigação | Estado / próxima prova |
|---|---|---|
| A.1 | Capturar função/arquivo/linha JS por inspector.Session.connectToMainThread e cpuprofile | Implementado. Falta probe40s no app assinado com fuse inspect desligado. |
| A.2 | Histórico append de múltiplos hangs, eventos recentes, bytes/s e intervals ativos | Implementado e testado em fonte. Falta episódio real no candidato. |
| A.3 | p50/p99/max e custo por tap/chunk, com nomes | Implementado. Carga atual passou; conferir observabilidade no pacote. |
| B.1 |15 PTYs falsos, um≥5MB/s, supervisor e spawn concorrentes, profile | Carga30s saudável passou5,613MB/s após F902/F903, com paridade. Repetir SHA final. |
| B.2 | Confirmar e corrigir causa real | Regex cúbica em TUI branca documentada; custos adicionais de contador/normalização corrigidos. Não atribuir a causa a Spotlight. |
| C.1 | Lotes por sessão e análise pesada fora do Main | Implementado em Worker, preservando efeitos/ordem/fences. Carga normal e poison passaram. |
| C.2 | Backpressure/fairness/memória limitada, sem perder EOF/dados | Implementado; hashes, bytes e barreiras passaram; degradação explícita no poison. Equivalência nativa ainda pendente. |
| C.3 | Janelas fixas e regexes adversariais limitadas | Inventário de205 regexes/21 manifests/1565 casos/105 paridades passou; repetir auditoria final. Não é garantia sobre toda regex do repo. |
| C.4 | Tarefas periódicas com orçamento, yield, não reentrância e parada aguardada | Implementado com scanners/telemetria fora do Main. Prova de recursos/quit final pendente. |
| C.5 | Worktree/check-ignore/failover Git async e lint contra novos processos Sync | Implementado. Ratchet91 usos legados; não significa zero chamadas legadas. |
| C.6/MCP | Semáforo de comandos por projeto e RAM, cancelamento físico | Fonte/testes implementados; F907 corrige serviços persistentes. Campo Devin pósfix e candidato pendentes. |
| C.6/CLIs | Comandos reais das CLIs também na fila, com posse e nested borrow | Várias CLIs qualificadas; Muse/AGY em WIP e Devin nativo requer rerun. Não ignorar essa parte porque MCP tools passaram. |
| C.6/workers | Teto de workers considerando RAM/swap e reservas pendentes | Implementado; operação real de recursos ainda precisa gate. |
| C.7 | Faixa Nexus ocupado após10s, sem auto-kill | Implementado/harness revisado. Executar com renderer montado e Main bloqueado40s no app assinado. |
| Aceite/latência | p99<100ms e máximo<1s | Fonte30s passou11,969ms/219,231ms; validar conjunto final. |
| Aceite/spawn | Criar worker não bloquear Main>100ms | Fonte passou33,996ms; não confundir com duração total do spawn. |
| Aceite/falha | Worker poison encerra fisicamente, substituto conclui sem fallback pesado | Passou30s; preservar prova e repetir final quando necessário. |

## 7. Pendências adicionais que NÃO podem desaparecer do handoff

- **Publicação:** suíte final, revisão composta, build/notary, DMG/ZIP, smokes, 5min de recursos, voz/Keychain/update, hashes e canônica/espelho continuam pendentes.
- **Teste de campo multiconta:** duas contas reais e continuidade no meio de tarefa não estão provados pelos testes de unidade. Não invalidar logins para simular sucesso.
- **Uso de ferramentas/squads:** a auditoria registrou muitas tools nunca chamadas e squads com modelos antigos; não há fechamento geral comprovado. A próxima LLM deve conferir o requisito, não supor que telemetria equivale a uso.
- **Grafo visual denso:** cabos atrás dos cards com muitos helpers foram citados como polimento; a implementação/validação desse polimento não foi demonstrada.
- **Capacidade maxContext:** declaração sem população/filtro efetivos foi apontada; não há prova de fechamento aqui.
- **Preços/ranking:** a divergência histórica gpt-5.6-sol, D1 e D2 precisam disposição explícita. Não fabricar benchmark/preço atual.
- **Credenciais e providers:** estados históricos Qwen401, providers desabilitados e login-needed NÃO devem ser tratados como fatos atuais sem nova consulta. A autenticação AGY/Devin foi comprovada disponível nesta sessão.
- **Autorias antigas:** não foi possível atribuir retroativamente todo “siga”; N10 corrige a observabilidade futura, não reescreve a história.
- **Plataformas:** Windows/Linux/OCI reais têm limites de prova próprios. A entrega de publicação em curso é macOS; não inferir PASS dessas plataformas.
- **Grafo/embedding:** a solução adotada usa relações existentes/FTS/wikilinks/raio de impacto; Graphify opcional, sem engine vetorial/grafo novo. Isso deve ficar explícito ao avaliar o pedido original.

## 8. Critérios finais da release

O checklist integral está em `fontes/RELEASE-CHECKLIST.md`. A matriz histórica copiada contém cada caixa PB1–PB6, BP1–BP5, SA1–SA7, SC1–SC5, MP1–MP5, PR1–PR3, RC1–RC4, LI1–LI2 e RR1–RR2, mais revisão/SBOM/publicação. **Nenhuma dessas caixas é encerrada por existir um script ou mock.**

Para continuar: use a ordem operacional do HANDOFF, preserve todos os itens desta lista e faça a auditoria final por requisito. Estados de fonte e testes focados não autorizam afirmar “tudo pronto”.

## 9. Fontes integrais incluídas no pacote

- `fontes/AUDITORIA-PEDIDOS-ORIGINAL.md`: todos os pedidos/subpedidos, G1–G9, L1–L6, N1–N14, decisões e promessas antigas.
- `fontes/MATRIZ-COBERTURA-104-HISTORICA.md`: matriz detalhada de fonte/evidência e suas atualizações, com SHA/data explícitos.
- `fontes/REVISAO-ORIGINAL.md`: revisão adversarial original completa.
- `fontes/F764-HANDOFF-ORIGINAL.md`: hipóteses, causa, pedidos A/B/C e critérios de aceite.
- `fontes/HANDOFF-INTEGRACAO-ORIGINAL.md`: entregas e branches originais.
- `fontes/PLANO-RELEASE.md` e `fontes/RELEASE-CHECKLIST.md`.
- `fontes/analises/01-memoria.md` até `08-pesquisa-memoria.md`: conteúdo completo das análises e pesquisa.

Os textos em fontes são snapshots para preservar escopo, não instrução para repetir comandos históricos já superados. Em especial: v191 não será reescrita, versão atual preparada é192, usar dependências privadas e respeitar as autorizações posteriores do operador.
