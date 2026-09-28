# Memória, qualidade de código e delegação — revisão de 28/09/2026

Objetivo do operador: Nexus livre para trabalhar por panes, com disciplina de engenharia — compreender o existente, reaproveitar funções, evitar duplicação e validar o comportamento alterado. Liberdade de executar e evidência de qualidade são coisas compatíveis; exigir cliques extras não comprova correção.

## O que já existia e foi reaproveitado

- Banco por projectId (compartilhado entre worktrees), FTS5, memórias trusted, supersessão e redação de segredos.
- Engineering Charter e Ponytail para orientar leitura, reuso e diffs pequenos.
- Modelo de negócio estruturado, extraído/revisado e atestado pelo Main; texto editado arbitrariamente pelo agente não ganha autoridade.
- Portão de regressão no Stop e handoff: seleciona testes por diff, imports, consumidores de banco e invariantes; resultados têm status e diffHash.
- Scanner determinístico de duplicação/código morto e revisão independente. Ele não é um verificador universal de semântica.
- Autoridade Main para distinguir o pane do operador promovido de um worker.

## Correções

| Finding | Falha | Mudança |
|---|---|---|
| F-176 | Promoção do + Pane interrompia contexto/conselho | A identidade Main-owned sobrevive à promoção nos hooks de memória/modelo/delegação; workers não ganham essa exceção |
| F-177 | Memória congelada por 30 min, independentemente da tarefa | Consulta por pedido, deduplicação por bloco e escopo; mudança de assunto ou de fatos chega imediatamente |
| F-178 | Query consumida pelo preâmbulo e por palavras introdutórias | Preserva a tarefa crua antes dos contratos; símbolos técnicos tardios têm prioridade nas 12 vagas FTS |
| F-179 | Documentação esgotava o inventário antes do código | Separa orçamento de inventário e leitura de fontes; prioriza arquivos alterados e vizinhos |
| F-180 | Recibos sem conhecimento ocupavam o prompt | Só aprendizado destilado vai ao auto-recall; recibos completos continuam auditáveis |
| F-181 | Citar uma tag desligava a memória | Só blocos completos no início contam como já injetados |
| F-182 | Retomada da aba perdia orientação de delegação | Nota curta restabelece delegação proporcional e delimita o fim da espera pelo ajuste |
| F-183 | Invariantes no briefing não chegavam ao portão da worktree | Leitor compartilhado com fallback Main-owned do mesmo projeto/instalação; hash do modelo invalida cache |

A carta de engenharia passou a explicitar leitura de implementação/chamadores/testes, justificativa para código novo, registro de fatos verificados e relato de checks não executados. Ela deixa de prometer que qualquer handoff significa produção segura e de incentivar limpeza fora do escopo. O resumo do modelo aponta funções e arquivos já extraídos. Fluxo sem teste pede uma verificação focada, não uma parada burocrática automática.

Também foi removida duplicação real: dois truncadores UTF-8 da memória foram substituídos por `clampUtf8TextPrefix`, já existente em shared. Os limites e caracteres multibyte continuam cobertos pelos testes de memória.

## Evidência mecânica

- Walker real neste repositório, mesmos critérios de tamanho de arquivo: antes 1022 arquivos inventariados, zero de src, truncated=true; depois 9613, sendo 3826 de src, truncated=false. O scanner continua lendo no máximo 1500 fontes / 8 MiB e declara partial se alcançar limites. Inventariar não equivale a analisar tudo.
- Fixture com 1600 documentos e duas funções iguais: agora encontra a duplicação em fonte não alterada.
- Gate em duas raízes: modelo atestado apenas no coordenador passa seus testes à worktree; falha do teste aparece como invariante violado. Outro projeto não herda; remover o modelo invalida a seleção/cache anterior.
- Memória: segunda tarefa, fato atualizado, tag citada, preâmbulo same_checkout/isolated_worktree, símbolos tardios e recibo sem resumo têm regressões dedicadas.
- Bateria abrangente de 31 suítes: 485 testes passaram. Baterias adicionais de retomada (19), modelo/portão (107), contexto do modelo (33) e memória/isolamento (51) passaram. Há sobreposição; não somar como testes únicos.
- Typecheck e security:renderer-sinks passaram (0 sinks). Revisão CodeRabbit final registrada ao concluir a rodada.

## Delegação nesta sessão

Claude, GLM e Grok foram abertos como panes readOnly, entregaram handoffs e fecharam automaticamente. Os resultados foram lidos, confrontados com o código/testes e reconhecidos. Não ficou helper aberto.

O diagnóstico do GLM sugeriu remover o marcador awaiting-adjustment em qualquer input. Isso NÃO foi adotado: um pedido de status não é um ajuste, e o timestamp também protege a conclusão contra handoffs antigos. A primeira onda do objetivo antigo permanece suspensa; a orientação após a mensagem do operador permite delegação específica do ajuste. O Nexus não pode revogar uma restrição superior imposta pelo ambiente do CLI. A nota de retomada agora manda identificar essa restrição em vez de alegar incapacidade genérica.

## Limites reais

- Orientação de prompt não é prova de que toda ferramenta nativa leu todos os chamadores. Scanner, testes e revisão fornecem evidência delimitada, não garantia de ausência de bugs em produção.
- Portões indisponíveis ou sem testes não ganham um verde fictício; o comportamento fail-soft e o limite de retentativas existentes permanecem. Não foi acrescentado modal nem nova barreira de despacho.
- Este repo tem `.context/docs/business-model.md` com cabeçalho Product e sem o marcador estruturado `nexus:business-model:v1`. Esse documento não é um modelo atestado consumível pelo portão. Foi preservado; a correção não transforma texto manual em autoridade nem inventa invariantes. Os testes de modelo usam fixtures explicitamente atestadas.
- Não houve release, instalação ou reinício do app do operador. A melhoria de lentidão F-209 permanece no checkout, preservada da rodada anterior.
