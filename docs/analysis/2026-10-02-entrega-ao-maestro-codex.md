# Entrega de handoffs ao Maestro Codex: o que vale no macOS/Linux e no Windows (02/10/2026)

Origem: relato do operador na máquina Windows — com o Codex como Maestro, os handoffs
"chegam" (o texto aparece no terminal) mas o Enter não surte efeito e o texto fica parado
no compositor. A sessão do Windows corrige lá; esta análise (somente leitura, `origin/main`
b3da9ddb) diz o que vale no macOS e no Linux. [V] = lido em código/teste, [I] = inferido.

## Caminhos de entrega [V]
- **P1** handoff/[travado]/momentum ao Maestro (`idle-delivery.ts`): sempre cola com
  bracketed paste (`ESC[200~…ESC[201~`), sem olhar o adapter; CR aos 500 ms e retries em
  +0,4/+1,0/+2,2 s; aceita por borda busy, hook de turno ou "working" semântico em 12 s;
  3 tentativas por sessão.
- **P2** `nexus_pane_write`, handoff de workspace, aviso ao pane pai (`tool-util.ts`): CR aos
  500 ms, 2º CR em +400 ms, depois `\r\n`. O sucesso não é verificado.
- **P3** briefs (`deliverAgentPrompt`): verificado por hook de início de turno (família do
  binário Claude) ou por busy + saída; 12 s duas vezes; Ctrl-U na falha.

## Codex [V]/[I]
- Não há ramo por plataforma no código de submit; a diferença está abaixo dele.
- [I] A heurística de "paste burst" do Codex (para terminais sem bracketed paste, notadamente
  Windows) transforma um Enter dentro da rajada, ou até 120 ms depois do último caractere,
  em quebra de linha. Contada no processamento, não na chegada.
- **Windows:** provável. O P1 cola uma linha de 4–8 KB; no ConPTY não há evento de paste,
  então chega como teclas. O relógio de 500 ms não limita o atraso da fila de entrada do
  Codex; os CRs caem dentro da rajada e todos os retries acabam em 2,2 s.
- **macOS/Linux:** esse gatilho não vale no P1/P2 (o Codex recebe evento de paste real),
  mas continuam expostos: o P3 de linha única digitado cru (o fix 994b963c cobriu só o P2)
  e qualquer CR engolido (modal, popup `@`/`$`, travada), que termina no mesmo emperramento.

## Detecção [V]
Só existe prova de aceitação; não há detecção de rascunho no compositor (o Main não tem
emulador de terminal). O retry cola de novo em cima do texto encalhado e o idle-delivery não
tem Ctrl-U. Depois de 3 tentativas com o PTY ocioso o delivery desiste em silêncio
(`blockDeliveryFailure`); os avisos [travado] e de momentum usam o mesmo caminho e emperram
igual. A única saída é o bloqueio de 60 min do chef-idle e o Retomar manual.

## Quem pode ser Maestro [V]
Em Autopilot o portão é `missionControlCapable` (rota MCP + template de prompt; AGY fora).
Governado/auto-pick exigem `verified`, hoje fixo em claude e codex. claude e codex: sim;
grok: parcial; família glm/deepseek/muse-claude: Autopilot sim, governado não; kimi, devin,
qwen, opencode, minimax, mimo, muse: parcial (sem hook de turno, doutrina só por instruções
MCP/kickoff, sem hook de push); agy: não (one-shot).

## Próximos passos, em ordem
1. Codex (neutro de plataforma): settle proporcional ao tamanho (como `pane-submit.ts`), CR só
   com a saída do PTY quieta por ≥250 ms; retry 2 só Enter; retry 3 Ctrl-U + colar;
   `blockDeliveryFailure` com traço, aviso visível e resgate limitado só-Enter; P3 de linha
   única via `injectedPromptInput`; harness com um Codex falso (constantes de rajada Unix e
   Windows, travada injetada). Alinhar com o conserto da sessão do Windows antes de mexer.
2. Todo CLI de fronteira como Maestro: P1 adaptado ao adapter, um único `typeAndSubmit`
   com campos no manifesto, shims de `git push`/`gh pr` para CLIs sem hook, e um script de
   conformidade por adapter (payloads de 80 B/4 KB/8 KB terminando em `@x`/`$x`/`/x`).
3. Dever de verificar: feito como doutrina (`VERIFIQUE`); falta o portão mecânico
   (`assertIntegrationReviewed` reexecutando o gate de regressão em base..HEAD).
