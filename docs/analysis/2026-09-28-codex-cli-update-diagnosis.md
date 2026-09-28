# Diagnóstico da atualização do Codex — 28/09/2026

## Sintoma e causa

Na tela **Ajustes → Provedores → CLIs → Codex**, “Atualizar CLI” exibia “Não reconheci o canal da CLI usada pelo pane”. O executável em uso era `~/.local/bin/codex`, um symlink para `~/.hermes/node/bin/codex`, que por sua vez apontava para `~/.hermes/node/lib/node_modules/@openai/codex/bin/codex.js`. A seleção da receita npm encontrava o pacote pelo caminho real, mas exigia que o *launcher* estivesse literalmente em `<prefix>/bin`; por isso rejeitava o alias válido antes de abrir a confirmação ou executar o instalador.

A captura do operador está em `.nexus/attachments/mission-context/mul7ztuu-c251e6ad15ecf82a-print-2026-09-28T12-24-58.png`. Os handoffs da missão `mission-e200b521-7958-492a-96d7-fc96d25370af` registram a reprodução com os caminhos reais e a análise do fluxo UI → Main.

## Resolução verificada

O commit `4b09895f` corrigiu o caso em `src/main/adapters/cli-install-recipes.ts`: um alias POSIX só é aceito quando `<prefix>/bin/codex` resolve para o mesmo arquivo real. O Main fornece essa resolução tanto à atualização manual quanto à automática. A regra preserva o prefixo npm dono do binário e recusa aliases para outros arquivos. O achado está em `docs/qa/items/F-364.md` e no changelog da versão 0.76.120.

A auditoria também encontrou o launcher Grok `~/.grok/bin/grok` apontando para `~/.grok/downloads/grok-<versão>-<plataforma>`. O mesmo commit reconheceu esse layout; o achado correspondente está em `docs/qa/items/F-365.md`.

Validação repetida neste checkout: `npx vitest run src/main/adapters/cli-install-recipes.test.ts src/main/adapters/cli-auto-update.test.ts` passou com **47/47 testes**; `npm run typecheck` passou. Não foi executada uma atualização real de CLI nem um teste visual no app após a correção.
