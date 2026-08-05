# Ticket de dívida — 6 falhas residuais de CI (pré-existentes, fora do hotfix 0.26.1)

**Data:** 2026-08-05 · **Origem:** ruling (1) do review final do hotfix 0.26.1
(`docs/analysis/2026-08-05-hotfix-0261-review-final.md`) — *document-and-defer,
não bloqueia o ship de produto*.

## O que é

Seis falhas de suíte herdadas, anteriores à fila do hotfix e fora das
superfícies tocadas (B-244/246/254, voz, aprovação, pane orq, locale,
paralelismo). O reviewer da campanha (worker 252) as identificou como dívida
pré-existente; nenhuma coincide com as superfícies do 0.26.1.

## Compromisso

- Não usar waiver silencioso: esta dívida fica REGISTRADA aqui e no gate quando
  aplicável (mesmo padrão do skip declarado da 0.20.4).
- Enumerar os 6 nomes exatos na primeira sessão de CI-triage do ciclo P1
  (responsável: próxima lane de CI; os nomes vivem no relatório do worker 252)
  e abrir um item por falha com causa-raiz ou remoção justificada.
- Critério de fechamento: `npm test` verde sem exclusões não documentadas.
