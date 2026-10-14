# Brief — notas da release 0.76.252 prontas para colar

Papel: redator somente leitura. Não edite o repositório; entregue os blocos no handoff.

Repositório: `C:\Users\Administrador\Documents\Projetos\nexus-ide` (leia com `git -C …`). Branch de integração:
`release/0.76.252` (worktree `C:\Users\Administrador\Documents\Projetos\nexus-ide-rel252`), base `origin/main` 5ae5585f3
(0.76.251 "Campo em dia").

## Já integrado (confira com `git -C <worktree> log --oneline origin/main..release/0.76.252`)
F-1470, F-1471, F-1472, F-1474, F-1475, F-1478, F-1479, F-1480 e F-1490..F-1511 (frente de squads renumerada).
Leia cada `docs/qa/items/F-<n>.md` na worktree para o efeito real.

## Ainda vão entrar (escreva os itens também; marque como "pendente de integração")
- F-1473: na troca de conta por cota, o Claude continua a MESMA conversa na conta nova (com prova de que retomou;
  senão sessão nova com resumo).
- F-1482: a troca de conta ou de CLI leva junto o último pedido em andamento (o mais recente sempre inteiro).
- F-1483: a troca encadeia A→B→C sem pausa, conta medida em 100% nunca é escolhida, a espera pela cota dura até 24 h e
  volta depois de reiniciar o app, e as contas inativas são medidas durante a missão.
- F-1484: quando o próprio Claude avisa limite de uso, a troca é imediata (uma só), sem a pausa de 15 min, e o bloqueio
  vai até a cota voltar de verdade.
- F-1485: o Grok no Windows não pede login a cada pane; sem login válido, sai da rota e mostra "Entrar no Grok".
- F-1486: writer que fica sem pane quando tudo falha reabre sozinho; sem tarefa reaberta em dobro.
- F-1476: o pane do AGY mostra o trabalho ao vivo em vez de ficar preto.
- F-1477: revisão somente leitura usa todos os modelos de ponta; CLI presa no login sai da rota até logar.
- F-1487: o relay do celular foi para a Cloudflare (o QR volta a conectar) — é infraestrutura publicada à parte, mas
  vale citar na nota.

## Formato
Siga EXATAMENTE `src/shared/release-notes.ts` e `CHANGELOG.md` (veja como a 0.76.251 entrou:
`git -C <repo> show 5ae5585f3 -- src/shared/release-notes.ts CHANGELOG.md package.json`): renomear o `CURRENT_RELEASE`
atual para `RELEASE_076251`, novo `CURRENT_RELEASE` com `version: '0.76.252'`, `date: '2026-10-14'`, `codename` curto no
estilo dos anteriores, `summary`, `highlights[]` e `fixes[]` com `{title, detail}` no tom e tamanho dos existentes, PT-BR,
efeito para o usuário, sem jargão interno. Proponha 2–3 opções de codinome (o tema da release é "a troca de conta não
perde nada").
Entregue: (1) o bloco TypeScript completo para `release-notes.ts` (o rename + o novo), (2) a seção `## 0.76.252 — <codinome>`
para o topo do `CHANGELOG.md`, (3) a lista dos 4 lugares de versão a mudar (package.json, server/package.json,
package-lock.json ×2) conforme a 0.76.251, (4) o título do commit `chore(release): 0.76.252 — <codinome>`.

`nexus_handoff_submit` uma vez com os blocos prontos.
