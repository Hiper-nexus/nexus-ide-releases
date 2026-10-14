# Regras comuns dos writers — release 0.76.252 do Nexus IDE

Você é um writer (executor) do Nexus IDE (Electron/TypeScript, vitest). Disciplina "ponytail": entenda o fluxo
(funções, chamadores, testes), reuse o que existe, sem abstração especulativa, o menor diff correto, e testes que
falhem se a lógica quebrar.

## Base e branch
- A base de TUDO agora é `origin/main` = `5ae5585f3` (release 0.76.251 "Campo em dia", publicada hoje por outra
  sessão). O `main` local (`152c77e82`) é uma variante da 0.76.245 que NÃO está no origin: não use como base.
- A próxima release será a **0.76.252**, montada pelo orquestrador a partir de `origin/main` por cherry-pick dos
  seus commits. Faça commits pequenos e autocontidos (um por item F-), que apliquem limpo sobre `origin/main`.
- Repositório: `C:\Users\Administrador\Documents\Projetos\nexus-ide` (objetos e refs compartilhados entre worktrees;
  `origin/main` já foi buscado). Trabalhe SÓ no seu worktree. Sem push, sem merge em main, sem reset de branch alheia.
  Commit com pathspec explícito, nunca `git add -A`.
- **PROIBIDO `git stash`**: a lista de stash é UMA para todos os worktrees do repositório; um `stash pop` pega o
  trabalho de outro writer (já aconteceu). Para comparar antes/depois, use cópia temporária fora da árvore ou
  `git worktree add` descartável em detached HEAD.

## Ambiente (Windows)
- node/npm/npx/vitest/tsc/oxlint pelo Bash (Git Bash) são RECUSADOS neste pane ("nexus-heavy…", bug F-1434 deste
  build). Rode TODO comando node pelo tool **PowerShell**, com caminho absoluto:
  `& { Push-Location <worktree>; npx vitest run <arquivos>; Pop-Location }`. Git pode ir pelo Bash.
- A fila de comandos pesados é UMA por raiz para todos os writers (vários rodam em paralelo): rode só recortes
  pequenos de teste; se a fila recusar ("gave up after 300 s in the admission queue"), espere um pouco e tente de
  novo. Rode `npm run typecheck` uma vez, no fim.
- Várias suítes já falham por plataforma no Windows (caminhos POSIX, /bin/bash, CRLF, bits de modo). Rode o recorte
  ANTES de mudar (anote as falhas) e DEPOIS. Só falhas novas contam.

## Item de QA e commit
- Cada item tem `docs/qa/items/F-<n>.md` no formato do F-1434 (`git show 747bc0f22:docs/qa/items/F-1434.md`), com
  RED/GREEN reais (comando e números) e a contagem antes/depois.
- Mensagem: `fix(<área>): F-<n> — <frase em PT-BR>` + corpo curto (estilo `git show 747bc0f22`), terminando com:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01FgaSHuMqKSmzNHogC6cAXp`
- Números F já usados: origin vai até F-1451; F-1470..F-1474 são desta missão; F-1475..F-1489 reservados para esta
  missão (use só os que o seu brief der); F-1490..F-1511 são a renumeração da frente de squads.

## Requisito do fundador que vale para tudo
"Quando acaba o limite de uma conta, nada pode se perder: o pane só muda para a próxima conta e segue a missão."
Nunca deixe tarefa sem pane, recibo "trocado" falso, missão parada por troca de conta, ou conversa/pedido perdido
quando havia como preservar. Quando TODAS as contas do adapter estão esgotadas, a decisão é: seguir em outra CLI
com o pacote de continuidade (a missão não para), como o F-775 já faz.

## Resposta final
PT-BR, até ~500 palavras: SHA(s), arquivos, o que mudou, RED/GREEN com comandos e números, falhas pré-existentes,
riscos abertos. Não declare verde o que você não rodou.
