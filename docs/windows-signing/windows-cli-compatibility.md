# F-524: compatibilidade com CLIs npm no Windows

Recomendação de implementação; ainda não implementada.

A descoberta atual pode escolher o shim Unix sem extensão antes do `.cmd`.
Um arquivo regular no Windows não é necessariamente executável por CreateProcess.
O preview usa o executável nativo do Codex e não prova suporte a outros shims.

Separar resolução do caminho mostrado ao usuário do comando efetivamente
executado. Um contrato estruturado `{displayBinPath, file, argsPrefix}` permite
manter a identidade da CLI e usar `node.exe` para uma entrada JavaScript.

Para executar diretamente, aceitar somente arquivos nativos existentes e
absolutos `.exe`/`.com`. Para shims npm, qualificar o pacote oficial esperado
para o adapter, nome exato no package.json, entrada bin relativa e regular,
realpaths contidos no pacote/prefixo e caminho absoluto de node.exe. Não
executar nem interpretar o texto batch para descobrir o destino.

O comando resultante é `node.exe` com `[binJsAbsoluto, ...args]`. Descoberta,
sondas de versão/autenticação e PTY precisam usar o mesmo contrato. Não recorrer
a `cmd.exe /c`, `shell:true` ou interpolar argumentos de prompt/modelo em strings
de shell. Um override `.cmd` precisa da mesma qualificação ou erro explícito.

Testar resolução win32/PATHEXT, traversal/symlinks maliciosos na entrada bin,
preservação literal dos argumentos com metacaracteres, equivalência entre
descoberta/sondas/spawn e rejeição de shims não qualificados. O futuro Job deve
possuir o processo nativo raiz e seus descendentes herdados.
