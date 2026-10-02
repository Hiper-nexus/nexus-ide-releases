# Uso complementar de Jev e Clef no Nexus

Análise em 1 de outubro de 2026. A direção solicitada é preservar Jev e
acrescentar Clef, escolhendo automaticamente o modelo que funciona melhor
para cada tarefa. A interface também deve permitir escolher o modo de uso e
configurar as credenciais Cloudflare.

A recomendação é um roteador de decisões com política explícita por tarefa,
alimentado por avaliações do Nexus. Visão exige Clef; tarefas textuais podem
usar qualquer um. Empates favorecem custo e desempenho medidos. Benchmarks
públicos orientam os candidatos iniciais, mas não comprovam o vencedor nos
fluxos do produto.

Este documento apresenta uma proposta. A integração, a tela e as avaliações
com chamadas reais ainda não foram implementadas ou executadas.

## Comparação publicada

Clef foi lançado hoje. A Cloudflare publica medianas de 209,3 ms para Clef,
38,8 ms para Clef Flash e 524,1 ms para Jev. São resultados do fornecedor,
não latências medidas no Nexus nem promessa de melhoria do fluxo completo.
Ambos os modelos Clef usam as perguntas `noul`, `choice` e `score`.
[Anúncio oficial](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/).

A tabela abaixo reúne testes publicados relevantes para discutir as rotas.
Cada linha tem sua própria métrica; os valores não devem ser somados ou
comparados entre linhas. O vencedor é o daquele teste, não necessariamente
o da funcionalidade correspondente no Nexus.

| Teste | Clef | Clef Flash | Jev | Maior resultado |
|---|---:|---:|---:|---|
| BFCL, acerto exato | 98,5 | 98,8 | 95,8 | Clef Flash |
| ToolRet, nDCG@10 | 69,2 | 66,4 | 65,3 | Clef |
| API Bank, acurácia | 91,9 | 93,1 | 88,2 | Clef Flash |
| BANKING77, macro F1 | 94,2 | 90,9 | 79,7 | Clef |
| CLINC150+OOS, macro F1 | 97,4 | 66,8 | 89,3 | Clef |
| RouterBench, qualidade selecionada | 79,7 | 79,9 | 79,9 | Jev e Flash |
| ANLI, macro F1 | 69,8 | 59,1 | 74,8 | Jev |
| BRIGHT, nDCG@10 | 45,9 | 39,3 | 47,5 | Jev |
| When2Call, acurácia | 72,4 | 65,6 | 81,0 | Jev |
| RAGTruth, F1 de alucinação | 79,4 | 35,6 | 76,5 | Clef |
| Observabilidade de agentes, ação principal | 68,5 | 69,8 | 71,6 | Jev |

Fonte: [model card da Cloudflare](https://huggingface.co/Cloudflare/clef).

Há uma diferença útil entre selecionar **qual ferramenta** usar e decidir
**se é hora de chamar uma ferramenta**: os testes correspondentes apontam
vencedores distintos. Também há diferença material entre Clef e Flash.
A política deve tratar os três modelos separadamente.

## Custos

| Modelo | US$ por milhão de tokens de entrada |
|---|---:|
| Jev | 0,042 |
| Clef Flash | 0,090 |
| Clef | 0,240 |

Preços publicados em [TypeSafe Models](https://docs.typesafe.ai/models) e
[Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
Para o mesmo volume de entrada, Flash custa aproximadamente 2,14 vezes Jev,
e Clef, 5,71 vezes. O custo por tarefa também depende das perguntas, imagens,
lotes, tentativas e reutilizações. Não há economia comprovada no Nexus.

## Onde o Nexus já usa Jev

O código concentra o transporte em `src/main/jev/jev-client.ts`, mas vários
consumidores verificam diretamente a presença da chave TypeSafe e calculam
custo com a tarifa Jev. Um segundo modelo precisa atravessar esses pontos.

As 14 superfícies configuráveis estão em
`src/main/jev/jev-autopilot.ts`: intake, roteamento, delegação, estado de panes,
triagem de terminal, revisão de handoff, guard de dispatch, escolha de
ferramentas, ranking, navegador, pesquisa, memória, reutilização de helpers
e contexto do modelo de negócio. Há ainda ferramentas MCP explícitas de
julgamento e ranking, além de automação do desktop.

O navegador já tem desempate de elementos, extração a partir de candidatos,
julgamento da página, seleção de trechos relevantes e um laço de ações em
`src/main/orch/tools-browser-autopilot.ts`. O desktop tem automação por
acessibilidade e OCR local em `src/main/orch/tools-computer-autopilot.ts`.
Portanto, Clef pode aprimorar caminhos existentes.

## Política inicial proposta por tarefa

Esta matriz é uma hipótese de integração, não uma avaliação concluída.
As tarefas sem evidência direta mantêm Jev até uma comparação local demonstrar
ganho. Modelos candidatos podem ser avaliados sem comandar ações do produto.

| Tarefa no Nexus | Rota inicial proposta | Comparação necessária |
|---|---|---|
| Capturas de navegador e outras decisões visuais | Clef | Qualidade visual de Clef versus Flash |
| Intake e classificação de intenção | Clef como candidato inicial | Pedidos reais, ambiguidades e intenções fora do catálogo |
| Escolha entre ferramentas e skills autorizadas | Clef como candidato inicial | Acerto da ferramenta, parâmetros conhecidos e opção nenhuma |
| Escolha de modelo, tier e especialidade | Jev | RouterBench não demonstra vantagem geral de Clef; avaliar o catálogo Nexus |
| Decisão de delegar e quantidade de partes | Jev | Divisibilidade real e falsos positivos nos hooks |
| Estado dos panes e interpretação de rastros | Jev | Evitar confundir prompt, espera, conclusão e erro; testar Flash como candidato |
| Triagem de falhas de terminal | Jev | Diagnóstico útil e encaminhamento correto; captura visual só quando necessária |
| Pesquisa e ranking de evidências | Jev | Relevância e resposta suficiente nos documentos reais |
| Revisão de handoff | Jev | Clef é candidato para checagem de afirmações, com evidências do Nexus |
| Guard de dispatch e conteúdo injetado | Jev e políticas atuais | Avaliação específica de ataques; benchmarks gerais não validam este guard |
| Memória e contexto de negócio | Jev | Seleção completa das regras e preferências, sem inventar evidência |
| Reutilização de helpers | Jev | Continuidade de contexto e custo real de evitar um spawn |
| Navegador por DOM | Jev inicialmente | Clef pode disputar escolha de alvo; medir sucesso de objetivos completos |

O operador poderá escolher modo automático ou fixar um provedor. No automático,
o roteador usa uma tabela versionada por tarefa. Não deve perguntar a outro
modelo qual modelo chamar: requisitos de imagem, política, disponibilidade e
resultados das avaliações são suficientes para a decisão em código.

Jev e Clef recebem apenas as consultas atribuídas a eles. Uma segunda opinião
entra em casos definidos e dentro de um orçamento; não é uma duplicação de
todas as chamadas. Concordância entre dois modelos não equivale a prova.

## Como estudar os vencedores no Nexus

Criar conjuntos rotulados com entradas representativas de cada superfície:
texto em português, código, saídas de CLI, DOM, screenshots e combinações de
evidências. O diário atual guarda números, não o conteúdo de entrada, então
não basta reproduzir suas linhas. Usar fixtures sintéticas ou dados redigidos
coletados com autorização específica.

Executar as mesmas perguntas contra Jev, Clef e Flash. Separar dados usados
para ajustar perguntas e limiares de um conjunto reservado para verificar
a política final. Avaliar acerto da decisão e do fluxo, falsos positivos,
falsos negativos, capacidade de responder nenhuma opção, calibração,
latência p50/p95, falhas e custo por tarefa concluída.

Promover uma rota quando ela melhorar a tarefa sem exceder os limites de erro,
latência e custo definidos para aquela superfície. Em empate de qualidade,
usar o modelo mais barato que atenda à latência exigida. Guard e efeitos
exigem critérios próprios, especialmente para falsos negativos.

Os limiares atuais não devem ser copiados para Clef como se fossem validados.
`confidence` resume uma distribuição e não prova que a ação está correta.
[Documentação TypeSafe sobre confiança](https://docs.typesafe.ai/confidence).

Uma avaliação opcional em paralelo pode comparar um candidato com a rota ativa,
mas só a rota ativa comanda o fluxo. Registrar versão da política, provedor,
modelo, tarefa, motivo da escolha, duração, tokens e custo. Resultados em produção
devem permitir desfazer uma promoção que piore o comportamento.

## Ganhos concretos com visão

As propostas abaixo são novos usos a validar. Jev é textual; Clef e Flash
têm visão. O endpoint hospedado documenta até quatro imagens embutidas,
sem aceitar URLs remotas, com limites de tamanho.
[Jev](https://docs.typesafe.ai/models),
[Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
[Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/).

1. **Confirmar resultado visual.** Depois de salvar ou navegar, verificar se
   apareceu a confirmação esperada e se há erro visível, carregamento ou modal.
2. **Desempatar elementos.** Enviar um recorte com candidatos identificados e
   pedir uma escolha entre IDs reais. Nexus continua resolvendo e acionando o alvo.
3. **Comparar antes e depois.** Julgar perguntas delimitadas sobre duas capturas,
   como mudança de estado, sobreposição ou perda de conteúdo.
4. **Avaliar renderização.** Acrescentar sinais de texto cortado, sobreposição
   e viewport incorreto aos checks mecânicos do navegador.
5. **Verificar imagens e documentos.** Classificar legibilidade, presença de
   campos e correspondência com candidatos extraídos por OCR.
6. **Ampliar o desktop posteriormente.** Usar visão quando AX e OCR não bastarem,
   preservando a autorização e os limites atuais da automação.

Uma decisão visual continua sendo uma classificação, escolha ou nota delimitada.
Ela não fornece automaticamente transcrição livre, explicação longa ou localização
arbitrária de todos os objetos. Usar DOM, OCR ou outro mecanismo para construir
candidatos quando a tarefa precisa desses dados.

A primeira integração deve reutilizar o navegador local do Nexus. Browser Run
é outro produto, com sessões e custos próprios; não é necessário para chamar
Clef. Pode ser uma evolução para pesquisa remota e jobs de QA.
[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/).

## Configuração pela interface

Proposta de uma seção **Modelos de decisão**, usando os componentes e tokens
existentes do Nexus:

- Modo: **Automático**, **Somente Jev** ou **Somente Clef**.
- No automático, mostrar a rota de cada tarefa e se ela foi avaliada no Nexus
  ou se ainda usa a regra inicial. Disponibilizar ajustes avançados por tarefa.
- Credenciais independentes para TypeSafe e Cloudflare; salvar, testar e remover.
- Para Cloudflare: Account ID, API Token e seleção de Clef ou Clef Flash nos
  modos fixos. A rota automática trata as variantes separadamente.
- Opção específica para análise de imagens, com a informação de que a captura
  será enviada à Cloudflare. Configurar um provedor não ativa esse envio.
- Histórico com provedor, modelo, tarefa, origem da rota, custo e feedback.

O REST requer Account ID e API Token. A documentação orienta criar o token
pelo template Workers AI; tokens personalizados precisam de Workers AI Read
e Edit. O teste deve confirmar uma inferência mínima, além da autenticação.
[Configuração oficial](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).

As instalações existentes preservam a configuração Jev. Ativar o automático
com Cloudflare é uma escolha do cliente. Sem a credencial de uma rota textual,
o automático pode usar a outra rota configurada, registrando o motivo. Sem Clef,
uma análise visual permanece indisponível; não enviar imagens ao Jev.

## Pontos de integração e contratos

Introduzir um serviço comum de decisões com adapters Jev e Clef, mantendo
compatibilidade com os consumidores atuais. O serviço precisa resolver a rota,
validar entrada e resposta, aplicar redação, limitar tentativas, respeitar abort
e devolver metadados de uso. Evitar uma renomeação geral dos arquivos Jev.

Os primeiros pontos são `jev-client.ts`, `jev-secrets.ts`, `jev-ipc.ts`,
`src/shared/jev-ipc.ts`, `src/shared/settings-types.ts`, `src/preload/preload.ts`,
`ApiKeysSection.tsx`, `ModuleSections.tsx` e `JevDecisionsSection.tsx`.
Os consumidores também precisam deixar de depender exclusivamente de
`hasJevCredential` e da tarifa fixa Jev.

Há incompatibilidades práticas a tratar antes de habilitar Clef nos fluxos:

- `business-model-selection.ts` pode criar 24 + 40 + 40 = 104 perguntas e
  usa IDs como `flow:...`, `inv:...` e `hurdle:...`. Clef documenta até 64
  perguntas e IDs de até 100 caracteres contendo letras, números, `_`, `.`
  e `-`. Usar lotes limitados e um mapa reversível de IDs; não apagar perguntas.
- O REST Cloudflare envolve a resposta em `result`, `success`, `errors` e
  `messages`. Normalizar antes de entregar `answers` aos consumidores.
- Validar respostas por pergunta, opções, números finitos e intervalos;
  testar instruções estruturadas, scores e respostas incompletas.
- Incluir provedor, modelo, revisão da política e hash das imagens na chave
  do cache. Invalidar resultados incompatíveis após alteração da configuração.
- Revalidar alvo, workspace, navegação e autoridade depois de cada await.
  Decisão sobre uma captura antiga não autoriza agir na página nova.
- Calcular e registrar custo por modelo; preservar custos históricos Jev.
  Tokens ausentes permanecem desconhecidos. Lotes e tentativas têm contabilidade própria.
- Guardar tokens no cofre do Main, com status mascarado pelo IPC. Revisar a
  portabilidade, cuja lista atual reconhece `jev-env:` mas não um namespace Clef.

Limites do Clef: [referência do modelo](https://developers.cloudflare.com/workers-ai/models/clef/).
Envelope REST: [referência Cloudflare](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).

## Privacidade e execução

O desktop atual declara que pixels permanecem locais. Visão remota muda esse
contrato. A primeira etapa deve capturar apenas o pane autorizado, recortar
quando possível e ocultar dados sensíveis antes do envio. Regex de redação
textual não remove segredos dos pixels.

Preservar o caráter consultivo das decisões. Política de permissões, escrita,
compra, envio, publicação e exclusão continua no Nexus. Indisponibilidade do
modelo mantém o comportamento determinístico nas triagens; um laço autônomo
sem decisão válida deve parar ou devolver o controle, sem inventar uma ação.
As restrições atuais de origem, app, alvo, operadores e workers permanecem.

## Ordem proposta de entrega

1. Serviço comum, credenciais Cloudflare, modos pela UI e contabilidade por modelo.
2. Avaliações locais e tabela de rotas com promoções graduais, preservando Jev
   nas tarefas ainda sem evidência de ganho.
3. Julgamento visual do navegador e verificação de resultado, acionados quando
   a evidência visual for útil.
4. Desempate visual de elementos, checks de renderização e evolução do desktop.

Validar cada etapa com testes de contratos, rotas, cofre, cache e falhas, além
dos testes co-localizados dos consumidores alterados. Mudanças de renderer/IPC
também exigem typecheck e renderer sinks. Testes sintéticos verificam o transporte
e a política; chamadas reais com conjuntos rotulados verificam a qualidade.

Não houve chamada de inferência paga nesta análise, alteração de credencial,
mudança no código do produto ou medição comparativa executada no Nexus.

## Evidência da implementação

A implementação preserva os consumidores Jev pela fachada existente e registra
provedor, modelo, rota, tokens, duração e tentativas HTTP. A UI oferece Automático,
Somente Jev e Somente Clef, com Clef Flash opcional. Migrações começam em Jev e a
visão começa desligada. A política automática inicial usa Clef na escolha de
ferramentas e Jev nas outras tarefas de texto; indisponibilidade de credenciais
pode escolher o outro provedor antes da chamada. Falha durante a chamada não
provoca troca silenciosa. Nenhuma rota foi promovida por resultado simulado.

O avaliador tem 18 casos sintéticos rotulados em português, com desenvolvimento
e heldout distintos, e separa respostas incorretas, falhas e visão não suportada.
Esses casos e os testes de contrato não provam superioridade em produção.
Comparação com as APIs reais depende do cadastro seguro e da disponibilidade dos
modelos na conta. Relatórios excluem state, expectativas, imagens e credenciais.

O teste de integração no Electron usou o preload real em contexto isolado e
sandbox, captura de 800×568 pixels e dois campos sintéticos. Senha e token ficaram
opacos, o sinal de sucesso permaneceu visível e o bitmap original foi preservado.
A ferramenta `nexus_browser_judge_visual` devolve probabilidades de erro, objetivo
atingido, carregamento, bloqueio humano e defeito de layout. Não executa ações.
Campos reconhecidos, frames e canvas são ocultos, mas a detecção não garante
remover toda informação pessoal de uma página. Cada consulta visual captura de
novo; não usa cache visual nem envia screenshots do desktop.

A branch foi atualizada para incluir integralmente a base 0.76.160: site, acesso,
assinatura/licença, marca e aviso de término do teste. O operador autorizou também
a nova release; os gates de assinatura, notarização e candidata continuam
obrigatórios antes da publicação.

## Comparação real inicial em 18 casos

Após cadastro seguro, os três candidatos responderam aos mesmos 18 casos
sintéticos (9 de desenvolvimento e 9 heldout), sem falhas de transporte:

| Modelo | Acertos totais | Heldout | Latência mediana | Custo observado do conjunto |
|---|---:|---:|---:|---:|
| Jev 1.13.0 | 17/18 | 8/9 | 283 ms | US$ 0,00023499 |
| Clef | 18/18 | 9/9 | 645 ms | US$ 0,00072888 |
| Clef Flash | 16/18 | 8/9 | 627 ms | US$ 0,00027333 |

A divergência foi na detecção de instrução maliciosa citada. Essa rubrica isolada
não é o guard real inteiro nem mede falsos positivos em chamadas benignas; por
isso não promovemos o guard com esta amostra. Clef mostrou vantagem de precisão,
Jev de tempo/custo, e Flash permanece uma alternativa manual. As rotas continuam
explicitamente iniciais até avaliação representativa por superfície. O relatório
local não contém state, expectativas, imagens ou credenciais.

O aplicativo instalado confirmou conexões Clef e Flash e preservou a conexão
Jev. Account ID/token foram cadastrados pela UI normal e o modo Automático foi
salvo; visão continuou desligada. Uma primeira consulta não retornou decisão,
seguida de HTTP 200 (757 ms) e testes positivos no Nexus, sem alterar credenciais.
A validação também identificou F-415, corrigido antes da entrega final.
