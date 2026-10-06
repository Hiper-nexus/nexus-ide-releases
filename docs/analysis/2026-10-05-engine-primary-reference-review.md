# Motor autônomo: referências e critério de entrega

Objetivo do operador: o Maestro coordena, workers elegíveis e econômicos
implementam partes independentes, modelos fortes revisam/corrigem achados e
o motor conclui a missão com evidência. Vale tanto para missão iniciada pelo
`+ Pane` quanto para missão comum. A economia precisa incluir retrabalho,
revisão e integração, não apenas o preço do primeiro worker.

## Referências primárias consultadas

A Anthropic descreve roteamento por dificuldade, divisão em partes
independentes, coordenação por um agente e ciclos separados de avaliação e
correção. Critérios explícitos tornam a avaliação útil. Isso sustenta a
direção escolhida para o Nexus, sem provar sua taxa de sucesso.
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).

O relato do sistema de pesquisa da Anthropic ressalta escopo claro por
worker, persistência do progresso, retomada após falhas, tracing e avaliação
por resultados. Também documenta custo de coordenação e situações em que
as dependências limitam o paralelismo. Seus números de pesquisa não são
benchmarks de desenvolvimento nem estimativas de economia do Nexus.
[Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

O Electron recomenda medir CPU/memória, evitar trabalho bloqueante no Main,
adiar inicializações dispensáveis e deslocar processamento demorado. Isso
reforça a investigação do perfil real F-953 e os limites de varredura; não
justifica reescrever subsistemas sem identificar um gargalo.
[Performance](https://electronjs.org/docs/latest/tutorial/performance).

## Correspondência com o código revisado

| Objetivo | Mecanismo no Nexus | Prova ou limite |
|---|---|---|
| Worker econômico adequado | `routing-cost-policy.ts` e `task-router.ts` | Elegibilidade/tier antes do custo; revisão e reparo comprovado recebem prioridade distinta. Preferências de UI e escolha explícita do operador são preservadas. |
| Trabalho paralelo sem mistura | Worktrees de escritores e fila de integração | Banco Git compartilhado; clone APFS quando disponível. Uma pasta com branches exige escrita sequencial. |
| Respeitar 16/32 GB | Admissão PTY/ACP e reservas compartilhadas com validadores | Testes simulam as capacidades; não são certificação de hardware. F-256 e F-264. |
| Evitar missão parada | Supervisor, handoff durável e recuperação | Estado revalidado após await; modelo não suprime backlog comprovado. F-259 a F-261. |
| Encerrar e liberar recursos | Saída física, relatório antes do auto-close e reuso | F-257/F-258; WIP e branches não são apagados por uma entrega lógica. |
| Contexto útil e limitado | Seleção de memória, frescor de referências e contrato da tarefa | Não reenviar indiscriminadamente todo o histórico; registro desatualizado não prova o estado atual. |
| Custo honesto | Medição canônica Jev/Clef e licença separada de atividade | Uso não medido permanece desconhecido. F-262 corrige preço incorreto do momentum. |

## Prova que ainda falta antes de afirmar desempenho do produto

Executar no artefato final uma missão real pelos dois pontos de entrada,
incluindo trabalho independente, dependência entre tarefas, revisão com
achado, correção, validação e conclusão. Exercitar também falha de provider,
retomada e concorrência com um validador pesado. Registrar duração total,
custo disponível, tentativas, entregas aproveitadas e intervenção humana;
comparar trabalho equivalente. Nunca converter ausência de medição em zero.

As verificações de fonte, contratos e regressões desta integração passaram;
o teste do executável e a validação das plataformas são evidências separadas.
Os gates de publicação não devem ser substituídos por quantidade de testes,
por uma aprovação de LLM nem pelo silêncio de uma sessão colaboradora.
