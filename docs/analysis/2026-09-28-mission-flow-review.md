# Revisão dos fluxos de missão a partir do + Pane — 28/09/2026

Pedido: preservar a liberdade de trabalhar por panes, permitir missões paralelas e tornar recuperação e navegação diretas. A missão é organização do trabalho do pane, não motivo para substituí-lo ou encerrar os demais.

## Achados corrigidos

- **F-175, alta:** a Via Rápida tratava toda a aplicação como uma única missão focused. Iniciar, retomar ou reconciliar B estacionava A e matava seus PTYs. Removido o singleton e a exclusão entre missões; cada execução continua limitada pelo próprio estado/contrato e pelo controle de processos existente.
- **F-366, alta:** Terminais sem panes era um destino sem recuperação. Uma missão sleeping aparecia como “Precisa de você” no header. Agora a superfície mostra o estado canônico e uma ação primária: Retomar missão, Reabrir terminal ou Responder no Quadro, conforme o caso. Sem menus extras, novo squad ou missão substituta.

O marcador da missão relatada era `leftover`, não `unfocus`. Isso prova o estacionamento persistido, mas não identifica sozinho o evento original. A revisão encontrou e removeu um caminho reproduzível que também encerrava outras missões. Não confundir esse achado com prova forense de todos os encerramentos anteriores.

## Percurso revisado

| Fluxo | Resultado / contrato | Evidência principal |
|---|---|---|
| Abrir IA no + Pane | A sessão continua sendo do operador; promoção só se necessária ou solicitada | `pane-mission-promote.ts`, testes de renderer-mission-authority |
| Primeiro helper do operador | Missão do grupo do pane; ownGroup impede roubar a coordenação de outro pane na mesma aba | `renderer-mission-authority.ts`, testes de adoption |
| Criar missão da aba / tornar orquestrador | Reusa a missão da aba e o pane indicado; Main confirma a promoção | `pane-mission-promote.test.ts`, authority-binding/adoption |
| Missão via MCP em Autopilot | Contrato despachado livre, sem squad imposto; pane tem saída de blocked e recupera a mão ao finalizar | `mcp-dispatch-security.test.ts` (F-649/650/651) |
| Nova missão pelo formulário | Bootstrap continua canônico; iniciar não estaciona mais as irmãs | `mission-fast-lane.test.ts`, leftover-isolation |
| Trocar aba / abrir Terminais | Filtra apresentação, não encerra hosts de outras missões | `TerminalWorkspace.test.tsx`, `mission-terminal-panes.test.ts` |
| Iniciar / retomar / reconciliar em paralelo | Todas as missões com líderes vivos continuam, inclusive sem squad | F-175, leftover-isolation e respawn-redelivery |
| Missão bloqueada sem terminal | Ação direta no próprio destino, erro inline e retry; chamada canônica confirma sessão | F-366, `MissionTerminalRecovery.test.tsx`, mission-reopen |
| Retomar missão originada em pane | CLI, modelo, conta, esforço e conversa gravada do líder; não inventa Maestro do squad | F-661 existente, `operator-tab-mission-resume.test.ts`, respawn-redelivery |
| Pergunta real / pedir ajuste | Pergunta exige resposta; ajuste não dispara a first-wave antes de receber orientação | recovery, engine-resume-reopen, fast-lane-adjustment-hold |
| Encerrar / remover / concluir | Ações distintas: parar processo, apagar histórico, aprovar entrega. Encerrar explícito prevalece sobre spawn atrasado | mission-runtime-termination, close-mission-runtime, mission-list-action |
| Mudar de workspace durante recuperação | Main conserva escopo; renderer não apresenta panes no projeto errado | mission-reopen, mission-pane-presentation, orch-store.workspace |
| Restart com registros sem processo | Conserva card e exige retomada explícita; não ressuscita todas as equipes só por abrir o app | leftover-isolation, resume-guard |

## Interface resultante

Terminais permanece o destino da conversa. Se estiver vazio, a ação útil aparece ali mesmo, com explicação curta. Dormindo não é uma pergunta. Ver uma missão não reinicia trabalho automaticamente. Erros não desaparecem em toast: ficam junto do botão que permite tentar novamente. Os estados de loading, erro, conclusão e pergunta foram cobertos.

A revisão preservou a composição visual existente. Não redesenhou o aplicativo inteiro nem removeu confirmações para apagar histórico. A simplificação implementada concentra a recuperação numa ação e remove a restrição global que tornava missões paralelas incompatíveis.

## Validação e limites

- Primeira bateria ampliada: 321 testes / 17 suítes passaram.
- Segunda bateria (criação/adoção, encerramento, escopo e UI final): 168 testes / 13 suítes passaram. Há sobreposição entre baterias; não somar como testes únicos.
- `npm run typecheck`: passou; `npm run security:renderer-sinks`: 0 sinks.
- Prévia do componente e CSS reais em 1224×728 e 720×600, sem acesso às missões reais: layout inspecionado, axe na recuperação com 0 violações.
- CodeRabbit: duas revisões concluídas sem achados; a final incluiu os componentes e testes novos.
- A correção de lentidão F-209 já estava no checkout e foi preservada.
- Não houve instalação, reinício do Nexus do operador ou release. A prévia não demonstra retomada de uma CLI real no app empacotado; testes de fronteira cobrem o transporte/ciclo de vida.
