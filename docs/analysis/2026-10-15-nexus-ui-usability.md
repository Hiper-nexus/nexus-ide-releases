# Nexus: usabilidade, presença e release macOS

Pedido: tornar o produto mais fácil para pessoas sem experiência técnica,
melhorar descoberta/configuração/retomada e dar vida à gamificação, incorporando
as melhorias da versão Windows na próxima release Mac.

## Base preservada

- Candidata existente `release/mac-076273-monitor`, base Windows 0.76.272
  (`d8359c414`), com F-388 e F-389 já integrados. Não alterar o checkout principal.
- Preservar contas, missões, panes, worktrees e o app instalado do operador.
- DESIGN.md manda: identidade Pink City, ações primárias neutras, texto legível,
  motion com significado, modo sóbrio e movimento reduzido respeitados.

## Entregas e critérios de aceite

1. **Configuração por intenção.** Entrada orienta conectar IA e personalizar o
   ambiente; ações levam às telas existentes, sem duplicar credenciais ou estado.
   Busca encontra expressões comuns em português, mantém aliases técnicos e
   informa como sair de resultados vazios. Deep links continuam precisos.
2. **Orientação e navegação.** Revisar início, rail, equipe e ações de panes:
   títulos compreensíveis, próxima ação visível, hierarquia e alvos clicáveis.
   Caminhos avançados preservados, sem sobrecarregar o fluxo iniciante.
3. **Missões e retomada.** Estado e recuperação legíveis, acesso perto da missão,
   ações sem clipping em janelas pequenas. Nunca religar missão pelo renderer
   fora da autoridade do Main. Verificar fluxo com perfil isolado.
4. **Gamificação viva.** Lata reconhecível, entrada/estalo/gole com sequência
   perceptível e finita; XP verdadeiro, nada inventado. Sem bloquear entrada,
   sem repintar o terminal, sem animação fora de vista, sóbrio ou movimento
   reduzido. Validar abertura, ganho de XP, interrupção e desmontagem.
5. **Validação visual.** Capturas do renderer real em tamanhos de desktop,
   teclado, movimento reduzido, tema claro/escuro e controles acionáveis.
   Artefatos identificados como teste, não sessões reais do operador.
6. **Release Mac.** Revalidar upstream/versão, resolver os quatro bloqueios
   registrados pela auditoria 272, testes focados e completos, typecheck,
   renderer sinks, E2E, build assinado/notarizado e publicação pelo fluxo
   canônico. Não confundir candidata local com release publicada.

## Sequência

Configuração e busca → gamificação → navegação/retomada → inspeção visual →
revisão independente → gates e release. O objetivo permanece aberto até todas
as entregas estarem verificadas; concluir um componente não conclui a missão.

## Evidência inicial

- Configurações abrem em assinatura/conta; conectar IA exige descobrir outra aba.
- Busca atual compara a frase inteira com cada campo, não combina palavras.
- Lata do pane desenha corpo de apenas 13×26,4 px num SVG de 64×76 px;
  grande parte da área está vazia. Abertura já tem motion finito e XP real:
  reaproveitar esse mecanismo, não criar um segundo.

Status: implementação em andamento; sem nova publicação nesta rodada.

## Primeira onda implementada (15/10)

- F-390: entrada Configuração rápida e busca por intenção.
- F-391: lata maior e animada, respeito ao modo sóbrio/visibilidade, incluindo
  painel vazio; sequência de XP mantém fonte real.
- F-392: Missões na navegação, pendências na faixa fixa e caminho de retomada
  junto da missão no histórico e no Quadro.
- 263 testes em 18 arquivos passaram; typecheck e renderer sinks passaram.
  Revisão independente sem bloqueador após corrigir o agrupamento CSS.
- Capturas/vídeo em `release-artifacts/nexus-ui/`. Renderer real, com dados e
  fronteira de APIs simulados; não são prova do aplicativo instalado.

## Estado da candidata após a segunda onda

- F-393 implementado: menu Ações com descrições, nomes claros e preparação com
  logo/texto legível. Em 1280×420 o menu rola sem achatar/sobrepor conteúdo.
- F-394 implementado: Contas de IA usa linguagem por tarefa, entrada na conta
  destacada, instalação em lote recolhida e distinção entre instalada,
  ativada e conectada. Atalhos e mensagens usam os mesmos nomes da interface.
- Grok/OpenCode/QoS corrigidos nas provas nativas: 15 testes passaram no
  contexto normal; 13 passaram no LaunchAgent Background. Ver relatório
  `2026-10-15-native-release-gates.md`. Nenhum script distribuído foi alterado.
- Revisões independentes sem achados pendentes nos escopos de UI e testes.
- Primeira suíte completa: 28.590 passaram, 7 falharam, 103 skips declarados,
  em 516,64 s. Falhas eram os nomes antigos em testes e hashes de proveniência;
  corrigidas sem remover checks. O conjunto de follow-up teve 388 testes
  aprovados; a consistência de navegação teve 235 aprovados.
- Typecheck final passou; renderer sinks = 0. Certificado Developer ID válido
  e consulta ao perfil nexus-notary bem-sucedida (pré-check, não nova assinatura).

## Próximos gates obrigatórios

1. Suíte completa sobre as fontes finais e limpas; não alterar fontes enquanto
   ela roda. Observar o handle vivo, nunca reiniciar por timeout de observação.
2. Sanity no aplicativo isolado: Início, equipe, configurações, terminal e
   retomada; usar smokes/E2E canônicos e capturas para o que faltar.
3. Revalidar origem/versão, criar tag anotada local e executar release:mac:
   build, assinatura/notarização, E2E, smoke empacotado e publicação.
4. Conferir recibos, hashes e assets públicos do Mac; liberar o monitor.

O monitor segue consultando Windows, com revisão/publicação paralela suspensa
por `holdUntil` até 15/10 21:12 UTC. Liberar ao concluir (ou renovar se necessário).
Candidata local não é release publicada. App instalado e sessões do operador
continuam preservados. Não marcar o objetivo concluído antes desses gates.

## Inspeção nativa e terceira rodada

- A suíte final da candidata 273 passou: 28.598 testes, 103 skips declarados,
  zero falhas. Build assinado/notarizado, gate de candidato, E2E e smoke passaram.
  A tag local `v0.76.273` e os artefatos foram preservados; não houve publicação.
- O teste adicional de runtime nativo encontrou duas condições: inventário
  amostrado antes do PID de um worker aparecer e retomada involuntária de missão
  parada ao remontar/focar o terminal. F-395 cobre as guardas e a prova de PID.
- O novo relato do operador sobre + Pane entrou no escopo antes de publicar.
  F-396 remove leitura integral de histórico: 5 mil linhas custavam cerca de
  19 ms no benchmark; a cauda limitada custa menos de 0,1 ms. Isso, isoladamente,
  não prova a causa de uma espera superior a um minuto.
- A investigação F-398 encontrou a dependência de um futuro `syncPanes` para
  apresentar o painel main-owned aberto dentro da missão. A correção deve
  apresentar após o registro durável, validando o workspace atual do renderer.
- F-397 alinha o guia inicial aos menus atuais e evita prontidão contraditória.
  Preview em `release-artifacts/nexus-ui/onboarding-final.png`.
- Próxima candidata: 0.76.274, preservando a 273 para rastreabilidade. Antes de
  publicar, repetir gates sobre fontes finais, teste nativo de missão/retomada
  e soak. O aplicativo instalado do operador não foi reiniciado nem substituído.

## Validação da 0.76.274 antes do pacote

- 417 testes focados em 12 arquivos passaram; typecheck passou e renderer sinks = 0.
- Suíte ampla: 28.635 passaram, 103 skips declarados e duas falhas em
  `MissionSetup.test.tsx` (contagem global de qualquer botão Conectar, incluindo
  o atalho novo do checklist). Nenhuma outra falha em 2.214 arquivos.
- Ajuste exclusivamente de teste: contar os botões dos dois avisos de conexão,
  preservando a asserção de uma única ação e a ausência do aviso genérico quando
  há um específico. O arquivo inteiro foi repetido: 94/94 passaram. Código de
  produção permaneceu idêntico ao exercitado na suíte ampla; não se declara
  exit zero para aquela invocação ampla.
- F-395 a F-398 têm regressões e revisão independente sem bloqueadores.
- Limite de F-398: prova espera pela apresentação; não reproduziu em hardware
  o minuto relatado em todas as IAs. A adoção após a apresentação ainda passa
  pelos gates usuais. Não atribuir a esse defeito o timeout MCP de prompt.
- Próximo: pacote assinado/notarizado, gates nativos e publicação canônica.

## Resultado nativo da 274 e candidata 275

- Build 274 passou assinatura/notarização, gate de candidata e E2E. A prova de
  estabilidade de cinco minutos passou, com saída física limpa e heaps sem
  crescimento persistente. A 274 permanece uma candidata local não publicada.
- A captura do navegador bloqueou por uma chamada do Chromium ao Keychain no
  perfil de teste. Confirmado por amostra nativa de SecItemAdd e pela repetição
  do MESMO app assinado com `--use-mock-keychain` somente no harness privado.
  O navegador, a captura, os handoffs e os ACKs então passaram. Nenhuma
  configuração do aplicativo instalado ou Keychain do operador foi alterada.
- O próximo passo do teste encontrou F-399: anúncio ao pane recém-promovido
  usava injeção bruta assíncrona, sem esperar prontidão/aceite. O transcript
  contém apenas 1.023 bytes do anúncio e nenhum comando IDLE; ainda assim a
  direção seguinte foi considerada aceita por observar o turno do anúncio.
- A 275 deverá aguardar a entrega comprovada do aviso antes de devolver a
  criação da missão. Preservar falha de aviso sem desfazer a promoção e manter
  as cercas de escopo/sessão. Não reutilizar os artefatos 274 para esta alteração.

## Fontes finais da 275

- F-399: 312 testes em quatro arquivos passaram; a revisão separou o workspace
  exibido da autoridade física durante a entrega. Trocar de projeto não encerra
  o líder da missão original. Tipos, metadados e renderer sinks passaram.
- A confirmação do aviso integral e do comando seguinte em turnos nativos
  distintos continua obrigatória antes de publicar.
