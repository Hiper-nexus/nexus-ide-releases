# Release conjunta Mac+Windows — pendências apuradas na 0.76.37 (15/09/2026)

Contexto: a 0.76.37 (commit b2e9d47a) passou build notarizado, gate
`release-candidate` (PASS em 39 s sob launchd) e run Windows assinado
35032371642, e foi **recusada no `release:publish`** por uma política do
próprio repositório. Este arquivo registra as duas pendências que saíram
dessa tentativa. Nenhuma delas é do código novo da versão.

## 1. Prova de upgrade instalado N→N+1 (bloqueia toda publicação pública)

**Sintoma.** `[release-publish] FAIL: Windows release: installed N-to-N+1
upgrade proof is missing, failed or not bound to this candidate.`

**Causa.** `scripts/windows-release-candidate.mjs` (`assertInstalledUpgradeProof`,
commit 1d3aa81c de 14/09) exige no recibo do worker
`smoke.installedUpgradeVerified === true` e um objeto `installedUpgradeProof`
(schemaVersion 1, status pass, fromVersion estável inferior, toVersion,
commitSha, runId, assetSha256 dos 3 assets e os checks
`signedBaselineInstalled`, `squirrelUpgradeApplied`, `targetRestarted`,
`userDataPreserved`). O produtor dessa prova **não existe**:
`scripts/collect-windows-release.ps1:80` grava `installedUpgradeVerified = $false`
e nunca escreve `installedUpgradeProof`. `docs/RELEASE.md` reconhece: "O
harness para produzir essa prova ainda não está implementado no coletor."
Sem produtor, a trava é uma porta sem chave: nenhuma versão passa, Mac incluso
(publicação só-Mac está desligada em `requireWindowsRunId`).

**Fato que contradiz a doutrina.** A v0.76.32 foi publicada em 15/09 14:35Z
com Windows e com o recibo `windows-release-receipt.json` anexado na canônica
marcando `installedUpgradeVerified: false` e **sem** `installedUpgradeProof`.
Todos os checkouts atuais contêm a asserção; não foi possível apurar por qual
caminho aquele publish a contornou. Consequência prática: já existe um
instalador Windows público (0.76.32) que serve de baseline assinado para o
harness N→N+1.

**Caminhos possíveis (decisão do operador).**
- (A) Implementar o harness no coletor: instalar em silêncio o Setup público
  da versão anterior (CDN de releases, rápido), abrir o app, aplicar o
  Squirrel update a partir do `RELEASES`/NUPKG candidato (`Update.exe`),
  confirmar reinício na versão alvo e preservação do userData, e gravar o
  `installedUpgradeProof` com os hashes exatos. Cada iteração custa um run do
  worker (~7-10 min) e o ciclo completo de release (~35 min) no final.
- (B) Waiver explícito, nomeado e temporário no loader (env com motivo,
  registrado no recibo canônico e nas notas), contrariando a doutrina de
  14/09. Exige commit novo, novo run Windows e novo build Mac.
- (C) Manter a 0.76.37 como candidata privada até (A) existir.

## 2. Download do artefato Windows pelo endpoint do Actions (~0,5 MB/s)

**Medido em 15/09 23:15Z** no mesmo link: CDN de releases do GitHub a
6,2 MB/s; endpoint `actions/artifacts/<id>/zip` a ~0,5 MB/s. O instalador
assinado tem ~556 MB, então o publish gasta ~18 min só baixando. Não é cota
(rate limit 5000/5000 intocado) nem o link local. O teto de 10 min derrubava
o publish; b2e9d47a subiu para 60 min, o que só esconde a lentidão.

**Como tirar essa espera.** O worker Windows sobe o instalador, o NUPKG, o
`RELEASES` e o recibo direto como assets de uma **release draft** (ou de um
release privado de staging) na canônica, em vez de artifact do Actions. O
loader então baixa pelo CDN em ~90 s, ou nem baixa: verifica os hashes do
recibo contra os assets e **promove** os mesmos bytes para a release final
(o publish precisa continuar conferindo sha256 e assinatura). A mudança é só
no `windows-release.yml` (upload) e em `scripts/windows-release-candidate.mjs`
(origem do candidato); a política de run em `main` protegido, commit exato e
recibo vinculado continua igual. Anotado como pendência para depois da
0.76.37.

## 3. Aprendizados de ambiente desta release (já em memória do agente)

- Rodar a cadeia por dentro de um pane do NexusIDE faz o gate reprovar:
  o supervisor de PTY do app empacotado recusa nascer aninhado
  (`responsible_is_supervisor`). Solução validada: `launchctl submit`.
- launchd relança job com exit≠0: `launchctl remove` imediato após FAIL.
- Sessões paralelas no mesmo checkout: a versão foi de 0.76.36 para 0.76.37
  porque outra sessão bumpou `main` no meio; release sai de worktree próprio.
