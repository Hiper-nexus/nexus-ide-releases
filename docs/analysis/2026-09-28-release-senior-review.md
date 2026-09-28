# Revisão sênior da candidata macOS após 0.76.117

O operador pediu a revisão durante a publicação. A 0.76.117 terminou de publicar antes da interrupção; foi recolocada em rascunho nos dois repositórios. Código/artefatos dessa tag não serão substituídos. As correções entram em versão posterior.

## Evidência anterior

Commit 517437fe: CodeRabbit da correção F-185 sem achados após dois ajustes; 1.586 arquivos/17.028 testes verdes (10 skipped) fora da cadeia de responsabilidade do pane, 157 testes do servidor, typecheck e gate de candidata assinado/notarizado com smoke PASS. Isso não substituiu a revisão sênior do diff completo pedida depois.

## Revisores

- CodeRabbit, diff v0.76.114..517437fe: quatro apontamentos.
- Claude sênior: 63 arquivos de runtime lidos com callers, 150 testes focados; sem achados críticos/altos, quatro observações baixas e limites.
- Kimi sênior: memória/contexto/scanner/regression-gate, 202 testes e typecheck; sem bloqueadores, três observações baixas.

## Tratamento

| Apontamento | Decisão e evidência |
| --- | --- |
| Limpeza prosseguia após erro de lstat/readdir | Corrigido F-663. Só ENOENT é tolerado; falhas de inspeção nunca chegam ao rm recursivo. Quatro testes RED→GREEN sync/async. |
| Remoção da própria junction com force:false falhava após sucesso | Corrigido F-663. O helper informa que já removeu a raiz-link e não tenta apagá-la outra vez. Dois testes preservam o alvo. |
| Falha de vínculo depois do respawn impedia watcher/redelivery | Corrigido F-664. Aviso explícito e continuação do acompanhamento do runtime já aberto; watcher reconcilia o vínculo e uma nova retomada reconcilia antes de selecionar a conversa. Teste injeta erro após spawn e retoma a partir do pane novo. |
| Instrução de conclusão omitia nota mínima | Corrigido F-185. A instrução explicita os 40 caracteres já exigidos pelo handler. |
| Documento Seatbelt citava captura de tela | Corrigido texto F-410, sem alteração do sandbox. |
| Layout canônico com zero folhas não mostrava recuperação | Descartado: LayoutNode não aceita null; buildGridTree([]) cria uma folha shell e fechar o último pane mantém placeholder. O fixture proposto com root:null era inválido no typecheck e no runtime, não uma reprodução do fluxo. Os testes de missão sem panes visíveis passam em grid/canvas. Nenhuma mudança no renderer. |
| Pedido de conclusão em memória se perde no restart | Comportamento seguro documentado no F-185: o líder retomado recebe a instrução e repete o pedido após conferir a entrega. Não se usa texto editável como autoridade. |
| Memória em MCP e no briefing | Mantido: memória estável de MCP e recall da tarefa são canais distintos; o pane promovido precisa conservar o contexto (F-176). A revisão não demonstrou duplicação idêntica no fluxo vivo. Suprimir por missionId reintroduziria a perda que motivou F-176. |
| Consulta de memória por prompt antes de deduplicar | Intencional no F-177: a consulta precisa ver memória nova e a tarefa atual antes de comparar o bloco entregue. Sem regressão de desempenho medida; não se restaura o bloqueio global de 30 min. |
| Evidências longas cortavam resumo destilado | Corrigido F-180 com reprodução no teto válido do schema; conteúdo útil fica antes de metadados. |
| Oferta de migração do Kimi engolia briefing | Corrigido F-186 após relato ao vivo e transcript. A colagem aguarda o composer; não migra nem altera o perfil real. |
| Claude instalado não detectado / npm EEXIST no Mac vizinho | Corrigido F-210: descoberta de versão nativa válida após link quebrado/ausente, instalador nativo primeiro e prova pós-instalação. Relato atualizado do operador: comando também não encontrado no Terminal. Sem remoção forçada de launcher nem mutação de credenciais pessoais. |

A rechecagem do vínculo corrigido terminou no CodeRabbit sem achados. A candidata 0.76.120 consolida estas mudanças e a retomada F-665 e o acesso restrito do Codex F-666 integrados de origin/main (canais Windows 0.76.118/119). No macOS o code-mode host governado continua desligado. Os resultados de testes completos, smoke empacotado, assinatura e publicação desta candidata ficam nos recibos em release-artifacts/; este documento registra a revisão de código e não substitui esses recibos.
