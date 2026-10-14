# Brief — por que o roteador só abre Codex Sol xhigh e nunca Kimi, MiniMax, Grok ou Devin

Papel: investigador SOMENTE LEITURA. Não edite, não commite.
Código: Nexus IDE em `C:\Users\Administrador\Documents\Projetos\nexus-ide` (main `152c77e82`).

## Sintoma (fundador, hoje)
"Por que quando abre o Codex só abre Sol xhigh e não usa os demais modelos? Cadê o uso do Kimi, do MiniMax, do Grok,
do Devin? Aqui vários terminais abertos sem eles." Num orquestrador, 7 de 8 `nexus_pane_spawn` sem `adapterId`
caíram em Codex `gpt-6.1-sol` xhigh ou Claude Opus. Os recibos diziam, por exemplo:
`tier=critical; specialty=security; sinais: segurança, migração, production; lane de julgamento (segurança crítica:
Claude/Codex); purpose=reviewer; effort=xhigh source=tier` e, com pin, `redistributed … pin-sem-pedido-do-operador`
e `prefer: grok=preterido no multi-score`. Tarefas "easy/doc" foram para AGY flash e MiMo flash. Kimi, MiniMax e Devin
não apareceram nenhuma vez.

## Perguntas (arquivo:linha)
1. Mapeie a decisão: classificador de tier/specialty (heurística por palavras — quais palavras empurram para
   critical/security?), a "lane de julgamento" que restringe a Claude/Codex, o multi-score (benchmark oficial,
   preferência free/cheap), a escolha do modelo DENTRO da CLI (por que sempre `gpt-6.1-sol` e xhigh no Codex; que
   outros modelos o Codex oferece e quando seriam escolhidos), e a redistribuição de pin.
2. Por que Kimi, MiniMax, Grok e Devin nunca ganham? Estão prontos (auth/rota) nesta máquina? (procure o estado de
   prontidão/readiness, `login-needed`, "reservado/não instalado"). Há regra que os exclua de `purpose=reviewer`
   ou de tarefas de leitura?
3. O pedido do operador é usar TODAS as LLMs prontas. Proponha a menor mudança de política para espalhar trabalho
   (ex.: tarefas de leitura/pesquisa somente-leitura não precisam da lane crítica; heurística de "segurança" não
   deve disparar por palavras num brief de revisão comum; diversidade entre panes da mesma missão — penalizar a CLI
   que já tem N panes vivos na missão; variar modelo/esforço dentro do Codex conforme a tarefa), mantendo qualidade
   para o que é realmente crítico (veredito final de código). Arquivo:linha e teste vitest que falharia hoje.

`nexus_handoff_submit` uma vez, PT-BR, até ~800 palavras.
