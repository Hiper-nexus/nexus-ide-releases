# Brief — revisão de branches de squad antes da release 0.76.251

Papel: REVISOR somente leitura (modelo de ponta, adversarial). Não edite, não commite, não faça checkout,
merge, rebase nem reset. Leia com `git -C C:\Users\Administrador\Documents\Projetos\nexus-ide …`.

## Contexto
Nexus IDE (Electron/TypeScript). A próxima release (0.76.251) vai levar TUDO o que está pronto, inclusive
branches de uma frente de "squads" feita hoje por outra sessão, que ninguém revisou. Base comum: `main`
(`152c77e82`, 0.76.245). A release atual do cliente é a v0.76.250 (`7b7d4823b`, branch `release/0.76.249`).
Cada commit tem um item de QA em `docs/qa/items/F-<n>.md` com o problema, a causa e a evidência alegada.

Em paralelo, outras correções vão entrar na mesma release (branches a partir do `main`):
`fix/maestro-account-failover` (F-1470: `src/main/orch/mission-fast-lane.ts`, `mission-engine-production.ts`,
`src/renderer/lib/user-facing-mission-error.ts`), `fix/worker-account-failover` (F-1471: `failover.ts`,
`tools-panes.ts`, `pane-task-reroute*`, `src/renderer/orch/failover-controller.ts`), `fix/cross-account-resume`
(F-1473: failover/provider-session-store), `fix/companion-qr` (F-1472: `companion/`, `src/main/remote/relay/*`,
`server/src/relay/*`, `CompanionRelaySection.tsx`).

## Sua(s) branch(es)
Está na linha "Sua tarefa" do prompt que abriu este pane.

## O que fazer, por commit (`git log --reverse main..<branch>`, `git show <sha>`)
1. O diff faz o que o item de QA diz? A causa raiz alegada é plausível no código?
2. Bugs reais: regressão, caso de borda sem tratamento, condição de corrida, quebra em macOS/Linux de algo
   feito para Windows (ou o contrário), segurança (caminho, injeção, segredo em log), compatibilidade com
   dados já gravados por versões anteriores (migração, squads salvos, missões em andamento).
3. O teste novo falharia sem a correção? Cobre o caso do item? Falta teste para algo arriscado?
4. Conflitos prováveis com as outras branches desta release (as acima e as outras `fix/squad-*`): mesmos
   arquivos/funções? (`git diff --name-only main...<branch>` e compare.)
5. Veredito por commit: APROVADO, APROVADO COM RESSALVA (o quê) ou REPROVADO (por quê, com arquivo:linha e
   cenário concreto que quebra).

Seja concreto: só reporte o que você consegue apontar no código. Nada de estilo.

## Entrega
`nexus_handoff_submit` uma vez, em PT-BR (até ~900 palavras): tabela commit → veredito, achados ranqueados
por severidade com arquivo:linha e cenário, conflitos previstos, e a ordem de merge recomendada.
