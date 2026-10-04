# Pendências verificadas da release — 04/10/2026

Atualização após `55691a0d`, com todas as entregas existentes integradas e
metadados de **0.76.192** preparados. **Ainda não há aplicativo, DMG ou ZIP
assinado/notarizado desta integração, nem publicação.**

## Estado atual

| Pendência | Evidência e próximo passo |
|---|---|
| Carga F-764 no conjunto final | Cargas anteriores de 30 s, normais e envenenadas, passaram; falta repetir no SHA final, com 15 terminais, ≥5 MB/s, conclusão semântica, p99 <100 ms, máximo <1 s e bloqueio de spawn <100 ms. |
| Fila pesada nativa C.6 | Supervisor A/B autenticado, warmup Main, launcher compatível com sandbox interno e proxy herdado já integrados. Claude, Grok e Kimi reais têm provas privadas e gates Root aprovados. O OpenCode2 exige backend privado por pane (`--standalone`), já provado no controle, mas o transporte de admissão ainda está em correção. A matriz restante de CLIs continua em fechamento. |
| Revisão independente composta | Achados F-883..F-890 receberam correções e testes focados. O parecer composto aprova os deltas examinados de F-883..F-888/F-890 e native. F-889 também recebeu revisão independente: 224 testes/7 suítes, com os módulos idênticos à integração. Os transportes nativos novos ainda precisam de revisão própria. A aprovação antiga não certifica o SHA atual. |
| Teste de recursos por cinco minutos | Harness integrado em 55691a0d e aprovado por revisão independente de fonte. Gate privado Root: 172 testes/13 suítes, tipos/sinks/Sync aprovados. Ainda precisa executar os 300 s no aplicativo assinado; fixtures não comprovam essa execução. |
| Validação completa final | Instalação privada limpa passou. A suíte completa histórica em `6e968c1e` passou: 1.847 suítes/21.545 testes, com 4 suítes/53 testes ignorados. Falta a suíte no conjunto final, tipos app/server, segurança/audit/SBOM/licenças e matriz de 104 requisitos atualizada. |
| Fluxos reais do candidato | O smoke existente verifica preparação/listagem de missão, mas não início/stop de ops/standard com workers/handoff/recovery/movimento. O smoke também nega microfone; isso não prova start/stop de voz. Está em levantamento o caminho mínimo de verificação privada dessas obrigações do checklist, sem login/perfil do operador ou alteração de permissões. |
| Candidato e publicação | Criar a tag no SHA exato validado, gerar DMG/ZIP assinados/notarizados, executar release:candidate, probes de 40 s e aviso ocupado, fluxos reais, recursos por cinco minutos e quit sem órfãos. Publicar pelo script canônico, que integra main/tag na transação, e verificar canônica/espelho, hashes, recibos e download. |

N4/F-833 está corrigido no código e aprovado por revisão independente em
`32568689`: cauda Main sanitizada, preservação dos artifacts completos e
recibo físico novo sem afrouxar a cadeia original. N13 está autorizado e
implementado para novas pastas `.noindex`, preservando as existentes.
C.3/C.4, MiMo fora do Main, N7, N9, memória e demais integrações já estão no
conjunto. Não somar contagens dos testes focados, pois se sobrepõem.

A matriz de 104 requisitos em `.superpowers/sdd/PLAN/coverage-current-final.md`
é um mapa de proveniência; deve receber as evidências e a revisão final.
A tag local `v0.76.191` é histórica e não será reescrita. O estado remoto
precisa ser conferido novamente antes da tag `v0.76.192`.
O preflight de Developer ID e do perfil `nexus-notary` passou; não equivale
à assinatura ou notarização de um artifact.

## Histórico — observado às 18:43 BRT, superado pelo estado acima

Base da integração examinada: `40c56c20`, com a fila de comandos pesados ainda
não commitada. Este registro descreve o estado observado, não substitui o
checklist de aceite nem a revisão independente final.

## Implementação e integração ainda necessárias

| Item | Estado observado | O que falta |
|---|---|---|
| F-764 C.6 — fila de comandos pesados | Pool e classificador locais passam em 23 testes. `acquireHeavyCommandPermit` ainda não tem chamador de produção. | Ligar `nexus_terminal_run` e `nexus_bg_run`, e os compiladores iniciados pelas CLIs; provar fila por projeto, reserva de RAM, cancelamento e liberação apenas após saída física. Validar também o orçamento de workers no fluxo real. |
| F-764 C.3 — regexes | Artefato `/tmp/nexus-f764-c3-regex.json`: 21 manifests, 205 regexes, 1.565 casos, 105 casos de paridade; máximo 8,098 ms. Patch/harness ainda na worktree do executor. | Revisar e integrar correções e harness reproduzível; levar a prova para a árvore final e o CI. |
| F-764 C.4 — tarefas periódicas | Grande parte integrada. Revisão encontrou cancelamento não propagado até o rename assíncrono dos agendamentos e trecho de whitespace sem checkpoint. | Integrar o follow-up do executor; os 45 testes informados por ele ainda precisam acompanhar o commit recebido. |
| MiMo fora do Main | Commit do executor `75447127` disponível, com worker SQLite e 27 testes; ainda não integrado. | Revisar/integrar, concluir parada física do serviço de uso e aguardar sua inicialização no Main; validar união com os scanners Claude/Codex já modificados. |
| N9 — frescor de dependências | Sensor consultivo ainda ausente no código final. | Implementar e testar leitura limitada de metadados públicos, dependência obsoleta/deprecated e comportamento offline sem bloqueio nem atualização automática. |
| F-764 A.1 — prova de 40 segundos | `SMOKE_HANG_PROBE_BLOCK_MS` ainda vale **6.000**, e o harness verifica captura de profile, sem exigir recuperação após 40 s. | Atualizar o indutor e a verificação para o critério de 40 segundos, com prazo suficiente para o restante do smoke. Depois executar no app assinado. |

## Validação do candidato completo ainda necessária

- Repetir o teste de carga no SHA final: 15 PTYs, flood de pelo menos 5 MB/s,
  supervisor e spawn concorrentes. A evidência guardada é do SHA `0d859fc4`,
  com host simulado: p99 5,874 ms, máximo 101,696 ms, bloqueio de spawn
  12,074 ms. Ela não prova o candidato final nem a equivalência do host nativo.
- Incorporar os casos de falha do worker de análise e conferir que o harness
  de carga participa do CI com os limites de aceite.
- Revisão independente do diff completo e correção dos achados. Os testes
  focados e revisões parciais não substituem essa revisão.
- Instalação limpa e validação completa de app e server; segurança, auditoria,
  SBOM, licenças e módulos nativos. Typechecks e renderer-sinks focados já
  passaram, mas a matriz final da release ainda não foi executada.
- Reconciliar todos os itens da revisão antiga e N1–N14 com evidência final.
  B7 documental foi fechado em `e6970f5b`, após 8 suítes/242 testes; os registros
  históricos F-769/F-778 apontam para os itens individuais F-839–F-846.

## Build e publicação ainda necessários

- Atualizar notas da release e conferir versão/tag no SHA final. A tag local
  `v0.76.191` aponta para o commit antigo `6050422d`, não para esta integração.
  Não mover nem publicar tag sem revalidar o estado remoto canônico.
- Integrar conforme o gate do repositório e gerar DMG/ZIP em ambiente privado,
  com assinatura e notarização. **Esta worktree ainda não tem `out/`.**
- Executar `release:candidate`, smoke de launcher/terminal/missões/recovery/
  encerramento, probe de 40 s, aviso de ocupado e observação de recursos por
  cinco minutos no binário final.
- Publicar pelos scripts canônicos, conferir canônica e espelho público,
  recibos, hashes e download. Não há comprovação de publicação desta integração.

A autorização do operador para novas raízes `.noindex`, preservando as
existentes, já foi aplicada em `01ff8882` e não está pendente. O handoff visual
foi integrado em `5851aa49` e `40c56c20`; ambos ainda participam da revisão
conjunta e do smoke final.
