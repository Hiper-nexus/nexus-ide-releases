# Golden path de orquestração — fechamento sênior

Data: 2026-07-23

## Veredito

O motor passou do contrato consultivo para autoridade mecânica no processo
principal: o LLM propõe; o Nexus sela plano e roster, persiste a rota, cria o
worker físico, observa o ciclo de vida, entrega/aceita o handoff e só conclui
com receipt verificável. A versão não deve mudar enquanto o E2E real do app
empacotado não provar essa cadeia inteira.

## Ondas cobertas no código

| Frente dos documentos | Mecanismo Nexus | Estado antes da release |
|---|---|---|
| Onda 0 — router/golden path | diversidade por tier, boundary de sinais, squad salvo, `RouteReservation`, kickoff idle→busy e handoff com aceite | código + testes focados; E2E empacotado ainda obrigatório |
| Onda 1 — motor sênior | coordinator/reconciler único, status semântico por hook, heartbeat/exit físico e recuperação main-owned | código + testes; revisão adversarial em fechamento |
| Onda 2 — produto cotidiano | plano revisável, launcher mission-first, squads/packs, atividade real e pipeline Impeccable | código + testes; sem alegar redesign total |
| Onda 3 — superar sem copiar | clarify com chips, feedback annotate→handoff, voz com ACK e SSH com host verification | código + testes; integrações externas continuam condicionais |
| Onda 4/5 — plataforma | autoridade fora do renderer, OMP RPC, hibernação, PWA com pareamento, LSP, quota/uso e release manual fail-closed | código + testes; matriz Win/Linux e serviços externos não são certificáveis neste Mac |

## Invariantes impostos

- `route_task` persiste uma reserva durável; spawn de missão running sem reserva
  válida ou membro sticky do roster é negado.
- Roster, plano, ownership, worktree, incarnation e sessão física são selados
  pelo main. Troca/crash do renderer não transfere autoridade entre projetos.
- Kickoff e handoff exigem idle semanticamente injetável e prova observável;
  falha vira bloqueio/CTA, nunca silêncio ou `done` por texto longo.
- Worker termina somente após handoff aceito e receipt de integração/validação.
  Nota de 40 caracteres sem worker/handoff não satisfaz orquestração.
- Encerramento revoga o bearer MCP imediatamente, mesmo se o processo físico
  resistir; exclusividade física permanece até prova conjunta do root e de
  todos os descendentes capturados por PID + start + PGID.
- Falha/interrupção do merge, inclusive após restart, converge por CAS para
  dispatch bloqueado, task failed e missão blocked com um CTA; receipt de
  integração já aceito nunca é apagado por essa projeção.
- O autopilot da 0.19.26 permanece: ação coberta pela missão não abre modal por
  comando; destrutivos continuam exigindo confirmação.

## Varredura Orca e Overclock

Foi feito inventário mecânico do checkout Orca fresco em
`0b344425ebf0fab8128bb2b3cb1783849eb16bc9` (9.175 arquivos TS/JS, cerca de
1,07 milhão de linhas e 3.693 testes) e leitura manual profunda dos caminhos de
orquestração, sessão/PTTY, authority, worktree, hooks, recovery e release. Não é
honesto chamar isso de leitura humana linha a linha do milhão de linhas.

Um segundo passe incremental foi feito em 2026-07-26 contra o `HEAD`
`627cde33d58910b6422b63aacb88d035a3ba0582` indicado pelo repositório público
`stablyai/orca`: 10.088 arquivos totais, 9.784 fontes TS/JS (920.383 linhas) e
3.933 arquivos de teste. Entre os dois pins, o upstream mudou 1.128 arquivos.
O novo motor `src/main/runtime/orchestration/` confirma a decisão arquitetural
central do Nexus: coordenação é serviço do host, não uma capacidade presumida
do modelo. O coordinator grava DAG/dispatch no SQLite e envia o mesmo preâmbulo
estruturado a terminais genéricos; a própria decomposição por IA ainda está
marcada no upstream como fase futura.

Um terceiro passe, imediatamente antes da release, resolveu o remoto em
`8f5a45401fc65b4052797b43d251d44c9c691769`. O delta desde `627cde` foi de 167
arquivos (+8.112/-1.151), sem alteração no núcleo de orchestration. O inventário
atual deixa a assimetria explícita: 34 CLIs são launcháveis, 14 têm hooks
gerenciados, 11 são resumíveis e 9 têm alias de grupo. A capability honesta não
é binária; ela progride por `launchable → promptInjectable → statusObservable →
resumable → governedWriter → verifiedMaestro`. Kimi recebe prompt e status sob
o host Orca, mas não tem resume nem prova de Maestro equivalente.

Isso também fecha a dúvida de compatibilidade: o Orca anuncia e hospeda qualquer
CLI de terminal, inclusive Claude, Codex, OpenCode, OMP e Kimi, mas não prova que
cada uma seja um Maestro nativo equivalente. Elas podem ser workers porque o
host faz o dispatch. No Nexus, Claude e Codex permanecem os únicos Maestros com
rota automaticamente verificada nesta release; Kimi e demais CLIs continuam
manuais até passarem o mesmo gate mecânico. Escrita autônoma guiada permanece
mais estreita ainda: somente o Codex builtin confinado.

Um quarto passe incremental em 2026-07-26 resolveu o remoto em
`ab1c37889a4361dbade2b22458bd051ba669a9aa`. As três mudanças desde `8f5a454`
tocam 40 arquivos (+1.632/-380): mobile, breadcrumbs de crash/terminal e
limites coerentes para o long-poll `orchestration ask` no CLI, RPC e relay.
Esse último ajuste é operacionalmente correto — timeout solicitado, timeout
efetivo do host e grace do transporte precisam compartilhar o mesmo teto — mas
não transforma um CLI genérico em Maestro e não altera o inventário abaixo.
O Nexus já impõe limites nas entradas MCP, terminal, spawn, recovery e
reconciler; portanto não houve motivo para copiar a implementação.

Um quinto passe incremental em 2026-07-26 resolveu o remoto em
`4ada3f8b2cf9ebbc37fbe2839b07f81dbed2557e` (`v1.4.159-rc.0`). O comando
`git diff --shortstat ab1c37889a4361dbade2b22458bd051ba669a9aa..4ada3f8b2cf9ebbc37fbe2839b07f81dbed2557e`
mede 113 arquivos alterados (+4.309/-1.820). O mesmo diff não mostra alteração
em `docs/STYLEGUIDE.md`, `src/main/runtime/orchestration/`,
`src/shared/tui-agent-config.ts`, `src/shared/agent-session-resume.ts` ou
`src/main/agent-hooks/managed-agent-hook-controls.ts`. No recorte visual e de
terminal usado neste benchmark, são nove arquivos (+331/-174): oito do filtro
da sidebar e `terminal-visibility-resume.ts`; neste último, o delta executável é
zero e somente dois comentários antigos foram removidos. Portanto o novo pin
não muda a matriz de capability nem os princípios visuais registrados abaixo.

| Capability no pin `4ada3f8` | Claude | Codex | Kimi | OMP |
|---|---:|---:|---:|---:|
| Launch + prompt injection | sim | sim | sim | sim |
| Status observável | sim | sim | sim | sim |
| Hook genérico gerenciado | sim | sim | sim | não; extensão própria |
| Resume exato | sim | sim | não | sim |
| Alias de grupo nomeado | sim | sim | não | não |
| Time nativo do provider | sim | não | não | não |
| Maestro certificado pelo Orca | não | não | não | não |
| Maestro verificado pelo Nexus | sim, read-only | sim | não | não |
| Escritor autônomo governado pelo Nexus | não | sim | não | não |

O `yolo` do Orca é default de lançamento para CLIs suportadas, inclusive as
flags globais de bypass de Claude, Codex e Kimi. O Nexus absorve a fluidez, não
o bypass: depois de uma aprovação nativa, somente o servidor MCP efêmero da
missão e o worktree selado recebem autoaprovação; panes diretos e servidores
ambientais conservam a política do provider.

Fontes do pin atual: `4ada3f8:src/shared/types.ts`,
`src/shared/tui-agent-config.ts`,
`src/main/agent-hooks/managed-agent-hook-controls.ts`,
`src/shared/agent-session-resume.ts`,
`src/main/runtime/orchestration/groups.ts`,
`src/main/runtime/orchestration/coordinator.ts` e
`src/main/runtime/orchestration/lifecycle-reconciliation.ts`. O delta
`ab1c378..4ada3f8` foi conferido também em
`src/renderer/src/components/sidebar/` e
`src/renderer/src/components/terminal-pane/terminal-visibility-resume.ts`.

O passe novo reforçou quatro padrões úteis: identidade estável do pane além do
handle textual, `dispatchId` por tentativa para rejeitar conclusão atrasada,
heartbeat vinculado à tentativa e retorno explícito do worker ao estado idle
após `worker_done`. O Nexus conserva versões mais fortes desses mecanismos:
incarnation + sessão física, receipt de handoff/consumo, prova de Git/worktree e
conclusão main-owned. Não foi copiado o fechamento do upstream baseado somente
em payload `filesModified`, nem seu coordinator que ainda exige tarefas
pré-criadas.

Portados como mecanismo, com atribuição verificável no ledger:

- coordinator/reconciliation, worker_done/heartbeat e autoridade por pane;
- cleanup por exit físico e eventos hook idle/question injetáveis;
- snapshot pré-kill de descendentes PTY, revalidação pré-SIGTERM e prova física
  finita sem `killpg` indiscriminado;
- feedback de review dirigido ao worker e recuperação main-owned.

Overclock foi usado somente como evidência comportamental observável: status
multi-CLI, espera orientada a handoff, probe/login-stuck, atividade sem LLM e
piloto delegate-only. Nenhum binário ou código proprietário foi copiado.

O app local auditado foi o Overclock `1.2.2`, assinado e notarizado. O sidecar
expõe panes, wait/read/write, handoff, missão, squad, task e recovery para
Claude, Codex, Gemini, Kimi, Antigravity e Grok; não foi encontrada rota OMP.
Transporte MCP significa que Codex/Kimi conseguem coordenar enquanto vivos,
mas não os promove a Maestro prebuilt. Os cinco squads e 23 agentes instalados
usavam Claude, evidência de que a experiência pronta ainda é Claude-first.

No visual, o cruzamento reteve os princípios do `STYLEGUIDE.md` do Orca:
cockpit persistente, chrome quieto, cor reservada a estado, uma ação afirmativa
dominante, erro acionável inline, disclosure progressivo, scrollbar discreta e
motion com reduced-motion. O Nexus aplicou esses princípios com identidade
própria: rail hierárquico de missão, provenance/worktree visíveis, painel
contextual redimensionável e uma única aprovação. Toast não pode cobrir modal
ou conteúdo, e erro persistente não pode existir somente como toast.

Rejeições deliberadas: Orca mobile RN/Tauri, memória textual global, `yolo`,
shadow-git genérico, tmux indiscriminado, proxy Codex, leaderboard e contagem de
tools como meta. O Nexus preserva sandbox, PREVC aditivo, isolamento por
checkout e host-key verification.

## Gates de prova

Antes de bump/tag/publicação, todos precisam estar verdes:

1. TypeScript, suíte integral, testes server e testes focados do mandato.
2. Proveniência Orca resolvida contra cada `commit:path` exato e smoke OMP no
   pin suportado.
3. Build/package limpo, assinatura Developer ID, notarização e stapling.
4. E2E real no ZIP verificado: approve → kickoff idle→busy → worker físico com
   reserva/roster → handoff aceito → integração → `done` honesto.
5. Verificador independente `check-work` com resultado `PASS`.
6. Release manual canônica e espelho público com inventário/digests exatos,
   sem GitHub Actions.

## Dependências externas honestas

Estes itens não podem ser convertidos em “feito” só com teste local:

- perfil Keychain exato `nexus-notary` precisa existir e autenticar no serviço
  Apple;
- OAuth App própria do GitHub precisa fornecer `clientId` de produção;
- Web Push requer backend/VAPID operado pelo produto;
- builds/assinaturas e E2E reais de Windows/Linux exigem as respectivas
  máquinas/credenciais;
- Windows não oferece hoje o inventário POSIX `ps` usado para provar identidade
  de descendentes PTY. O fallback é intencionalmente fail-closed: root pode ser
  encerrado, mas missão/reabertura e exclusividade não são liberadas sem uma
  futura implementação nativa verificável e testes em host Windows;
- pentest externo, OWASP ASVS L2 e cosign público exigem autoridade/serviço
  externo; artefatos locais não equivalem a certificação.

Enquanto qualquer gate obrigatório estiver aberto, o changelog deve dizer
“implementado/testado localmente”, nunca “piloto de verdade” nem “certificado”.

## Checkpoint para migração de Mac

O checkpoint de 2026-07-23 permanece deliberadamente na versão `0.19.26`.
O app empacotado chegou a criar um pane físico do orquestrador, mas bloqueou o
kickoff antes do plano/worker (`status=blocked`, `panes=1`, `dispatches=0`,
`handoffs=0`). Isso não satisfaz a Definition of Done e não autoriza tag nem
release.

A investigação eliminou um bloqueio síncrono anterior: o caminho de assinatura
nativa do Codex consultava o Keychain mesmo quando a subscription já era a
autoridade escolhida. A resolução de key agora só ocorre no ramo que realmente
injeta API key. O gate também passa a persistir um receipt de falha limitado,
com motivo de kickoff em enum fechado, sem prompt ou output do provider. No
checkpoint, os testes focados dessas mudanças somam 52 casos verdes e
`npx tsc --noEmit` está verde.

Depois de interromper a execução concorrente antes de congelar o índice, o
snapshot exato do checkpoint foi validado novamente: 853 arquivos/6.801 testes
na suíte principal, 28 arquivos/152 testes no servidor e typecheck verde no
produto e no servidor. Essa prova valida o código do checkpoint, mas não
substitui o E2E empacotado que segue bloqueando a release.

No Mac de continuação, a ordem obrigatória é: gerar pacote limpo, assinar,
executar novamente a missão real, exigir a cadeia completa até `done`, e só
então fazer bump/tag/notarização/publicação. O receipt `blocked` acima é
diagnóstico, não evidência de release.

> O Nexus só avança de versão quando uma missão real completa. Testes verdes
> sem done/blocked honesto não contam.
