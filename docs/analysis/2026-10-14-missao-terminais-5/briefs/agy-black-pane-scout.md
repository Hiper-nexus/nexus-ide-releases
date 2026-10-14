# Brief — pane do AGY fica preto até terminar

Papel: investigador SOMENTE LEITURA. Não edite, não commite.
Código: Nexus IDE em `C:\Users\Administrador\Documents\Projetos\nexus-ide` (main `152c77e82`; a v0.76.250 do cliente é
`release/0.76.249` em `C:\Users\Administrador\Documents\Projetos\nexus-ide-rel`).

## Sintoma
Um pane AGY (Antigravity, modelo gemini-3.8-flash-low) aberto por `nexus_pane_spawn` fica totalmente preto: só o
cursor, por vários minutos. O Nexus diz "one-shot em execução, sem saída no PTY até terminar". O fundador quer que
o AGY funcione "normal como os demais" (Claude, Codex etc. mostram a TUI e o progresso ao vivo).

## Perguntas (arquivo:linha)
1. Onde o Nexus decide rodar o AGY em one-shot (`--print`)? (adapter AGY em `src/main/adapters/`, quirks
   `initialPromptChannel`/`oneshot`, `mission-fast-lane.ts` ~214-224 cita "One-shot (AGY `--print`, OpenCode `run`)
   mata o pane — só worker"). Por que esse modo foi escolhido (o AGY 1.3.x tem modo interativo? aceita prompt
   posicional ou colado? tem saída em streaming / `--output-format stream-json`?). Veja o binário/ajuda se houver
   evidência no repo (docs, testes, fixtures de `agy --help`).
2. Opções para o pane não ficar preto, da melhor para a mínima: (a) rodar o AGY interativo como os demais, com o
   briefing por argv/colagem; (b) manter one-shot, mas com saída em streaming no PTY; (c) manter one-shot e escrever
   no pane uma linha de status do Nexus ("AGY trabalhando em execução única — a resposta aparece quando terminar;
   iniciado às HH:MM") e um indicador de vida (tempo decorrido), além do resultado final. Diga o custo e o risco de cada.
3. A mesma tela preta vale para OpenCode `run` e outros one-shot? Liste.
4. Proponha a correção (arquivo:linha) e o teste vitest que falharia hoje.

`nexus_handoff_submit` uma vez, PT-BR, até ~700 palavras.
