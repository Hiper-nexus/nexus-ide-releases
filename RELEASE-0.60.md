# Release 0.60 — checklist antes da notarização

Identidade de versão: **0.60.0** (Nexus / NexusIDE).

Este documento **não** é changelog de features enviadas. É a lista do que
precisa estar funcional no produto antes do owner notarizar o build Mac
amanhã de manhã. Nenhum item abaixo está marcado como passado.

Nome do produto permanece **Nexus / NexusIDE**. Não rebrandar para ORCA.
Não trocar o visual civil pelo chrome stock do ORCA.

## Identidade (já alinhada neste PR)

- [x] `package.json` → `0.60.0`
- [x] `server/package.json` → `0.60.0`
- [x] `package-lock.json` (raiz, workspace `""` e `server`) → `0.60.0`
- [x] `CURRENT_RELEASE.version` → `0.60.0`
- [x] `CHANGELOG.md` com cabeçalho `## 0.60.0 —` (identidade, sem changelog inventado)

`CFBundleShortVersionString` e o feed de update saem dessa versão no
Electron Forge / packager. Não existe `latest.yml` nem `electron-builder`
no repositório. Assinatura, hardened runtime e entitlements
(`build/entitlements.mac*.plist`, `osxSign` / `osxNotarize`, perfil
`nexus-notary`) não devem ser alterados neste bump.

## Gates funcionais (ainda em aberto)

Marcar só com evidência observada no app — não com intenção.

- [ ] **Via Rápida de 20 stories anda sozinha** — missão Via Rápida com
      ~20 stories avança sem o operador empurrar cada etapa.
- [ ] **Quadro incrementa** — o board registra progresso (itens / etapas)
      conforme o trabalho acontece, sem ficar estático.
- [ ] **Pronto com evidência em disco** — estado Pronto só vale quando
      houver prova persistida em disco, não só UI.
- [ ] **Leftovers Dormindo persistidos** — leftovers no estado Dormindo
      sobrevivem a restart / reabertura.
- [ ] **Sem toast de CLI não autenticada** — CLI sem login não dispara
      toast de não autenticada no caminho coberto.
- [ ] **Sem panes zumbi** — missão terminal ou pane morto não deixa
      cadáver no grid.

## Depois dos gates, no Mac de release

Só então: `npm run make:release` com `NEXUS_MAC_PUBLISH_RELEASE=1`,
Team ID e perfil `nexus-notary`, gates de candidato, staple e publish.
O runbook continua em [`docs/RELEASE.md`](docs/RELEASE.md) e
[`build/notarize.md`](build/notarize.md).
