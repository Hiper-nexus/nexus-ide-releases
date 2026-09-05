# Revisão do motor de missões do NexusIDE

Data: 2026-09-04. Base inspecionada: NexusIDE 0.76.0, HEAD `7f49194a`. Alterações na branch `fix/nexus-mission-reliability-20260904`.

## Diagnóstico

O motor tinha contratos divergentes entre seleção de equipe, intenção, despacho, identidade e conclusão. A execução real encontrou falhas que as suítes locais isoladas não impediam: recomendar um coordenador que o bootstrap recusa e declarar uma pergunta à equipe concluída depois de apenas o próprio coordenador responder.

Isso é uma falha funcional do produto central. Contagens de testes não demonstram que uma missão foi entregue. O critério de aceitação deste trabalho exige processos reais, respostas físicas identificadas e resultado correspondente ao objetivo.

## Evidência real

A validação usa uma instância de desenvolvimento, dados em `/tmp/nexus-engine-qa-data` e um repositório descartável em `/private/tmp/nexus-engine-proof`. O app instalado e as missões anteriores do usuário não são usados para executar os probes.

| Prova | Observado | Veredito |
|---|---|---|
| Início → nova configuração → pasta autorizada → abrir sem IA | Dois PTYs reais, na pasta selecionada | Passou |
| Pergunta pela equipe automática original | AGY escolhido coordenador; `assertFastLaneMaestroMcp` recusa iniciar | Falhou; causa reproduzida e corrigida na elegibilidade |
| Repetição após corrigir coordenador, com “Não altere arquivos” | Contrato virou `consult`, `maxWorkers=0`; só o coordenador respondeu; status `done` com README preexistente como artefato | **Falhou**, apesar do estado de sucesso do app |
| Pergunta após corrigir topologia/conclusão | xterm aberto dentro do Quadro oculto, slot 0×0; nenhum processo criado | Falhou; fallback confundia xterm aberto com terminal visível |
| Pergunta após corrigir spawn oculto | Codex, DeepSeek e GLM responderam 2 em três sessões distintas; receipts de captura PTY persistidos; resultado 3/3, nenhum arquivo de entrega inventado | Passou em 14,7 s |
| Biblioteca sum.mjs + testes + README | Implementação por worker, revisão por outro agente, ambos com handoff HTTP-MCP;3 arquivos entregues; execução independente passou6/6 testes | Passou; evidência limitada ao projeto pequeno |

Registros: [probes reais que falharam](../qa/evidence/2026-09-04-engine/failed-real-probes.json), [coordenador inválido](../qa/evidence/2026-09-04-engine/real-invalid-coordinator.png), [dois terminais reais](../qa/evidence/2026-09-04-workspace/real-shells.png).

O falso sucesso inicial é a razão para exigir o elenco aprovado como denominador. Contar somente os panes que conseguiram nascer transforma uma falha de despacho em falsa entrega. As provas finais estão em [respostas 3/3](../qa/evidence/2026-09-04-engine/real-question-completed.json) e [biblioteca com testes](../qa/evidence/2026-09-04-engine/real-file-mission-completed.json). As respostas curtas foram copiadas dos transcripts pelo leitor de fim de turno; não representam três chamadas voluntárias de MCP. A biblioteca teve handoffs HTTP-MCP e verificação independente dos arquivos.

## Causas e alterações

| Problema | Causa comprovada | Correção |
|---|---|---|
| Router reconhece chave, mas não a utiliza | Readiness lia vault/env; classificação e resposta liam somente `providers.conf` | Resolver de credenciais do provider reutilizado; provider desativado respeitado |
| Classificação barata não participa da missão | Renderer descartava tudo que não fosse `direct-answer` | Classificação validada e persistida em `routingAdvice`, incluída na revisão, consumida por ASK e sugestões de skills |
| Espera de classificação prolifera ou deixa preparação abandonada | Prazos por tentativa se somavam; persistência ocorria antes do await | Prazo total da cadeia; validação de escopo após rede, antes de anexos/squad/missão |
| Coordenador automático incapaz de coordenar | Metadado de controle era igual ao de handoff unidirecional; UI aceitava todos os CLIs | Elegibilidade publicada segue transporte MCP físico; automação prefere workers com esse transporte |
| Consulta/plano recebe ordens incompatíveis | Proíbe workers e simultaneamente proíbe o coordenador de executar | Doutrina específica por modo; nenhuma promessa de fan-out em orçamento zero |
| Dupla responsabilidade pela primeira onda | Main inicia workers, prompt manda coordenador abrir os mesmos | Primeira onda pertence ao Main; prompt reconhece inicialização assíncrona |
| Missão fica eternamente executando sem processos | Esgotamento de dez retries só gerava log | Bloqueio técnico recuperável, histórico preservado e novo orçamento em Retomar explícito |
| Resposta real tardia fica presa em diagnóstico provisório | Diagnóstico sintético participava da deduplicação/attachment como entrega real | Supersessão estreita após receipt físico e CAS; sessões substituídas recusadas |
| Pergunta à equipe desliga a própria equipe | Classificador de topologia não reconhecia pergunta numérica; restrição de escrita virava execução solo | Pergunta dirigida mantém topologia de equipe sem escrita |
| Conclusão com zero/parte dos integrantes | Atalhos contavam qualquer handoff e o conjunto de panes existentes | Gate de respostas do elenco aprovado, com identidades e receipts físicos; resultado de ASK não herda README |
| Login e missões não abrem terminais ocultos | Fallback aceita grade inicial 80×24 como evidência de visibilidade mesmo com slot 0×0 | Início após 200 ms com fit quando possível; revalida pane, pausa e geração |
| Clique em missão removida prende a navegação | Rota e atenção mantinham IDs apagados; não havia saída no erro local | Reconciliação após snapshot canônico, validação no clique e Voltar ao Início |

`routingAdvice` é uma recomendação validada. Não concede tools, não troca a equipe escolhida, não aumenta orçamento e não substitui um planejador completo de implementação. As skills são intersectadas com permissões existentes, e o coordenador ainda precisa produzir o plano de trabalho apropriado.

## Comparação com as referências

Os dossiês Bridge mais recentes são de 03/09; o dossiê de portabilidade Overclock é de 02/09. Documentos de agosto que descrevem Nexus 0.28.1 ou 0.70.21 não são o estado atual. Não foi feito benchmark executando os concorrentes nesta sessão.

- **BridgeSpace:** o [dossiê do harness](bridgespace-3418-extract/DOSSIE-HARNESS.md) descreve coordenador, tarefas com dependências/ownership, mailbox e eventos de ciclo de vida. A lição aplicável é tornar explícita a responsabilidade pelo despacho e a passagem de uma tarefa para a próxima.
- **Overclock:** o [dossiê de portabilidade](overclock-13318-dossie-portabilidade.md) ajuda a comparar hooks, payloads e recuperação. O Nexus já tinha warm pool, payload-first, polling de transcript, espelho de skills e transporte MCP/PTY. Esses mecanismos não estavam ausentes; suas condições e consumidores precisavam concordar.
- **Orca:** código atual fixado em `2f4f4578c828370f6413dc48f438a6b189f6190d`. A política de [worker-report-settlement](https://github.com/stablyai/orca/blob/2f4f4578c828370f6413dc48f438a6b189f6190d/src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts) permite um relatório real tardio superar falha inferida, preservando o vínculo da execução. Essa política foi adaptada ao receipt/CAS do Nexus, com atribuição em `third_party/provenance/orca-2f4f457.json` e licença MIT preservada. Não houve fork integral nem importação do banco do Orca.

## Contrato que deve reger o motor

```mermaid
flowchart LR
  A[Objetivo original] --> B[Intenção tipada e limites]
  B --> C[Revisão aprovada]
  C --> D[Elenco e identidade de cada execução]
  D --> E[Despacho pelo Main]
  E --> F[CLI real]
  F --> G[Resposta e receipt físico]
  G --> H[Verificação do objetivo e do elenco esperado]
  H --> I[Resultado apresentado]
```

O estado visual deve projetar esse contrato. Arquivo encontrado no disco, texto de sucesso do coordenador, worker sem output ou resposta de uma geração antiga não bastam para declarar entrega.

## Limites que permanecem relevantes

- CLIs distintas têm hooks, modos de prompt e autenticação diferentes. A disponibilidade manual de uma CLI não prova sua aptidão para coordenar ou para iniciar automaticamente sem intervenção.
- Diagnósticos antigos sem nonce não são aposentados automaticamente. Uma resposta tardia ambígua em missão que mistura dispatch governado e agentes avulsos é recusada de forma conservadora.
- O fluxo de hook atual ainda merece uma política durável de spool/replay, inspirada no `hook-stdin-contract` do Orca. Esse transporte não foi copiado sem validar identidade, limites de retenção e proteção do bearer.
- Há testes de UI com importações/efeitos assíncronos frágeis; falhas intermitentes de anexos foram registradas durante execução. Testes de domínio devem ser complementados por uma bateria real de missões pequenas.
- Não há declaração de release pronta ou de estabilidade de todo o produto neste documento. As duas provas reais acima passaram; o gate do binário empacotado não foi executado.

## Por que correções isoladas produziam novas falhas

O registro F-003 já alegava corrigir terminal oculto, mas F-009 introduziu espera por medida e o fallback voltou a depender da visibilidade. Ambos os objetivos eram válidos; faltava um teste que cobrisse os dois simultaneamente. F-101 também registra um workaround de ignorar um assento que não respondeu: isso não satisfaz uma pergunta dirigida a cada integrante. Nesta revisão, o teste preserva o elenco esperado e exige as respostas correspondentes.

A prioridade de engenharia é manter um pequeno conjunto de provas reais obrigatórias: terminal oculto, pergunta 3/3, implementação com revisão, retomada sem processos, remoção da missão selecionada e login com sessão nativa. Duas missões bem-sucedidas não demonstram excelência geral, mas estabelecem uma base verificável que estava ausente dos critérios de entrega anteriores.

## Verificação integrada do código

49 arquivos de teste passaram, totalizando 1.129 testes, com typecheck e auditoria de sinks do renderer aprovados. A compilação do renderer passou. A revisão CodeRabbit encontrou três problemas adicionais: prioridade do diagnóstico fail-closed em dois caminhos de conclusão e perguntas iniciadas por “por que”. Foram reproduzidos e corrigidos; as regressões incluem também “o que”. Dois testes antigos de anexos aguardavam apenas microtasks e não o hash WebCrypto real; passaram a aguardar as operações reais, sem enfraquecer a exigência de uma única importação.

Esses números são da suíte focada nos arquivos alterados, não de toda a suíte do monorepo. Login e seleção de Providers têm provas separadas e não autorizam afirmar compatibilidade de todas as CLIs.

## Providers e navegação após os novos relatos

A primeira reformulação de Providers ainda falhou no uso real: um limite de largura de 920px e botões em cada linha comprimiam nomes, e flex-shrink fazia estados sobreporem o próximo item. A segunda versão usa a largura disponível, reserva uma coluna legível para seleção e concentra ações no detalhe. Foi inspecionada no app real, além de cinco larguras de prévia com 19 providers e vários estados desconhecidos. A lateral mantém navegação fixa e compacta os controles em janelas baixas; o caso de Recentes cortado passou em 700px e a navegação continuou acessível com 30 missões em 600px.

Claude e OpenClaude tiveram login real confirmado e passaram a apresentar a mesma observação no resumo e no detalhe. O Muse nativo respondeu 1+1 corretamente, e seu pane manual também abriu pelo fluxo normal do Nexus e respondeu 2. Sua autenticação delegada ao Keychain permanece “não verificada” na UI; permitir a tentativa manual não concede autoridade de missão. **Missões automáticas usando Muse continuam restritas**; este trabalho não declara compatibilidade plena dessa CLI com o motor.

A remoção de uma missão de teste aberta pela lateral voltou ao Início, sem referência residual nem erro. O helper de login foi exercitado com comando inofensivo em uma sessão real; o comando escreveu um marcador temporário, verificado independentemente e removido. Não foram trocadas credenciais.

Capturas e dados: [Providers real](../qa/evidence/2026-09-04-providers/v2-real-settings.png), [estados de login](../qa/evidence/2026-09-04-providers/real-auth-state.json), [pane manual Muse](../qa/evidence/2026-09-04-engine/real-manual-muse-answer.json), [remoção real](../qa/evidence/2026-09-04-engine/real-removed-mission.json). Alterações permanecem locais/DEV; app instalado e release pública não foram atualizados.
