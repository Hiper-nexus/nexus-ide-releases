# Brief — troca de conta por cota sem perder NADA (análise para a próxima correção)

Papel: investigador SOMENTE LEITURA. Não edite, não commite, não rode build. Pode ler qualquer arquivo.

Código: Nexus IDE v0.76.250 em `C:\Users\Administrador\Documents\Projetos\nexus-ide-rel`
(ignore mudanças não commitadas em `src/main/orch/*-manifest.ts`). `main` em `C:\Users\Administrador\Documents\Projetos\nexus-ide`.
Referência: Orca 1.4.214 (MIT) em
`C:\Users\ADMINI~1\AppData\Local\Temp\claude\C--Users-Administrador-Documents-Projetos-hipergo\d997dd72-1ec7-48fa-8652-ada9ed96a0b3\scratchpad\orca`
(`src/main/claude-accounts/claude-profile-history.ts`, `claude-profile-sharing.ts`: o Orca compartilha o histórico
do Claude entre contas, então `--resume` na conta B enxerga a conversa da A).

## Requisito do fundador (literal)
"Quando acaba o limite de uma conta, nada pode se perder: o pane só muda para a próxima conta e segue a missão."
Vale para Maestro (orquestrador) e workers, em pane do renderer e headless.

## O que já está sendo corrigido (não refaça; considere como feito)
- F-1470: o respawn do Maestro passa a fixar a conta da linha (ou uma irmã do mesmo adapter com folga, via
  `pickAvailableForFailover`) e os selos (`mission-fast-lane.ts` ~314/~1239, `mission-engine-production.ts` ~323)
  aceitam conta do mesmo adapter escolhida pelo Main.
- F-1471: worker de missão em pane do renderer passa a ser relançado pelo Main na conta irmã do MESMO adapter
  (via `reopenTaskElsewhere` com modo `sameAdapter`, mesma worktree, pacote de continuidade), sem cair em
  outra CLI; o renderer deixa de mexer na conta de pane de missão.
- Em ambos, a conversa entre contas é SESSÃO NOVA + pacote de continuidade (`buildContinuityPack`,
  `prepareContextHandoff`); `--resume` só na mesma conta (`failover-controller.ts` ~181-189,
  `provider-session-store.ts` ~41-44, `failover-mission-respawn.ts` ~248 `nativeResumeImpossible`).

## Perguntas (arquivo:linha)
1. **Onde algo se perde hoje numa troca de conta**, caminho por caminho (Maestro renderer F-995
   `failover-orchestrator-respawn.ts`; worker headless `failover-mission-respawn.ts`; worker renderer depois
   do F-1471): (a) a conversa/contexto da CLI; (b) o prompt/tarefa em voo quando o limite bateu (o último
   pedido é re-entregue? o handoff pendente? a direção do operador em fila?); (c) mudanças não commitadas na
   worktree (o pane novo usa a mesma worktree? algo faz reset/clean?); (d) o estado da missão (vira
   blocked/"Dormindo"/paused em algum ponto?); (e) handoffs e ACKs pendentes do worker antigo; (f) o
   orçamento/contadores.
2. **Resume nativo entre contas.** No Nexus, onde mora o histórico de cada CLI por conta? Claude: o
   investigador anterior diz que o transcript é por checkout, não por conta
   (`provider-state/claude/<checkoutId>/claude/projects`, `hooks-gen.ts` ~525-533) e que as contas Claude
   usam `CLAUDE_CODE_OAUTH_TOKEN` sobre um `CLAUDE_CONFIG_DIR` único (`account-store.ts` ~570-615,
   `runtime-gates.ts` ~55). Confirme. Codex: `CODEX_HOME`/sessões por checkout (`cli-mcp-session-codex.ts` ~248)?
   AGY/Devin/Kimi/Grok/outros: por conta (`managed-credentials.ts` ~802-805)? Para cada CLI, diga se
   `--resume <sessão>` na conta B acharia a conversa da A, e o que muda no código para permitir (o que hoje
   proíbe: `provider-session-store` amarrando sessão à conta, `nativeResumeImpossible`, modo
   `cross-account-continuity` no renderer). Riscos: contas de organizações diferentes (a conversa vai para
   outra org) — proponha a regra (ex.: permitido por padrão entre contas do mesmo adapter cadastradas pelo
   operador, com opção para desligar; fallback automático para o pacote de continuidade se o resume falhar).
3. **Detecção que para o pane.** Hoje, sem leitura fresca da API e sem resposta da sonda, o pane fica ~15 min
   em pausa na mesma conta (`failover.ts` ~2628-2686). Com troca barata (resume nativo), vale trocar logo
   quando há irmã com folga conhecida, em vez de pausar? Quais falsos positivos o F-249 evitava (texto
   "limit reached" no output) e como evitá-los de outro jeito (ex.: exigir o padrão de limite na tela do
   provedor e não no conteúdo)? Proponha a regra.
4. **Escolha da irmã.** O pick usa folga medida; contas inativas têm leitura? (`quota/`, H2 do Orca
   `claude-fetcher.ts` lê uso de contas inativas). Se a irmã também estiver esgotada, o pane encadeia trocas
   até achar uma com folga, ou para? E quando TODAS esgotam: a missão espera a primeira liberar e retoma
   sozinha (com `nextUnblockAtMs`) sem perder nada? Mostre o caminho.
5. **Entregue o plano da correção F-1473 "troca de conta sem perder nada"**: lista mínima de mudanças
   (arquivo:linha, o quê), em ordem de valor, e os testes vitest que provam cada uma (incluindo: prompt em
   voo re-entregue; worktree intacta; missão nunca sai de running; resume nativo Claude entre contas com
   fallback; cadeia de irmãs esgotadas; todas esgotadas → espera e retoma sozinha).

## Entrega
`nexus_handoff_submit` uma vez, relatório em PT-BR (até ~1000 palavras) com arquivo:linha.
