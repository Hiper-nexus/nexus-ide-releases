# Disposições explícitas da 0.76.192

Itens do inventário (`docs/analysis/2026-10-04-release-076192-handoff/PEDIDOS-E-MELHORIAS.md`) que a
auditoria de requisitos da release (Codex gpt-6.1-sol, somente leitura, 04/10) classificou como
medição ausente, comportamento de agente sem prova automatizável ou registro só documental. O
handoff do operador proíbe fabricar benchmark, preço ou métrica de uso; por isso cada item recebe uma
disposição verificável em vez de um "feito" sem prova.

Legenda: **Fora desta release** = não entregue, motivo e o que falta; **Documental** = a entrega é o
próprio documento ou ação histórica; **Campo** = só se prova no app assinado (roteiro de smoke).

| Item | Disposição | Evidência atual | O que fecharia o item |
|---|---|---|---|
| 04/D, D2 — ranking medido em vez de fixture | Fora desta release | `resources/model-ranking.json` continua fixture rotulada; `task-router-quality.test.ts` prova que a fixture não é tratada como medição | Executar uma rodada de benchmark do Nexus por CLI/modelo com tarefas fixas e publicar o resultado com data e método |
| 04/D1 — matriz modelo/esforço por especialidade | Fora desta release | `resources/mission-specialty-benchmark.json` vazio por decisão; `specialty-benchmark.test.ts` prova que vazio não inventa especialidade | Mesma rodada acima, por especialidade |
| 07/experimento — Nexus × CLI direta, mesma tarefa/modelo/credenciais | Fora desta release | Nenhum artefato completo; controles C6 por CLI provam admissão, não comparação de qualidade | Experimento controlado com protocolo escrito, N tarefas, mesmas contas, resultado bruto anexado |
| 2g, 05/2 — consultar registro/recusar deprecated/pin efetivos | Campo | Carta de engenharia e stack-advisor empacotados (`engineering-charter.ts`, `stack-advisor-manifest.ts`), sensor N9 consultivo | Observar um agente real decidindo stack no app: consulta ao registro e pin registrados no draft |
| N8, 05/3 — decisão de stack por draft → review → apply | Campo | Brief v3 aponta o draft canônico; round-trip testado (`guided-greenfield-brief.test.ts`) | Fluxo real draft → review → apply no app assinado |
| 2k — uso efetivo de todas as skills/tools/squads | Campo | Roteamento por skill e journal de tools implementados (`jev-skill-suggestion.ts`, `mcp-dispatch.ts`) | Telemetria de uso real após a release; não é provável por teste |
| 2h, 2i — autonomia/Jev/Clef usados de verdade | Campo | Mecanismos cobertos por teste (fair-share, juiz, ACK) | Qualificação operacional com missões reais |
| 03/2, 5 — troca de conta/CLI no meio da tarefa | Campo | `failover-cli-switch.test.ts` cobre religamento e pacote de continuidade | Cenário com duas contas reais esgotando; não invalidar logins para simular |
| 1, 2a, 2b, 2l, 2m | Documental | Análises 01–08 e PLAN em `docs/analysis/2026-10-04-release-076192-handoff/fontes/` | Nada além do registro |
| B7 — uma causa por item QA | Documental | `docs/qa/items/F-802.md`, `F-815.md` e os novos F-904 a F-914 | Nada além do registro |
| Mem/passo 11 — backfill dos 26+8+24 históricos | Campo | Rotina idempotente testada (`workspace-memory-backfill.test.ts`, `native-memory-import.test.ts`) | Execução pela autoridade do operador no app, preservando proveniência |
| Mem/passo 6 — esquecer os 6 recibos vazios existentes | Campo | Migração testada em banco sintético | Abrir o app novo sobre o banco real e conferir |

Os itens de código que a mesma auditoria apontou (alerta Mem12, escritor `resolved-problem`, teste
`operator-decision`, `maxContext`, preço `gpt-5.6-sol`, grafo com 20 helpers, Muse, AGY, F-907 e
F-908) receberam correção nesta release; ver `docs/qa/items/F-904.md` a `F-914.md`.
