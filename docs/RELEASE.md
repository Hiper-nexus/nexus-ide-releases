# Publicar uma nova versão

Checklist funcional da candidata **0.60** (ainda em aberto):
[`RELEASE-0.60.md`](../RELEASE-0.60.md).

As publicações são **independentes por sistema operacional**. O Windows usa a
candidata assinada produzida pelo workflow privado protegido
`windows-release.yml` e a publica com `npm run release:publish:windows`; esse
comando não inicia nem exige build, assinatura ou notarização macOS. O Mac
continua usando seu próprio caminho de Developer ID/notarização. Os dois
publicadores fixam `--repo` em toda chamada ao `gh`; não dependem do
repositório inferido pelo diretório atual.

## Canal Windows independente

Uma publicação Windows usa somente a candidata Windows x64 do mesmo commit e
tag estável. A release canônica privada recebe `Setup.exe`, NUPKG, `RELEASES`,
recibo assinado e, quando autorizado, o waiver de prova de upgrade. O espelho
público recebe **somente** `Setup.exe`, NUPKG e `RELEASES`. Assim o feed
Squirrel Windows fica disponível sem aguardar um artefato de macOS.

O repositório público é compartilhado, mas cada atualizador seleciona apenas o
asset compatível: uma release macOS sem Setup Windows não avança o canal
Windows, e uma release Windows sem ZIP macOS não é oferecida a Macs. Nunca
adicione assets de outro sistema depois de uma release pública; cada sistema
publica sua própria próxima versão estável.

No host Windows de publicação, rode:

```powershell
$env:NEXUS_WINDOWS_RELEASE_RUN_ID = '<run-assinado-do-windows-release.yml>'
# Só enquanto o harness N→N+1 ainda não produzir a prova automaticamente:
$env:NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER = '<motivo aprovado pelo operador>'
npm run release:publish:windows
```

O run deve ser o workflow protegido, bem-sucedido e no mesmo commit da tag. O
publicador baixa o artifact autenticado, confere seu SHA-256, assinaturas,
timestamp e inventário Squirrel antes de criar drafts e só então publica a
canônica seguida do espelho público.

O runtime de release também é autoridade versionada: use exatamente Node
`22.23.2`, conforme `package.json > nexusRelease.node`. Outro patch de Node 22
falha antes da build.

O runbook canônico, incluindo cadastro interativo da credencial no Keychain,
build, SBOM/audit, verificação do DMG/ZIP e publicação, está em
[`build/notarize.md`](../build/notarize.md).

Não dispare workflows de release antigos, não use `npm version` e não publique pacote
ad-hoc. O worker Windows dedicado é a única fonte aceita para o candidato Windows. A tag local é criada sobre o commit final antes do build, mas só é
enviada pelo alvo de publicação depois dos gates. A release só pode ser criada
quando:

1. typecheck, testes e `npm run release:security` passarem;
2. a missão E2E real passar no artefato candidato;
3. assinatura, Gatekeeper, notarização e *staple* forem verificados;
4. tag, artefatos e evidências de segurança apontarem para o mesmo commit;
5. o manifesto incluir auditoria/SBOM de produção e da toolchain, lockfile,
   versões Node/npm e hashes finais de DMG, ZIP e evidência E2E.

## Fluxo histórico multiplataforma (somente quando as duas candidatas existem)

O comando legado `npm run release:publish` descreve uma publicação composta.
Ele não é o caminho para desbloquear uma release Windows: use sempre
`npm run release:publish:windows` para publicar o canal Windows de forma
independente. O fluxo composto abaixo permanece documentado apenas para uma
publicação que já tenha candidatas completas dos sistemas envolvidos.

O comando publica duas releases com a mesma tag, em ordem fail-closed:

1. `Hiper-nexus/nexus-ide` recebe DMG, ZIP, manifesto, auditorias,
   SBOMs, evidência E2E e recibo do candidato;
2. para `Hiper-nexus/nexus-ide-releases`, o publicador envia DMG, ZIP, Setup Windows x64, NUPKG completo original e `RELEASES` de uma entrada. Evidências internas e recibos ficam apenas na release canônica.

Em uma publicação nova, ambos os repositórios ficam em *draft*, recebem
upload com `--clobber` e têm nome, tamanho e, quando disponível no draft,
SHA-256 conferidos antes de qualquer release se tornar pública. A release
canônica é publicada e relida primeiro; só então o espelho público pode ser
publicado. No estado publicado, o SHA-256 retornado pelo GitHub é obrigatório
para cada asset. Inventário extra, ausente ou divergente interrompe o fluxo.

Uma tentativa interrompida enquanto ainda há drafts **reutiliza** o recibo
local verde (`release-candidate-receipt.json`) quando HEAD, tag, DMG/ZIP e
evidências E2E ainda batem — sem repetir a missão empacotada. Só roda o gate
completo de novo se o recibo estiver ausente, inválido ou desalinhado. Se a
release canônica já estiver publicada e exata, a retomada também não recompila
nem repete a missão E2E: ela revalida HEAD, tag local e remota, recibo
durável, hashes de DMG/ZIP, manifesto e todos os arquivos de segurança contra a
release canônica publicada, e então conclui o espelho. Se o espelho aparecer
publicado antes da canônica, o comando falha sem tentar “consertar”
silenciosamente. Executar o comando novamente com ambas as releases publicadas
só é aceito quando os dois snapshots são exatamente os esperados.

O candidato Mac continua `arm64`; o candidato Windows é `x64`. Não há promessa de Mac universal/Intel ou Windows ARM sem build/prova separados. A existência do workflow não prova que o worker CKA já foi provisionado.

Para checar a credencial local sem expor segredo:

```bash
xcrun notarytool history --keychain-profile "nexus-notary"
```

O workflow anterior foi preservado apenas como histórico em
[`docs/archive/release-actions-workflow.yml`](archive/release-actions-workflow.yml).
Ele está fora de `.github/workflows`, portanto não pode ser executado pelo
GitHub Actions.

Quando `NEXUS_UPDATE_FEED` apontar para um feed HTTPS Nexus válido, ele continua
sendo a fonte preferencial. Sem esse feed, instalações com acesso ao
repositório privado podem usar `gh` autenticado; as demais consultam de forma
anônima o espelho público de artefatos acima. O espelho disponibiliza apenas a
arquitetura realmente construída e provada nesta release.

## Candidato Windows obrigatório

Antes de `npm run release:publish`, obtenha um run concluído com sucesso do workflow
`.github/workflows/windows-release.yml`, no repositório privado canônico e no
mesmo commit da candidata Mac em `main` protegido. O worker usa os labels
`[self-hosted, Windows, X64, nexus-release-signing]`, o ambiente
`windows-release-signing` e a variável de ambiente GitHub `WINDOWS_CERTIFICATE_SHA1`.
Ele depende de CKA previamente configurado para a identidade Windows do runner.
Não cadastre senha, PIN ou TOTP em argumentos de processo; não use PFX nesse worker.
O input `version` deve corresponder ao package.json, sem prefixo `v`. O worker não
publica releases, e só pode ser iniciado a partir de `main` protegido.

No Mac, selecione o run autenticado:

```bash
NEXUS_WINDOWS_RELEASE_RUN_ID=<id-do-run-assinado> npm run release:publish
```

O comando exige workflow, commit, repositório privado, sucesso e artefato exatos;
verifica o SHA-256 do arquivo baixado contra o digest informado pelo GitHub antes
de extrair. O recibo dentro desse arquivo vincula assinaturas, timestamp, smoke
e bytes ao commit/versão. Um JSON local ou o workflow de preview unsigned não
serve como autoridade. Sem worker válido, a publicação Mac também é bloqueada.
As duas plataformas entram na mesma transação de drafts já existente.

O serviço público Windows consulta releases estáveis por ordem de publicação.
Não publique uma versão estável inferior a outra já publicada: o publicador
agora bloqueia esse caso. Preserve o nome original do NUPKG e uma única entrada
no `RELEASES`; somente o Setup recebe nome com `win32-x64`. Não publique deltas
ou múltiplas arquiteturas nesse feed sem validar o suporte.

Os artefatos do worker têm retenção de 90 dias. Depois da expiração, a retomada
falha fechada; não substitua a autoridade por recibo local nem recompile para
sobrescrever bytes já publicados. Resolva a preservação de evidência autenticada
antes de precisar retomar uma release expirada. Releases antigas publicadas só
com Mac não são convertidas por upload avulso: use uma próxima versão conjunta.

O primeiro instalador público precisa conter o atualizador e passar instalação
e atualização real assinada N→N+1, preservando dados. O worker atual prova
assinatura e smoke do NUPKG; `installedUpgradeVerified=false` no recibo registra
que essa prova de instalação/upgrade ainda não é produzida por ele. O publicador
**recusa esse recibo**: o candidato pode continuar privado, mas não pode tornar
nenhuma das plataformas pública. Provisionamento
CKA, assinatura real e upgrade instalado continuam não verificados nesta entrega.

### Prova de upgrade e concorrência

A prova `installedUpgradeProof` deve vir dentro do mesmo artifact autenticado
do worker e conter schemaVersion 1, status pass, fromVersion estável inferior,
toVersion igual à candidata, commitSha, runId e assetSha256 com os hashes exatos
do Setup, NUPKG e RELEASES. Os checks signedBaselineInstalled,
squirrelUpgradeApplied, targetRestarted e userDataPreserved devem resultar do
teste real. A ausência da prova, alvo errado ou installedUpgradeVerified=false
bloqueia publicação. Um arquivo local editado não substitui essa evidência.
O harness para produzir essa prova ainda não está implementado no coletor.

Enquanto o harness não existe, o operador pode declarar um **waiver** só para
o caso "prova não produzida" (`installedUpgradeVerified=false` e
`installedUpgradeProof` ausente no recibo): `NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER`
com um motivo de uma linha (20–600 caracteres: quem testou o quê, onde e
quando). O waiver nunca cobre uma prova produzida e reprovada, nem uma prova
desvinculada, nem um recibo que se diz verificado sem prova. O publicador
grava `windows-upgrade-proof-waiver.json` (versão, commit, run, motivo, data
e operador) como asset da release canônica, ao lado do recibo, e avisa no
log; o espelho público não recebe o arquivo. Introduzido na 0.76.37, quando a
0.76.32 já tinha saído com o mesmo recibo sem prova.

O comando de produção mantém um lock exclusivo local durante toda a sessão,
compartilhado entre checkouts da conta de release. Outra sessão falha sem
executar publicação; o lock é liberado ao terminar ou falhar normalmente e
nunca é roubado por expiração. Após crash, confira host/PID em owner.json e
remova o lock somente depois de confirmar que a sessão acabou.

As listas estáveis da canônica e do espelho são relidas imediatamente antes
de cada transição draft→publicado. Isso fecha a janela longa de download e
upload. O lock não coordena hosts diferentes; não execute publicadores
independentes em hosts distintos simultaneamente.
