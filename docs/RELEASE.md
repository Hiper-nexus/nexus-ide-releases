# Publicar uma nova versão

O caminho vigente é **manual e local**, sem GitHub Actions. O Mac de release
assina com Developer ID, notariza com o perfil exato `"nexus-notary"`, executa
os gates no mesmo commit da tag e envia os artefatos diretamente pelo alvo
`npm run release:publish`. O publicador fixa `--repo` em toda chamada ao `gh`;
não depende do repositório inferido pelo diretório atual.

O runtime de release também é autoridade versionada: use exatamente Node
`22.23.1`, conforme `package.json > nexusRelease.node`. Outro patch de Node 22
falha antes da build.

O runbook canônico, incluindo cadastro interativo da credencial no Keychain,
build, SBOM/audit, verificação do DMG/ZIP e publicação, está em
[`build/notarize.md`](../build/notarize.md).

Não execute `gh workflow run`, não use `npm version` e não publique pacote
ad-hoc. A tag local é criada sobre o commit final antes do build, mas só é
enviada pelo alvo de publicação depois dos gates. A release só pode ser criada
quando:

1. typecheck, testes e `npm run release:security` passarem;
2. a missão E2E real passar no artefato candidato;
3. assinatura, Gatekeeper, notarização e *staple* forem verificados;
4. tag, artefatos e evidências de segurança apontarem para o mesmo commit;
5. o manifesto incluir auditoria/SBOM de produção e da toolchain, lockfile,
   versões Node/npm e hashes finais de DMG, ZIP e evidência E2E.

## Publicação canônica e espelho

O comando publica duas releases com a mesma tag, em ordem fail-closed:

1. `cleofasvolarehost/nexus-ide` recebe DMG, ZIP, manifesto, auditorias,
   SBOMs, evidência E2E e recibo do candidato;
2. para `cleofasvolarehost/nexus-ide-releases`, o publicador envia **somente
   DMG e ZIP** para o atualizador público; não envia evidências internas nem
   outros assets da release canônica.

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

O release oficial atual é single-architecture `arm64`, gerado no Mac Apple
Silicon. Não há promessa de universal ou `x86_64` sem build/prova separados.

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
