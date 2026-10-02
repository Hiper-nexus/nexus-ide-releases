# Jev e Clef no Nexus × o que o vídeo mostra do Overclock (02/10/2026)

## Fonte e cautela

A base é a transcrição de um vídeo de um criador de conteúdo sobre o Overclock.
Tudo o que segue sobre o Overclock é **o que o vídeo mostra**; não rodamos o produto
dele lado a lado. Os números de velocidade e custo do Jev ("20 a 200 vezes mais
rápido, 40 a 400 vezes mais barato") são afirmações de quem lançou o modelo, não
medições nossas. As demos de terceiros (Minecraft, Android, aldeia de 200 IAs) são
usos do Jev em outros produtos e ficam fora do escopo de uma IDE.

## O que o vídeo mostra

1. O Jev é um modelo de decisão, não de conversa: escolhe entre opções, dá nota ou
   responde sim/não, e devolve probabilidade por opção e confiança.
2. No Overclock (plano Ultra, dentro de missão agêntica) ele decide quatro coisas:
   **conta** a usar ao abrir um terminal, **linha da tabela de harness** (CLI, modelo,
   esforço, skills), **missão por nome** quando há duas parecidas, e **elemento do
   navegador**.
3. Cada decisão tem recibo: quem decidiu, a confiança e o que a regra teria
   escolhido; na dúvida a regra volta a decidir.
4. Configurações → Decisões: chave, interruptor por decisão ou "tudo pelo Jev", e
   consumo (consultas, custo, sem resposta, hoje e em 30 dias).
5. Custo e latência medidos pelo autor: 400 a 650 ms, cerca de US$ 0,02 por mil
   decisões, via OpenRouter.

## Comparação, ponto a ponto (Nexus verificado no código)

| Ponto | Overclock (no vídeo) | Nexus | Veredito |
|---|---|---|---|
| Alcance | 4 decisões, só em missão agêntica | 17 superfícies de decisão (`JevSurface` mais `judgeTool`, `rankTool`, `computerTool`), em missão e no "+ Pane" do operador | Nexus à frente |
| Provedor e custo | Jev via OpenRouter, crédito na chave | Jev direto na TypeSafe, US$ 0,042 por milhão de tokens de entrada, saída grátis (`jev-pricing.ts`); medido aqui: mediana de 283 ms | Equivalente, com um intermediário a menos |
| Escolha de conta | O Jev escolhe entre contas que a regra aceitaria | **Decisão deliberada de não usar o Jev**: a regra de folga compara cota medida, que é aritmética (AGENTS.md); o recibo traz folga medida e alternativas com o motivo de cada perda, e agora aparece no cabeçalho do pane | Regra mais precisa que um modelo; recibo mais rico |
| Linha da tabela de harness | O Jev escolhe a linha | O Jev classifica tarefa, especialidade, esforço e skill numa chamada só, cada dimensão aceita só com confiança ≥ 0,6; a rota sai de tabela + benchmarks oficiais + diversidade + fair-share + cota | Nexus à frente |
| Recibo da decisão | Quem decidiu, confiança, o que a regra teria escolhido | **Antes** faltavam a confiança e o contrafactual. **Agora** o recibo e o chip do pane trazem a confiança por dimensão e "a regra teria escolhido X" | Fechado nesta versão |
| Missão por nome | O Jev desempata; na dúvida, lista | **Antes** era um bug: `includes` e, sem match, abria a primeira missão em silêncio. **Agora** resolvedor puro, Jev no desempate, e pergunta quando não há certeza; nome mal reconhecido pela voz também é tratado | Fechado nesta versão, e mais seguro |
| Navegador | O Jev escolhe entre os elementos mostrados | Busca e clique por nome acessível, Jev desempata de 2 a 5 candidatos com confiança ≥ 0,7, loop `nexus_browser_do` com confirmação humana no que é irreversível, extração tipada, julgamento visual opcional | Nexus à frente |
| Painel de consumo | Consultas, custo, sem resposta, hoje e 30 dias | O mesmo, mais "desde sempre", por superfície, por provedor, e botão Certo/Errado em cada decisão | Nexus à frente |
| Interruptores | Por decisão e "tudo pelo Jev" | Mestre, por superfície (settings e variável de ambiente) e modo Automático / Somente Jev / Somente Clef | Nexus à frente |
| Queda do serviço | A regra decide | Falha aberta em todas as superfícies, cache negativo de 20 s no digest de pane, limite por sessão, redação de segredos antes de sair | Equivalente ou melhor |

Pontos que o vídeo não menciona e o Nexus tem: guarda de despacho (coerência com o
objetivo, injeção e irreversibilidade), revisão da evidência dos handoffs, memória
destilada do projeto, estado e triagem de pane, e `nexus_computer_do` no desktop do
macOS.

## O Clef

O vídeo não fala de um segundo modelo. O Nexus tem o Clef (Cloudflare) como
complemento: visão opcional no navegador (com máscara parcial, perfil pessoal
recusado e consentimento explícito), escolha de ferramenta no modo Automático, e
fallback de texto quando falta a chave do Jev. Avaliação local inicial, 18 casos
sintéticos em português: Clef 18/18, Jev 17/18, Clef Flash 16/18; latência mediana
645 ms contra 283 ms. Amostra pequena. As superfícies que concedem efeito ficam
sempre no Jev.

## Onde estávamos atrás e o que esta versão fecha

1. **Missão falada.** Falha real, não só falta de recurso. Corrigida, com o Jev no
   desempate (confiança ≥ 0,7 e margem ≥ 0,15) e no caso "nada casou" (confiança ≥ 0,90
   e margem ≥ 0,30; medido com 38 chamadas reais: acertos de erro de voz ficaram em
   0,94 ou mais).
2. **Recibo sem confiança nem contrafactual.** O recibo da rota e o chip do pane trazem
   a confiança por dimensão e o que a regra teria escolhido.
3. **Recibo de conta só para o agente.** Agora a pessoa vê, no pane, qual conta foi
   escolhida e por quê.

## Escolhas deliberadas

- Não pôr o Jev para escolher a conta. A decisão de folga é uma comparação de
  números medidos; um modelo só acrescentaria variância. Fica registrado em AGENTS.md.
- Não copiar as demos de Android, Minecraft e simulação social.

## Limites honestos

- O Jev exige a chave TypeSafe de quem usa. Sem ela o Nexus funciona pela regra,
  como antes.
- O Clef foi exercitado com simulações e 18 casos sintéticos; nada foi validado em
  produção contra a Cloudflare real, e as rotas automáticas dele são iniciais.
- A medição da missão falada tem 38 chamadas, só em português e com títulos
  sintéticos, sem pedidos reais.
- Não há comparação lado a lado com o Overclock rodando.
