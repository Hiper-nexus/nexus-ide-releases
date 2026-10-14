# Missão "Terminais 5" (2026-10-13/14)

Registros da missão Nexus que levou à release **0.76.253 — Troca de conta sem perder nada**
(commit `f1b30a82c`). O requisito do fundador era: "quando acaba o limite de uma conta, nada pode
se perder: o pane só muda para a próxima conta e segue a missão". A missão cobriu:

- a troca de conta por cota no Maestro e nos workers (F-1470, F-1471, F-1473, F-1480, F-1482..F-1484,
  F-1486, F-1488, F-1489, F-1512);
- os panes mortos do Maestro (F-1475);
- o QR do celular, a rede local e o relay na Cloudflare (F-1472, F-1478, F-1487);
- o AGY ao vivo (F-1476), o roteamento entre todas as CLIs (F-1477) e o Grok no Windows (F-1485);
- o hook do Windows (F-1474), o comando pesado no horário de verão (F-1479) e a frente de squads
  (F-1490..F-1511).

O pacote foi planejado como 0.76.252. Esse número acabou usado por outra sessão (tag `v0.76.252`,
"Linux em dia com o campo"), e o pacote saiu como 0.76.253.

## Origem

Os originais ficaram fora deste repositório por erro de ancoragem: a missão rodou ancorada no
workspace de outro projeto (hipergo). Os briefs vieram de `hipergo/.nexus/briefs/`. As regras dos
writers, os handoffs, o texto da release e os scripts vieram do scratchpad da sessão do orquestrador.
São cópias fiéis, com uma exceção: o nome do projeto do cliente citado em
`briefs/dead-maestro-panes-scout.md` foi trocado por `[redigido]`.

Os briefs e as revisões de squad citam a numeração antiga F-1436..F-1457. Na release, essa frente
foi renumerada para F-1490..F-1511, e a correspondência está nos títulos dos commits em
`release-body-0-76-253.md`.

## Arquivos

### Raiz

- `release-body-0-76-253.md`: texto do GitHub Release da 0.76.253, com gates, mudanças e lista de commits.
- `apply-release-0-76-253.mjs`: script que aplicou a versão 0.76.253 em `package.json`, `release-notes.ts` e `CHANGELOG.md`.
- `compare-runs.mjs`: compara dois relatórios JSON do vitest (release × base) e lista as falhas novas.

### `briefs/`

- `account-switch-zero-loss-scout.md`: mapear onde a troca de conta perde estado e planejar o F-1473.
- `agy-black-pane-scout.md`: por que o pane do AGY em execução única fica preto até terminar (F-1476).
- `companion-qr-scout.md`: por que o QR do celular abre o link e não conecta (F-1472).
- `dead-maestro-panes-scout.md`: por que a missão acumula panes mortos do Maestro (F-1475).
- `orca-accounts-scout.md`: o que herdar do Orca 1.4.214 para trocar de conta sem parar a missão.
- `orca-mobile-scout.md`: o que herdar do Orca para o pareamento do celular por QR.
- `release-0-76-251-scout.md`: passo a passo da release com as três primeiras correções.
- `release-notes-draft.md`: rascunho das notas da release, ainda numerada 0.76.251.
- `release-notes-0-76-252.md`: notas prontas para colar, sob o número planejado 0.76.252.
- `release-test-plan.md`: roteiro de teste da release no Windows.
- `routing-diversity-scout.md`: por que o roteador só abria Codex Sol xhigh ou Claude e nunca Kimi, MiniMax, Grok ou Devin (F-1477).
- `squad-branch-review.md`: revisão adversarial das branches de squad antes da release.
- `writer-rules.md`: regras comuns dos writers (base `origin/main`, sem `git stash`, node pelo PowerShell, formato de QA e de commit).

### `handoffs/`

- `1f4f1d44.md`: Codex revisa `fix/squad-prep` e `fix/squad-win`. Reprova o F-1446 (squads legados) e aprova o F-1445 com ressalva.
- `41ad971e.md`: AGY entrega o rascunho das notas da 0.76.251 em TypeScript e a tabela de F-números.
- `5a443c7e.md`: Codex investiga os panes mortos do Maestro (deduplicação parcial, cleanup do bind, restore) e propõe a correção mínima.
- `5f8f4228.md`: Claude investiga o F-1473: onde a troca de conta perde conversa, pedido e estado, com plano em seis mudanças.
- `60bbc7ab.md`: Codex revisa `fix/windows-heavy-pid-squads` e `fix/squad-io`. Reprova o F-1435 (regressão POSIX no horário de verão).
- `61da55dd.md`: Claude investiga a release: a 0.76.251 já estava publicada, então a próxima sai de `origin/main`. Traz a lista de comandos.
- `916d159c.md`: Devin explica por que o celular na rede local não conecta (porta efêmera, código de 5 min, certificado, firewall).
- `aaa97302.md`: Codex revisa `fix/squad-ui` e `fix/squad-win`. Reprova o F-1435 e o F-1455; o F-1457 estava incompleto.
- `c3f5107e.md`: Codex revisa `fix/squad-prep`. Reprova o F-1446 e faz ressalvas ao F-1447 e ao F-1434.
- `d41cad7e.md`: Claude revisa `fix/squad-ui` e `fix/squad-io`. Não reprova nada; ressalva MEDIUM no F-1449.
- `e7338a58.md`: Muse Code revisa o F-1472 (QR do celular): integrável, com ressalvas.
- `f05b7b2c.md`: MiniMax revisa o F-1471. Aponta corrida com o supervisor, fechamento antes da rota e recibo "trocou" falso.
- `plan-item5-chain-wait.md`: plano da cadeia e da espera da troca de conta (base do F-1483) e das ressalvas do F-1471.
