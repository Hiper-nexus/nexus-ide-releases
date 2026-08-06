# Review 0.27.0 — refatoração do modelo de execução (caminho simples por padrão)

**Reviewer:** pane-231 (executor das lanes de aprovação/voz; auto-review dos próprios commits marcado) · **Data:** 2026-08-06 · **Método:** leitura de diff por site + re-execução INDEPENDENTE das suítes (contagens abaixo são minhas, não as dos commits) + verificação de fiação em call-site vivo.

## Veredito

# APPROVE-WITH-NOTES

Nenhum achado CRITICAL/HIGH aberto. A essência não foi trocada por simplicidade: proveniência intacta (kind novo, história nunca reescrita), não-interferência com regra imposta na admissão, e o único gate dispensado é o que por definição não se aplica a quem escreve por contrato.

## 1. Integridade de proveniência — PASS

- `simple-implementation` é KIND NOVO e `same_checkout_validated` é RECEIPT NOVO (task-dispatch-store.ts, +189): receipts antigos `implementation` continuam AFIRMANDO isolamento por worktree e validando pelo caminho intocado. Reuso condicional foi explicitamente rejeitado no design — correto.
- O receipt simples grava `nonInterference: "serialized-writer"`, `physicalHeadSha`/`integrationHeadSha` e a cadeia de evidência amarrada a `context_revision`+`contract_hash`+`workflow_revision` do contrato — um auditor distingue as duas formas sem adivinhar.
- Identidade canônica é do ESTÁGIO (guided-task-kind.ts): `guided-execution` aceita `implementation` OU `simple-implementation`; segue proibido outro plannerId reivindicar a entrega. Recuperação de plano selado ANTIGO validada (guided-mission-planner-recovery + seal: verdes na minha execução).

## 2. Não-interferência — PASS

- Regra imposta na ADMISSÃO, não na conclusão: a cadeia guiada tem UM escritor por construção (singleton do estágio de entrega; `worktree-contract.ts`: "the guided chain must not open a second writer on itself"); escritor com ownership vazia permanece fail-closed na cadeia sequencial (mission-scheduler-ownership.ts:265-295); leitores (`read_only`) nunca ocupam slot exclusivo (347f0b7b) e finalizam pelo caminho read-only próprio.
- Fan-out largo NÃO mudou: wave-pack continua exigindo `isolated_worktree` (guided-mission-plan-authority.ts, região :328-336 intocada — verificado no HEAD, não só no diff).
- Plano MISTO (fase larga isolada + entrega simples) tem contrato fixado em `simple-path-default.test.ts` (48/48 verdes na minha execução).

## 3. Erosão de gates — PASS (uma dispensa, correta e documentada)

- ÚNICA asserção dispensada: `assertReadOnlyPhysicalGitAuthority` (HEAD imóvel) no caminho same_checkout — seu único propósito era provar isolamento, e o worker simples escreve POR CONTRATO. Permanecem: CAS de estado/revisão, autoridade do plano SELADO com modo exato, autoridade física do handoff com cronologia (`routeConsumedAt`/`issuedAt`/`acceptedAt` ≤ now), intent selado, evidência confiável amarrada ao contrato, e o fail-closed que recusa same_checkout no kind isolado + revisor tentando escrever.
- 84110780: worktree vira OPT-IN sem remover a capacidade; 10347b0c: ganho em segundos declarado NÃO VERIFICADO no próprio teste/doc — honestidade registrada, não forjada. ✓

## 4. Fiação — PASS

Cada mudança tem call-site vivo verificado: planner sela o modo (guided-mission-planner.ts), meta deixa de descartar no decode (mission-scheduler-meta.ts — a raiz da mina), produção conclui em vez de bloquear (mission-scheduler-production.ts), autoridade de conclusão aceita o receipt próprio (task-dispatch-mission-completion-authority.ts), prompt do worker diz a verdade do contrato (mission-scheduler-task-prompt.ts). A regressão de 347f0b7b (carimbo de leitor em unidade rotulada perturbando plano selado) foi encontrada e corrigida DENTRO de 24b55bd4 — o processo de regressão completa funcionou.

## 5. Zero-prompt — PASS com NOTAS

- Caminho principal sem NENHUM prompt: gate extinto (2e24cee3: needs_approval removido da máquina de estados — inalcançável, não apenas sem uso), autorização vira registro com recibo sha256 no fence (9e432cf0), encerrar/parar imediato, poda do maquinário (1990ad1a), CTA do wizard sem linguagem de aprovação.
- Reversibilidade REAL entregue: encerramento preserva panes/scrollback/receipts + Retomar (efe44703); delete de missão segue atrás de prova de encerramento físico; receipts/verdicts são o registro.
- **N1 (MEDIUM, follow-up):** restam DOIS prompts mid-flight fora do caminho feliz: confirmação de efeito do MCP (`mcp-server.ts:158` — dispara só quando worker pede efeito FORA da autoridade da missão) e grant nativo de squad imediato (orch-ipc). Recomendação: mesma doutrina registro+reversibilidade na próxima onda; clarify do Jarvis é pergunta de CONTEÚDO, não permissão — decidir à parte.
- **N2 (LOW):** reversibilidade trash/backup-refs para operações destrutivas DE WORKERS exige o substrato de hooks injetados (lane 248) — spec'd, não implementável do main; até lá o registro (receipts + physicalHeadSha no receipt) é a trilha de undo.

## 6. Migração — PASS

- Missões estacionadas em `awaiting_approval`: soltam NA LEITURA (`mission-store.ts#fromRow` → ready_to_start, idempotente) — a missão do dono parada desde 10:34:19 destrava no primeiro boot; republish de reaprovação nasce `ready_to_start` (SQL).
- Planos/receipts selados ANTIGOS (isolados): validam pela identidade de estágio (defeitos `guided_plan_legacy_receipt_blocked` encontrados e corrigidos DENTRO de 5c0208b9, com testes de recuperação verdes).

## Notas menores

- **N3 (LOW):** `notifyIfLastMissionPaneClosed`/HomeDeck do layout-store segue disparando para fechamento de último pane POR usuário — comportamento desejado; monitorar percepção.
- **N4 (LOW):** grants de revisão do wizard permanecem inertes (E2E os emite); poda junto da atualização do contrato E2E do gate (a linha "aprovação nativa" do gate precisa acompanhar o mundo sem modal — invariante-no-mesmo-commit quando a 0.27.0 tocar o gate).

## Mapa de aceitação 0.27.0 (o que ELE faz para ver cada mudança)

1. **Missão nova "corrija X"** → começa a rodar SEM nenhum diálogo de aprovação; o card mostra execução direta no workspace (sem worktree, sem merge ao final).
2. **A missão dele parada desde 10:34** → ao abrir o build novo, ela aparece PRONTA (não estacionada); Retomar/Iniciar segue direto.
3. **Encerrar uma missão em execução** → sem confirmação; panes e scrollback FICAM; card diz o porquê; Retomar desfaz.
4. **Pane claude de worker** → nasce já executando a tarefa (argv), sem colar prompt depois.
5. **Reviewer/QA read-only** → não recusa mais por "worktree exigida" e finaliza sem ocupar vaga de escritor.
6. **Missão wave-pack (N stories)** → stories continuam em worktrees isoladas (nada mudou no largo).
7. **Receipts**: detalhe da missão mostra a forma da entrega — `simple-implementation`/`same_checkout_validated` para o caminho simples; missões antigas seguem mostrando `implementation` isolada.
8. **Toque de Espaço** digita espaço em pane de missão; segurar dita; "Saída do ditado" em Configurações › Voz troca EN-execução/PT-literal.

## Execução independente de testes (minhas contagens)

- simple-path-default + seal + recovery: **48/48**.
- Suíte completa `src/main/orch/` + `src/main/pty/`: **3588/3588 em 291 arquivos, exit 0** — minha execução, batendo exatamente com a contagem declarada nos commits. Condição do veredito SATISFEITA.
- tsc: **0** no HEAD revisado (5c0208b9 + docs).
