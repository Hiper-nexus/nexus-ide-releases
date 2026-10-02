# Autoridade de versão e publicação da candidata

Inspeção read-only do pin `08755fe3a14bbd38235d0f2718ad460dfc9eed2e` e APIs de releases/Actions em 2026-10-02. Nenhuma tag ou release foi criada. Credenciais e segredos não foram consultados.

## Versão

Main, package/server/lock/CURRENT_RELEASE e latest estável dos dois repositórios estavam em `0.76.163`. Os últimos commits `chore(release)` avançaram 159 → 160 → 161 → 162 → 163. A candidata inicial era `0.76.164`. Durante os checks, a main avançou para `d695058775bec43fb7a657aef0fedcd36f49ae63`, com a versão 164 e correções independentes de segurança, login e contabilidade. Essas mudanças foram preservadas; a próxima candidata passou a `0.76.165`, sem tag ou publicação. Não existe script de bump automático no inventário de scripts.

`docs/RELEASE.md` proíbe `npm version` e pede commit manual dos metadados antes da tag anotada local. `scripts/release-authority.mjs` valida seis valores de versão entre package, server, lock (top-level, package raiz, package server) e CURRENT_RELEASE, mais o cabeçalho CHANGELOG. A candidata muda somente esses valores JSON, preserva as notas 163 e 164 como RELEASE_076163/RELEASE_076164 e acrescenta a nova CURRENT_RELEASE no formato AppRelease existente. O guard real `readAndAssertReleaseAuthority` aprovou inicialmente 164 e, após incorporar a main, aprovou 165 com Node `22.23.2` e npm `12.0.0`. O contrato de assinantes continua com fingerprints vazios.

`build/notarize.md` ainda menciona Node 22.22.3; a autoridade executável atual é package.nexusRelease.node=22.23.2. `build/release-tag-signers.json` tem fingerprints=[]: tag anotada é exigida, assinatura da tag não é declarada verificada. A tag 163 aponta a `34f7abc…`, ancestral da main; o código aceita HEAD descendente, mas `make-release.mjs` constrói **o commit da tag** em worktree descartável. Reusar 163 excluiria as mudanças novas.

## Gates e superfícies executáveis

| Caminho | Pré-requisitos e resultado | Estado nesta sessão |
| --- | --- | --- |
| Main/PR CI | Branch main protegida exige `check`; workflow CI instala dependências e executa typecheck, renderer-sinks e suíte. | Pin main teve typecheck/sinks verdes e uma falha de limpeza ENOTEMPTY na suíte; a correção da candidata precisa passar CI novo. |
| Preview Linux da candidata | Workflow proposto em PR/main; build, smokes e harness browser Electron real com screenshots. | Artefatos de preview são evidência, não release publicável. Container local não abriu BrowserWindow; execução/pixels ficam para CI. |
| Preview Windows existente | `windows-preview.yml`: push em `codex/windows-test-*` ou dispatch; hosted windows-latest, pacote unsigned e smoke. | Não dispara em PR de qualquer nome. Sem dispatch exposto pelo connector; branch fora do prefixo não produz preview Windows automaticamente. |
| Mac local | `release:mac` via launchd encadeia make:release → release:candidate → release:publish:macos e restaura ABI Node. make exige darwin, Node/npm fixados, árvore limpa, tag anotada, Developer ID do Team 35P5XL3JN6 e Keychain profile nexus-notary. | Não há host Mac nem autoridade Keychain comprovados neste ambiente Linux. Não foi executado build/notary/publish. |
| Gate candidato Mac | Verifica assinatura strict de app/Mach-O/DMG, Gatekeeper, staple, arquitetura, fuses/entitlements e smoke do app extraído do ZIP. Produz audit/SBOM runtime+toolchain (zero vulnerabilidades), lock/hashes e recibo selado do mesmo commit/tag/artefatos. | O código atual usa smoke empacotado; referências antigas a missão LLM real nos runbooks estão desatualizadas. Não existe recibo 165 aprovado nesta sessão. |
| Release Windows | `windows-release.yml`: dispatch protegido na main atual; self-hosted Windows X64 nexus-release-signing e environment protegido; certificado CKA HIPERSEND, assinatura/timestamp, smoke e recibo imutável. `release:publish:windows` independe de Mac. | Há runs históricos assinados bem-sucedidos; isso não prova runner online nem candidata 165. Inventário/status de runners é inacessível ao connector. |
| Release Linux | Workflow novo ubuntu-22.04 exige main protegida/tag anotada e provas DEB/RPM/ZIP; publicador confere run/receipt/bytes/SHA e anexa payloads na release canônica publicada, depois no espelho, sem substituir bytes divergentes. | Requer integração e execução do workflow e release existente para a versão; não converter preview em release. Linux não oferece auto-update. |

Não há workflow macOS ativo em `.github/workflows` no pin. `docs/archive/release-actions-workflow.yml` está arquivado, portanto não executável. Isso impede a produção Mac através do caminho Actions atualmente disponível; não invalida o caminho local Mac documentado. Criar um workflow sem host/certificado/perfil/provas disponíveis não resolve esse bloqueio.

O connector permite ler runs/jobs/logs/artifacts e baixar ZIP de artifact; expõe rerun de jobs existentes, mas não dispatch de workflow nem criar/upload/publicar release. Fetch rejeitou as coleções workflows/runners. Rerun de um job histórico mantém seu commit e não valida a candidata nova. Os publicadores de produção usam `gh` autenticado e transação canônica → espelho, com lock e SHA-256 remoto antes das transições.

Os canais Mac e Windows têm publicadores independentes (`--macos`/`--windows`); o comando legado sem seletor é composto. `release:mac` publica automaticamente por padrão **depois** de seus gates, mas não escolhe versão/tag. Até os gates aplicáveis passarem, manter a stable pública 163 e registrar 165 somente como candidata no PR. Ausência de Mac/notary nesta sessão é bloqueio operacional de entrega Mac, não motivo para fabricar recibo, renomear preview como estável ou alterar o canal público.
