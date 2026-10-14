# Brief — passo a passo para lançar a 0.76.251 com três correções

Papel: investigador SOMENTE LEITURA. Não edite, não commite, não faça tag, build, publish nem push.

Repositório: Nexus IDE em `C:\Users\Administrador\Documents\Projetos\nexus-ide` (use `git -C <caminho>` para
ler histórico; há worktrees irmãos em `C:\Users\Administrador\Documents\Projetos\nexus-ide-*`).

## Contexto
- A release do cliente é a v0.76.250, commit `7b7d4823b` na branch `release/0.76.249` (worktree
  `nexus-ide-rel`). O `main` está em `152c77e82` (0.76.245) e NÃO é ancestral da branch de release: a release
  recebeu cherry-picks (ex.: `747bc0f22` F-1434 e `dafd72ee4` F-1435 na release correspondem a `cc70bff7f` e
  `04e82fc20` na branch `fix/windows-heavy-pid-squads`, baseada no `main`).
- Três correções estão sendo escritas em branches a partir do `main` (152c77e82), um commit cada:
  `fix/maestro-account-failover` (F-1470, `src/main/orch/mission-fast-lane.ts`, `mission-engine-production.ts`,
  `src/renderer/lib/user-facing-mission-error.ts`), `fix/worker-account-failover` (F-1471, `failover.ts`,
  `tools-panes.ts`, `pane-task-reroute*`, `src/renderer/orch/failover-controller.ts`) e `fix/companion-qr`
  (F-1472, `companion/worker.js`, `src/main/remote/relay/*`, `src/renderer/components/settings/CompanionRelaySection.tsx`,
  `server/src/relay/server.ts`).
- Há outra frente aberta hoje, de squads, em `fix/squad-io`, `fix/squad-prep`, `fix/squad-ui`, `fix/squad-win`
  (F-1437..F-1456), também a partir do `main`.

## Perguntas
1. Como foi feita a 0.76.250 e a 0.76.249: mostre o diff do commit de release (`git show --stat 7b7d4823b`,
   `083faa9ce`) — quais arquivos mudam (versão em package.json? `src/shared/release-notes.ts`? changelog?
   manifestos?). Mostre o formato exato de uma entrada de `release-notes.ts` (título curto, itens).
2. Como os fixes entram na branch de release (cherry-pick dos commits do `main`/branch de fix? merge?) e de
   onde sai a próxima release: continuar em `release/0.76.249` ou criar `release/0.76.251`? Procure scripts e
   docs de release (`scripts/release*`, `docs/*release*`, `docs/superpowers/plans/*release*`, `package.json`
   scripts `dist`, `release`, `publish`, electron-builder config, canal de auto-update, GitHub Releases).
3. Os arquivos que as três correções tocam divergem entre `main` e `release/0.76.249`? (Para cada arquivo
   listado acima, `git diff --stat main release/0.76.249 -- <arquivo>`.) Algum cherry-pick vai conflitar?
   E com as branches `fix/squad-*` (que arquivos elas tocam em comum)?
4. Quais gates rodam antes de uma release (lint, typecheck, vitest inteiro, e2e, `lint:main-sync`), quanto
   tempo levam, e que falhas de plataforma Windows são conhecidas/aceitas (procure nos itens de QA
   `docs/qa/items/F-14*.md` a contagem "falhas antes/depois")?
5. Entregue uma lista numerada de comandos (sem executar) para: integrar os três commits, gerar a 0.76.251,
   validar e publicar — marcando os passos que são externos/irreversíveis (tag, push, publish).

## Entrega
`nexus_handoff_submit` uma vez, relatório em PT-BR (até ~800 palavras) com comandos e arquivo:linha.
