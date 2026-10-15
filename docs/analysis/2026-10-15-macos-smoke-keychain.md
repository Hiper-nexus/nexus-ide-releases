# macOS: Keychain privado no harness da candidata 0.76.274

## Diagnóstico

A candidata assinada permaneceu na base `5fffda01710af8491df7cfe6ebfa25e85e7a3d02`. No runtime privado, o writer abriu o preview, mas a navegação devolveu `loading: true` e a captura não terminou antes do prazo agregado. Não houve handoff perdido: o fixture só envia o handoff depois da captura e da escrita do relatório.

O sample `/tmp/nexus-main-274-diagnostic.sample.txt`, de 15/10/2026 às 13:50:02 -0300, identifica `nexus-ide [28361]`. Nas linhas 560–566, as 707 amostras dessa pilha passam por `SecItemAdd` → `defaultKeychainUI` → `makeLoginAuthUI` → `AuthorizationCopyRights`. HOME e userData privados não bastam para impedir o acesso do Chromium ao Keychain macOS usado na criptografia dos cookies.

O probe mínimo com Electron 43.7.4, janela focada, sandbox e contextIsolation passou com o preload exato da candidata e com o proxy do produto. Isso discrimina uma falha universal de Electron/preload/proxy, mas não prova a entrega do runtime completo nem a integração com o Keychain real.

## Fonte oficial e compatibilidade

A [PR oficial Electron #53790](https://releases.electronjs.org/pr/53790) descreve timeouts de testes causados pelo serviço de rede ao consultar a chave de criptografia dos cookies no Keychain. O [diff oficial](https://github.com/electron/electron/pull/53790/files) acrescenta `--use-mock-keychain` aos argumentos de processos de teste apenas no macOS.

Essa PR altera testes, não introduz o switch. Embora seu backport de testes na série 43 tenha saído em 43.7.10, o literal `use-mock-keychain` já está presente uma vez em cada um dos frameworks 43.7.4 inspecionados localmente:

- `node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework` da candidata b6ed;
- `/private/tmp/nexus-ui-274-comeht97.noindex/NexusIDE.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`, no app assinado.

Essa é evidência estática de suporte no binário existente. O efeito sobre o bloqueio observado será validado pela próxima execução completa do app original com o harness corrigido.

## Alteração restrita ao harness

`packagedSmokeArgs(userData, 'darwin')` acrescenta `--use-mock-keychain` junto ao sentinel `nexus-smoke-test` e ao `--user-data-dir` privado. Não altera os argumentos Windows/Linux, os prazos, a prova de saída física, as verificações de assinatura, os hashes, o proxy ou o sandbox do macOS.

Nenhum arquivo em `src/` foi alterado; não há ocorrência do switch nele. O helper só é chamado pelo script externo de smoke. Lançamentos normais do aplicativo continuam usando a configuração normal do Keychain. O smoke passa a testar o navegador com Keychain de teste; não deve ser apresentado como prova da integração com o Keychain real.

## Validação e execução da mesma candidata

- RED: `npx vitest run scripts/smoke-packaged-app.test.mjs -t 'isolation args and environment' --maxWorkers=1` — uma falha pela ausência do switch macOS; cinco testes passaram.
- GREEN: `npx vitest run scripts/smoke-packaged-app.test.mjs --maxWorkers=1` — 85 testes passaram.
- As asserções com arrays exatos preservam sentinel, userData privado e sandbox macOS; Windows e Linux permanecem byte a byte nos seus argumentos esperados.
- Sem instalação, rebuild, mudança de assinatura, alteração de Keychain real ou execução de app nesta correção. `node_modules` é um link para a dependência existente da b6ed.

A worktree do harness é `/Users/cleofasrocha/.codex/worktrees/nexus-smoke-keychain-274.noindex`, branch `fix/macos-smoke-keychain-274`. A próxima execução usa o script dessa worktree, mas mantém `--source-sha 5fffda01710af8491df7cfe6ebfa25e85e7a3d02`, versão `0.76.274`, app/ZIP originais e o receipt absoluto `/Users/cleofasrocha/.codex/worktrees/b6ed/nexus-ide/release-artifacts/candidate-build.json`. O SHA do commit do harness não substitui o SHA da candidata nem seu receipt.

## Repetição no mesmo app assinado

O ensaio com o harness corrigido carregou a prévia em 256 ms e capturou o PNG em 246 ms; escrita, handoff, revisão e ACK passaram. A falha seguinte foi outra: inicialização do coordenador promovido (F-399). O artefato 274 não foi modificado nem publicado. O bloqueio do Keychain do teste ficou confirmado e resolvido sem alterar o produto.
