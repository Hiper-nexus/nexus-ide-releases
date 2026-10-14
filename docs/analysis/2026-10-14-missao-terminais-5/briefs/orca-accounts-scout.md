# Brief — o que herdar do Orca: troca de conta por cota sem parar a missão + coordenador único no respawn

Papel: investigador SOMENTE LEITURA. Não edite, não commite, não instale dependências.

## Fontes
- **Orca** (MIT, upstream de onde o Nexus já herdou código), clone raso da versão atual 1.4.214,
  commit `8a6d6ea8c861f76a82b4e1e7e064e918b3fb13e9`:
  `C:\Users\ADMINI~1\AppData\Local\Temp\claude\C--Users-Administrador-Documents-Projetos-hipergo\d997dd72-1ec7-48fa-8652-ada9ed96a0b3\scratchpad\orca`
  Pontos de partida: `src/cli/handlers/account*.ts`, `src/cli/specs/account.ts`,
  `src/main/acp/acp-account-binding.ts`, e busque por `usage limit`, `rate limit`, `quota`,
  `failover`, `rotate`, `account` em `src/main` e `src/shared`. Para orquestração: `orchestration/`,
  coordinator, heartbeat, pane authority, respawn.
- **Nexus** (o nosso produto), versão do cliente v0.76.250:
  `C:\Users\Administrador\Documents\Projetos\nexus-ide-rel` (ignore mudanças não commitadas em
  `src/main/orch/*-manifest.ts`). Leia `docs/multi-account-matrix.md` (diz "failover = troca de conta
  no mesmo adapter com resume CLI, estilo Orca"), `src/main/quota/`, `src/main/quota/account-pick.ts`,
  `src/main/orch/failover.ts`, `src/main/orch/provider-reroute-policy.ts`,
  `src/main/orch/pane-start-watchdog.ts` (F-1414 limite de uso), `src/main/orch/mission-fast-lane.ts`
  (bindSpawnedMissionPane ~272-351: a conta do Maestro é comparada com a conta aprovada na revisão,
  `physical.accountId !== approved.accountId`). O commit `d8d11236c` (no repo `nexus-ide`) trouxe o
  multi-conta da 0.76.245.

## Requisito do fundador
Quando a cota de uma conta acaba (janela de 5 h, semanal, tela de "usage limit"/429), a missão NÃO
para: o pane (Maestro ou worker) troca para outra conta do MESMO provedor com folga e segue a missão,
retomando a mesma conversa quando a CLI permite. Só sem conta irmã com folga cai no comportamento
atual (outro provedor ou pausa com mensagem clara).

## Perguntas (arquivo:linha nas duas bases)
1. Como o Orca detecta conta esgotada e troca de conta? Ele relança o mesmo pane com outra conta
   (outro config dir/env) e retoma a conversa? Como isola as contas (CLAUDE_CONFIG_DIR, CODEX_HOME,
   HOME)? Como a conversa sobrevive à troca (transcript copiado/compartilhado entre config dirs)?
2. O Orca grava a conta escolhida como "selada" em algum contrato, ou a trata como detalhe trocável
   do runtime? Como ele mantém UM coordenador por sessão de orquestração quando relança (single-flight,
   lock, geração)?
3. O que o Nexus já tem disso e o que falta. Onde o Nexus diverge do Orca de um jeito que quebra o
   requisito (ex.: conta selada na aprovação da missão)?
4. Lista concreta do que herdar (arquivo Orca → destino no Nexus, adaptação necessária, licença MIT
   com attribution) e do que NÃO herdar. Priorize o menor conjunto que entrega o requisito.

## Entrega
`nexus_handoff_submit` uma vez, relatório em PT-BR (até ~900 palavras) com arquivo:linha.
