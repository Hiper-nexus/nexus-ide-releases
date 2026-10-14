# Brief — por que a missão acumula panes mortos do Maestro

Papel: investigador SOMENTE LEITURA. Não edite, não commite, não rode build.

Código: Nexus IDE v0.76.250 (versão do cliente) em `C:\Users\Administrador\Documents\Projetos\nexus-ide-rel`
(ignore mudanças não commitadas em `src/main/orch/*-manifest.ts`).

## Sintoma (print do cliente, Windows)
Missão "Continuar o projeto [redigido]…" em "Dormindo". A aba Atividade diz "Sem última tela registrada (a
missão foi encerrada por uma build anterior)" — ou seja, o app foi atualizado com a missão aberta. A tela
Terminais mostra QUATRO panes "Claude · Coordenar e revisar" (papel orquestrador) da MESMA missão:
- pane 1: `[nexus] processo caiu (code undefined). Digite para religar — a missão continua no rail.` e depois
  `[nexus] autoridade de spawn expirou — reemitindo e religando a missão sozinho…`
- pane 6: `[nexus] processo caiu (code 129). Digite para religar…` e depois
  `[nexus] token de spawn expirado limpo — Reiniciar já usa autoridade nova.`
- pane 7: `[nexus] processo caiu (code undefined). Digite para religar…`
- pane 8 (marcado "Orquestrador"): "Subindo… Coordenar e revisar — claude · claude-opus-5-5".
O banner da missão: `Orquestrador não reabriu: orchestrator physical spawn authority is missing or mismatched`.

## Já se sabe (não refaça)
O banner vem de `src/main/orch/mission-fast-lane.ts` (~2388 e ~321): o respawn spawna sem fixar a conta e a
checagem exige a conta da aprovação. Isso está sendo corrigido em outra frente (F-1470). Seu foco é o
acúmulo de panes e as mortes.

## Perguntas (arquivo:linha)
1. Por que cada tentativa de religar o Maestro deixa um pane NOVO na tela em vez de reusar o pane do
   Maestro? Onde o respawn cria o pane (renderer layout store, `requestPaneSpawn`, `moveOrchestratorPane`,
   restauração do layout `src/renderer/terminal/terminal-host.ts`, `src/renderer/orch/restore-agents-gate.ts`,
   `mission-last-pane-notify.ts`)? Quando a ligação falha (`fast-lane:spawn-binding-failed`, cleanup em
   `mission-fast-lane.ts` ~1348-1354), o pane recém-criado é fechado ou fica na tela como "processo caiu"?
2. O que significam "code undefined" e "code 129" aqui (129 = SIGHUP? processo morto pelo encerramento da
   build anterior? terminação pelo cleanup do bind?) — ache onde a mensagem "processo caiu (code …)" é
   escrita e de onde vem o código.
3. Depois de uma atualização do app (build anterior encerrou a missão), o que a restauração faz com os
   panes de orquestrador gravados: restaura todos? religa algum sozinho (`shouldAttemptDeadPaneRevive`,
   `requestMissionRuntimeResume`)? Pode haver dois religamentos simultâneos (auto-revive de um pane +
   "Retomar o coordenador" + watcher do fast-lane)?
4. Proponha a menor correção para a missão manter UM pane de Maestro visível: aposentar/fechar os panes de
   orquestrador mortos quando um novo Maestro é religado com sucesso (ou quando o bind falha), e não restaurar
   duplicatas. Indique arquivo:linha e um teste vitest que falharia hoje. Diga se algo disso já é coberto
   pela correção da conta (F-1470) — depois dela, o respawn deixa de falhar, mas os panes mortos antigos ainda
   ficam?

## Entrega
`nexus_handoff_submit` uma vez, relatório em PT-BR (até ~800 palavras) com arquivo:linha, causas ranqueadas,
correção mínima e teste.
