# Pendências verificadas da release — 03/10/2026

Atualização após `0fdc3629`. A integração das entregas existentes está feita;
há correções e critérios de aceite pendentes. **Esta integração ainda não foi
empacotada nem publicada.** O harness de carga/CI mantém quatro arquivos WIP.

## Estado atual

| Pendência | Evidência e próximo passo |
|---|---|
| Análise dos terminais sob carga | Carga perdeu análise aos 16 s mesmo passando os limites numéricos. Regressão determinística confirmou timeout falso quando Worker termina em 20 ms e Main recebe confirmação após 350 ms. F-863 usa progresso atômico preservando limite real de 250 ms; ainda validar análise em timer e ausência verdadeira de ACK. |
| Controle após EOF | Carga instrumentada teve todos os barriers de bind/carga verdadeiros; após morte física, controle reenfileirado para sessão já descartada perdeu ACK. Fechar essa cauda, conservar evidência arquivada e repetir carga normal e envenenada. |
| Fila pesada nativa | Broker MCP e Native integrados. Dez suítes/185 testes, tipos/sinks/ratchet e 16 testes do supervisor passam. F-856 continua aberto: CLIs não-Node com shell absoluta precisam transporte/admissão reais comprovados. |
| Prova de descendentes MCP | PG não prova filho que fez setsid/reparent nem container após cliente OCI sair. Reutilizar coorte autenticada Darwin, modo que conserva background até término natural, namespace PID Linux e identidade privada exata OCI. |
| União completa | Revisão independente, matriz atualizada, suites completas app/server, instalação privada limpa, segurança/SBOM/licenças e módulos nativos. Testes focados não substituem esta etapa. |
| Candidato e publicação | Conferir versão/tag, gerar DMG/ZIP assinado/notarizado, release:candidate, probes de 40 s/ocupado após renderer montado, fluxos reais, recursos por cinco minutos e quit sem órfãos. Publicar e validar canônica/espelho, hashes, recibos e download. |

Já integrados desde o registro abaixo: C.3/harness de regex, C.4/follow-ups
periódicos, MiMo fora do Main e quatro correções da revisão, N9 consultivo,
N7 com atribuição UUID e bugs visuais, N13 autorizado, probe de 40 s e probe
da faixa real de ocupado. F-864 corrigiu leitura curta do manifesto; F-862
agora drena shims/comandos antes do host/stores; F-865 aguarda a Promise de
morte física do host. Cinco suítes/87 testes, tipos/sinks/ratchet passam;
contagens se sobrepõem às anteriores e não se somam.

Aceite de carga ainda exige SHA final, 15 terminais e pelo menos 5 MB/s,
barriers e evidências finais corretos, p99 <100 ms, bloqueio máximo <1 s e
bloqueio de spawn <100 ms. O teste antigo e seus números não provam a release.
A tag local v0.76.191 segue apontando para commit antigo; não reescrever tag.
Autorização de integração completa e novas raízes .noindex já está vigente.

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
