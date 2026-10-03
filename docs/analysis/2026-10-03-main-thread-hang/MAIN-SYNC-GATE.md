# F-764 — proibir novos processos síncronos no Main

`npm run lint:main-sync` analisa a AST dos fontes de `src/main` e rejeita novos
usos de `spawnSync`, `execSync` e `execFileSync`, incluindo imports renomeados,
namespace/default/CommonJS/import dinâmico, aliases, callbacks padrão e passagem
da função como argumento. Comentários, strings e imports exclusivamente de tipo
não contam. Bindings locais distintos não são confundidos com o import.

`scripts/main-sync-allowlist.json` permite apenas os usos existentes revisados,
por arquivo, operação, tipo de uso, hash dos tokens e quantidade. Uma chamada
nova num arquivo já permitido falha; alterar o comando também muda o hash.
Remover um uso exige diminuir/remover sua exceção. Não há curinga por diretório,
arquivo inteiro, linha mutável ou comentário de supressão.

Cada exceção tem a justificativa do boundary que preserva (por exemplo,
credencial nativa, prova de sandbox, compatibilidade síncrona de recovery ou
fixture sem consumidor de produção). A lista **não é prova de latência**, não
autoriza chamada nova e não afrouxa autoridade. A prova de desempenho continua
sendo o ensaio de carga/spawn do F-764. Primitivas legadas saem da lista quando
o caminho correspondente migra para execução assíncrona.

O check roda em `npm run lint`, no CI principal, em `premake` e `prepackage`.
Não instala dependências: usa o parser/binder TypeScript já incluído no projeto.
É uma régua de manutenção de código, não sandbox para JavaScript hostil ou
prova geral sobre execução reflexiva e wrappers arbitrários entre módulos.

Testes: `node node_modules/vitest/vitest.mjs run scripts/check-main-sync.test.mjs --maxWorkers=1`.
O teste de CLI executa o gate em um fixture temporário: o arquivo inicialmente
permitido passa; acrescentar outro comando síncrono no mesmo arquivo sai com
status 1. As regressões de detecção falharam contra o stub anterior; os 26 testes
do check passaram, e o inventário atual identifica 94 usos exatos em 88 grupos.
