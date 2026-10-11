# Motor de decisão em toda missão (Jev, Clef, Luna)

Pedido do dono (10/10/2026): Jev, Clef e Luna presentes em toda missão, convencional e +pane, do início ao fim, reduzindo custo de token, melhorando a qualidade do código e acelerando o desenvolvimento. O motor escolhe a melhor API, ou várias juntas quando vale a pena.

## Doutrina

- **Fail-open sempre.** Falha, demora, falta de credencial ou orçamento esgotado viram `null` e a surface segue pelo caminho determinístico atual. O motor nunca bloqueia um agente ([[nexus-agentes-sem-amarras]]).
- **Escolha explícita do operador vence.** Os modos `jev`, `clef`, `luna` e `together` continuam exatamente como hoje. O motor custo×qualidade só decide no modo `auto`.
- **Consentimento não é roteável.** Imagem e áudio só vão a quem tem a autorização correspondente.
- **Limiares calibrados ficam onde estão.** dispatchGuard, handoffReview, memoryDistill, computerTool e browserTool continuam fixos no Jev. Trocar de modelo ali muda a semântica.
- **Toda nova surface de fase é consultiva.** Ela produz uma dica registrada na missão, nunca um bloqueio.

## Fase 1 — fundação (F-1164, F-1165)

**F-1164: livro de decisão por missão.**
- `missionId` chega ao `judge` em todas as surfaces de missão: intake, delegation, paneState e handoffReview, que hoje não passam.
- `DecisionBudgetLedger` por missão, em memória, reconstruído a partir do diário.
  - Reserva o custo estimado antes da chamada e acerta pelo recibo real depois.
  - Não estoura com chamadas em paralelo.
- Orçamento por missão configurável, com padrão de US$ 0,50.
  - Acima de 80% do orçamento: só o modelo mais barato elegível, sem ensemble.
  - Em 100%: `noAnswer('budget')`.
- Estatísticas por missão em `jevDecisionStats` (`byMission`).

**F-1165: roteador custo×qualidade (policyVersion 2, só no modo `auto`).**
- Cada surface tem um perfil de necessidade:
  - modalidade: texto, imagem ou áudio;
  - criticidade: segurança, reversível ou normal;
  - orçamento de latência.
- Os candidatos são os provedores com credencial que atendem a modalidade.
- Pontuação: `qualidade(surface, modelo) − λ·custo`.
  - A qualidade vem de uma tabela gerada por `evaluateDecisionCases` e persistida em userData. A Luna entra na avaliação.
  - Sem tabela, valem priors embutidos.
- Variante Cloudflare por necessidade, em vez de sempre `clef`, que é a mais cara:
  - texto barato vai para `clef-flash`;
  - imagem vai para `clef-omni`, mais barato que `clef` com imagem;
  - `clef` fica para quando o prior de qualidade justificar.
- **"Usar várias":** ensemble só em surfaces de segurança ou reversíveis, com dois ou mais provedores disponíveis e o orçamento abaixo do limiar suave. As chamadas são paralelas, então a latência é a do mais lento.
- A rota grava `policyVersion`, `evidence` e `reason` explicando a escolha.

## Fase 2 — presença em todo o ciclo (F-1166)

Novas surfaces consultivas, comuns às missões convencional e +pane:

- **`missionKickoff`:** no bootstrap da convencional e em `createPaneMissionFromRenderer` da +pane. Avalia a complexidade e sugere número de workers e lane.
  - A dica fica no snapshot da missão e o orquestrador a lê pelas ferramentas de status.
  - Na +pane, cobre o intake que hoje é pulado.
- **`reviewTriage`:** quando um handoff de código chega. Mede o risco de regressão e recomenda revisão independente se o risco for alto.
- **`recoveryAdvice`:** em falha ou queda de worker. Responde se é melhor repetir a mesma CLI ou trocar.
- **`completionCheck`:** antes de concluir. Avisa se os handoffs não cobrem o objetivo.

## Fase 3 — interface (F-1167)

- **Configurações:** chave "Motor de decisão em toda missão" (ligada por padrão no `auto`), orçamento por missão, e explicação de que a escolha explícita de modelo continua valendo.
- **Painel da missão:** gasto de decisão da missão (US$, chamadas por provedor), dicas das surfaces de fase e a rota de cada decisão.

## Fora de escopo nesta onda

- Teto real de tokens dos agentes CLI: o `cost-tracker` é heurístico.
- Trocar o modelo das surfaces fixas no Jev.
