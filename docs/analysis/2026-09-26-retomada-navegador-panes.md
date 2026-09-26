# Retomada de 26/09 — navegador e panes

## Contexto recuperado

A sessão original do Codex começou em 26/09 às 11:44, ID
`01a0de2c-9f67-7e60-9771-c6fb67ff507e`. O histórico está no diretório
`sessions` do CODEX_HOME isolado do Nexus, não no `~/.codex/sessions` nativo.
O quadro de missões retornava vazio porque o operador trabalha pelo + Pane.

O usuário autorizou entregar uma nova release com as melhorias, pediu revisão
independente por Claude Opus 5.5 em pane visível e depois priorizou corrigir a
impossibilidade de o próprio agente abrir helpers. Uma revisão pela CLI já foi
feita na sessão original; isso não satisfez o pedido de pane visível.

## Já integrado antes da retomada

- F-161: diff de outro pane não atribuído ao Claude; release 0.76.103.
- F-162: abas/missões novas em worktrees duráveis, commit `b7fc5ebd`.
- F-163: esforço escolhido por tarefa/capacidade da CLI, commit `3f7a8d79`.

## Trabalho desta retomada

- F-164: falha `no renderer window available` reproduzida ao tentar abrir o
  helper do navegador. Corrigido o destino de spawn no registro: sessão pai
  decide a janela; outros pedidos procuram grids com escopo vivo compatível.
  Cinco regressões RED antes do fix; 106 testes, typecheck e renderer sinks
  aprovados. Falta prova visual na build atualizada.
  Commit: `58c7012`.
- F-165: leitura/ação da UI agora selecionam entre janelas do projeto autorizado
  antes de aplicar preferência pelo foco. Dois testes RED e 22 testes aprovados;
  typecheck e renderer sinks passaram. Falta prova na build atualizada.
  Commit: `a76cb231`.
- Nenhum helper foi aberto com sucesso nesta retomada; não esperar um handoff
  do navegador. A tentativa foi recusada pelo Main antigo.

## Próximos passos autorizados

1. Concluir o perfil persistente próprio do Nexus no navegador interno. Botão
   **Perfil e logins** abre escolha de perfil do Chrome e sites; importa só
   sessões compatíveis, preservando o perfil Chrome original e mostrando
   resultados parciais honestos. Não prometer Chrome Sync, senhas ou extensões.
   O usuário aprovou opção persistente para agentes usarem esse perfil também,
   mantendo a possibilidade de abrir navegador isolado. Testar propagação de
   logout e cookies particionados; não importar cookies reais durante testes.
2. Busca na barra de endereço: `coolify` vira pesquisa; URLs continuam navegação,
   preservando validação de esquema/destino.
3. Validar F-164/F-165 no aplicativo atualizado: abrir helpers desde o + Pane
   e ler a UI com janela auxiliar ou outro projeto em foco.
4. Corrigir alerta falso de provider instável: hipótese da sessão anterior é
   `internal_error` no texto do prompt tratado como erro real do provider.
5. Corrigir recuperação `Failure|rate-limit`: diagnóstico anterior encontrou
   falha silenciosa na nova tentativa e aviso com horário vencido; a causa do
   sinal de limite ainda não foi confirmada.
6. Revisão Opus 5.5 em pane visível, QA real de spawn por CLIs diferentes e
   navegador, gate de release e publicação já autorizada.

O usuário reiterou nesta retomada: ao final de TODAS as correções e com o
navegador funcionando, commitar e fazer push de `main`. Não houve push parcial.

## Coordenação e verificações

- Um helper escritor por vez; leituras em paralelo. Se spawn recusar, não
  insistir nem declarar processo CLI de fundo como pane visível.
- Outro pane Claude, aberto pelo usuário, investigava conclusão prematura da
  missão em `worker-delivery-board.ts` e `civilian-delivery-completion.ts`.
  Evitar esses arquivos e conferir mudanças concorrentes antes de commitar.
- Node 22.23.2 (`/opt/homebrew/opt/node@22/bin/node`) usa o ABI correto do SQLite
  deste checkout. Não reconstruir os módulos nativos do aplicativo ativo.
- Preservar docs/QA-PROTOCOL.md, testes co-localizados, typecheck e
  security:renderer-sinks para mudanças de renderer/IPC. A release ainda não
  foi produzida nesta retomada.
