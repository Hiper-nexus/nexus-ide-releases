# Jev: integração para a release 0.76.122

Escopo recuperado da worktree `feat/jev-efficiency-20260928`, a pedido do
operador para publicar tudo junto com o Sonnet 5.5 oficial.

- Roteamento: classificação e skill no mesmo `judge`, catálogo de skills
  filtrado por grants, confidências e autoridade do chamador preservadas.
- Navegador: `focus` opcional acrescenta perguntas de relevância ao mesmo
  julgamento da página. Código copia os trechos originais na ordem da fonte;
  resposta incompleta ou insuficiente mantém o texto da leitura limitada.
- Reutilização: cache por instância de browser/judge, estado, navegação e modelo,
  com TTL de 15 segundos e coalescência de pedidos iguais. Falhas não ficam no cache.
- Contabilidade: reutilização não aumenta consultas, tokens ou USD. Métricas
  distinguem chamadas evitadas, triagens sem LLM e bytes antes/depois da seleção.
  Não são prova de redução de tokens cobrados nem economia contrafactual geral.

Revisão independente encontrou ausência de testes de integração e truncamento
dos trechos selecionados no formato compacto. Foram adicionados testes de
cache/foco/opt-out/invalidação e do painel; o compacto prioriza os trechos
selecionados completos (até 20.000 caracteres) e limita os metadados restantes.
CodeRabbit apontou `requestCount=0` quando uma consulta retorna null: corrigido
para contar a invocação lógica mesmo sem resposta, sem inferir retries HTTP.

Validação: 363 suítes afetadas, 5.105 testes aprovados e 2 skips preexistentes;
os testes focados posteriores do contador e compacto também passaram.
Typecheck, renderer sinks (zero) e diff check limpos. A validação do pacote,
assinatura, notarização e publicação fica nos recibos do gate de release.

Fontes: [API TypeSafe](https://docs.typesafe.ai/api),
[Noul](https://docs.typesafe.ai/primitives/noul),
[perguntas paralelas](https://docs.typesafe.ai/cookbooks/parallel_questions).
Não houve inferência paga nesta validação; testes de integração usam a seam do
judge. O fail-open mantém a operação determinística caso o serviço não responda.
