## NexusIDE 0.76.253 — Troca de conta sem perder nada (Windows x64)

**Build local sem assinatura.** Este instalador foi gerado numa máquina Windows do operador, fora do GitHub Actions, e **não tem assinatura Authenticode** (a versão assinada será a da Microsoft Store). O SmartScreen do Windows pode avisar ao abrir o `Setup.exe`: clique em "Mais informações" → "Executar assim mesmo".

- **Commit:** [`f1b30a82c18efd020bb683f0b15c67a444ca2bc0`](https://github.com/Hiper-nexus/nexus-ide/commit/f1b30a82c18efd020bb683f0b15c67a444ca2bc0)
- **Node:** 22.23.2
- **Gates que passaram:** `npm run typecheck`; `npm run security:renderer-sinks` (0 sinks); testes do `windows-release.yml` (9 arquivos, 132 testes); suíte completa sem regressão contra a 0.76.252 (mesmas falhas da base); recortes de failover/respawn/relay (744, 482 e 137 testes); `npm run make -- --platform win32 --arch x64`; `collect-windows-release.ps1` (smoke nativo do NUPKG, recibo schemaVersion 2, `signing: none`).
- **Prova de upgrade N→N+1 não foi feita** (`installedUpgradeVerified: false` no recibo).

### Mudanças desde a 0.76.252

- **A missão não para quando a conta acaba.** Quando uma conta atinge o limite de uso, o pane troca para a próxima conta do mesmo provedor e segue a tarefa, na mesma pasta. A troca encadeia entre várias contas, conta medida em 100% nunca é escolhida, a espera pela cota dura até 24 h e volta depois de reiniciar o app (F-1471, F-1483, F-1486, F-1489).
- **A mesma conversa na conta nova.** No Claude, a troca continua a mesma conversa (só depois de provar que retomou; senão, sessão nova com resumo), e o pedido em andamento vai junto — inclusive o que chegou durante a troca (F-1473, F-1482, F-1488, F-1512).
- **Nada se perde no meio da troca.** O pane substituto recebe a tarefa antes de começar a trabalhar, e a recuperação de uma tarefa nunca abre dois substitutos (F-1480, F-1489, F-1512).
- **Limite avisado pelo Claude troca na hora**, uma vez só, sem a pausa de 15 minutos (F-1484).
- **Coordenador sempre volta.** O Maestro não é mais recusado com «orchestrator physical spawn authority is missing or mismatched»; volta na conta com folga e a missão mostra um Maestro só (F-1470, F-1475).
- **CLIs.** O pane do AGY mostra o trabalho ao vivo (F-1476); revisões somente leitura usam todos os modelos de ponta e CLI presa no login sai da rota (F-1477); o Grok no Windows não pede login a cada pane (F-1485).
- **Celular.** O QR de controle volta a dar controle e o celular diz por que não conectou; na rede local a porta é fixa e há «Parar»; o servidor de conexão do celular foi para a Cloudflare (F-1472, F-1478, F-1487).
- **Windows.** O hook do Nexus não estoura mais o tempo do Claude nem mostra base64 em vermelho (F-1474).
- **macOS/Linux.** A vaga de comando pesado não é liberada com processo vivo na volta do horário de verão (F-1479).
- **Squads.** Editor, importação e preparo de squads mais firmes no Windows e com rosters antigos (F-1490..F-1511).

Commits (`git log --no-merges v0.76.252..f1b30a82c`):

```
f1b30a82c chore(release): 0.76.253 — Troca de conta sem perder nada
e8fcef07f fix(failover): F-1512 — espera restaurada só cai quando o limite novo é aceito
04eb3daab fix(failover): F-1512 — delta da troca neutralizado e lembrado uma vez
524ac577d chore(companion): F-1487 — config de deploy do PWA
734ad30e9 feat(relay): F-1487 — relay do celular no Cloudflare (Durable Objects)
59d2e2e7c fix(failover): F-1512 — substituto recebe a tarefa antes de trabalhar e herda o pedido aceito durante a troca
2d920339a fix(failover): F-1489 — correções de integração da troca de conta
c2ffc419b fix(grok): F-1485 — o Grok no Windows não pede login a cada pane
36968e388 fix(failover): F-1484 — StopFailure rate_limit do Claude troca de conta na hora
09f44a6ce fix(orch): F-1477 — revisão de leitura usa todos os modelos de ponta e CLI sem login sai da rota
790878a06 fix(adapters): F-1476 — o pane do AGY mostra o trabalho ao vivo em vez de ficar preto
f6671b3ab fix(failover): F-1488 — tarefa reaberta sozinha continua a mesma conversa no Claude
3bea82c9b fix(failover): F-1483 — troca de conta encadeia, espera sem limite curto e volta depois de reiniciar
04ddf5a73 fix(failover): F-1486 — tarefa sem pane volta sozinha e a troca de conta não corre com o supervisor
60f970b5e fix(failover): F-1482 — troca de conta ou de CLI reentrega o pedido em voo
efbbcffeb fix(failover): F-1473 — troca de conta continua a mesma conversa no Claude
814457ea7 fix(failover): F-1480 — troca de conta do worker headless não conta morte nem falha e mantém o lugar do pane
bb5cdd0c3 fix(orch): F-1475 — a missão mostra um Maestro só, sem panes mortos acumulados
8ffa0558f fix(remote): F-1478 — celular na rede local diz o que fazer e a porta não muda a cada início
68fc7b732 fix(agents): F-1511 — spec de agente lê CRLF e recusa CON/NUL e nome só com outra caixa
cd649fdbe fix(runtime): F-1510 — prune de worktrees do Nexus reconhece a grafia C:/ do Git no Windows
98b2964e7 fix(runtime): F-1509 — raiz do workspace com outra caixa ou em 8.3 é aceita como top-level do Git
c43321a0c fix(path): F-1508 — Windows relê o PATH do registro no reexame de CLIs
7d0053f8b fix(adapters): F-1507 — sonda do Kimi e descoberta de modelos aceitam espaço no caminho
be08b9024 fix(runtime): F-1506 — sandbox de processo aceita %TEMP% em 8.3 no Windows
71f235041 fix(squads): F-1505 — importação e migração aceitam UTF-16 e UTF-8 com BOM do Windows
044e7b401 fix(missions): F-1504 — nexus_mission_create confere o squadId na criação
57b308397 fix(squads): F-1503 — salvar recusa o squad que nenhuma missão consegue usar
26f54c1f9 fix(squads): F-1502 — o arquivo exportado pelo app volta a importar no outro PC
6647a91e0 fix(fast-lane): F-1501 — primeira onda senta o integrante do roster na CLI do Maestro
77ac024d3 fix(squads): F-1500 — nome de integrante repetido é recusado com o nome; busca ignora espaços nas pontas
03e979727 fix(squads): F-1499 — cópia selada de missão volta byte a byte depois de reiniciar
463d9f708 fix(squads): F-1498 — squad antigo sem allowedSkills volta com o piso de skills na carga
ac377524e fix(mission): F-1497 — Maestro sem modelo não herda o modelo padrão de outra CLI
77003c68a fix(mission-setup): F-1496 — usar equipe recusada diz a causa real, não "até 12 pessoas"
3c9f1644f fix(squad-ui): F-1495 — editor recusa nome de agente repetido e apara espaços
1019da3e0 fix(mission-setup): F-1494 — Expresso confere a ferramenta de todos os papéis
75581b781 fix(squad-ui): F-1493 — Modelo do editor mostra o que será salvo
7bc7c722d fix(squad-ui): F-1492 — exatamente um coordenador no editor e saída na Equipe
d7c18c97e fix(squad-ui): F-1491 — coordenador que não coordena é barrado na UI com o motivo
77b591555 fix(mission-setup): F-1490 — prepare recusado mostra a causa real em português
362f53bdf fix(orch): F-1470 — Maestro volta na conta com folga e a recusa diz o motivo
1bc05f4ad fix(failover): F-1471 — worker de missão troca de conta no mesmo provedor e segue a tarefa
3db365d6e fix(heavy-command): F-1479 — filtro de órfão só compara hora absoluta e resposta null diz o motivo
1a5ab024f fix(hooks): F-1474 — hook do Nexus no Windows não estoura mais o tempo do Claude
827b44302 fix(companion): F-1472 — QR de controle volta a dar controle e o celular diz por que não conectou
```
