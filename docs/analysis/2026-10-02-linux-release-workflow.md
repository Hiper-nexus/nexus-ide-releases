# Linux x64: workflow de candidata independente

Em `08755fe3a14bbd38235d0f2718ad460dfc9eed2e`, o canal Linux já tinha makers
DEB/RPM, coletor, publicador e documentação, mas não tinha
`.github/workflows/linux-release.yml`. A consulta do arquivo retornava 404;
o inventário Git continha apenas CI e os três workflows Windows. O publicador
exige um run bem-sucedido chamado `Linux x64 release`, de `workflow_dispatch`
na `main`, logo faltava a etapa que produz sua candidata autenticada.

O novo workflow implementa esse contrato sem iniciar publicação. Só aceita
dispatch explícito na `main` protegida do repositório canônico, revalida o SHA
atual da branch antes de executar código do checkout e constrói uma tag
anotada cujo commit pertence ao histórico desse SHA. A candidata usa
`ubuntu-22.04`, Node e npm da autoridade versionada e o bootstrap npm já
existente, com verificação de integridade SHA-512 antes da instalação.

Os gates incluem typecheck, renderer sinks, testes, release security, build
nativo Linux x64, smoke empacotado sob Xvfb e instalação do DEB. A instalação
confirma versão e arquitetura dos dois formatos e a dependência Bubblewrap.
O smoke instalado seleciona o executável real, sem confundir o diretório da
aplicação ou o symlink de `/usr/bin` com o binário.

O coletor v2 produz exatamente DEB, RPM e ZIP portátil, com prova de abertura
do aplicativo extraído do ZIP. O publicador aceita explicitamente recibos
históricos v1 apenas com o par DEB/RPM; v2 exige os três formatos e o SHA-256
do ZIP. O validador de extração recusa traversal, paths absolutos, symlinks
que escapam, paths sob symlinks e duplicatas antes de chamar unzip.
Os uploads
`linux-x64-release` e `linux-x64-receipt` mantêm o inventário exigido pelo
publicador. O workflow tem apenas `contents: read`, fixa as actions por SHA e
não cria releases, envia tags nem altera o espelho público.

## Verificação

- Os cinco testes de `scripts/linux-release-workflow.test.mjs` passaram com
  Node 22.23.2 e Vitest 5. Eles cobrem restrição de origem, autoridade da tag,
  runtime e integridade npm, pré-requisitos do recibo e actions imutáveis.
- A execução conjunta de coletor/publicador v2/v1, preview, extração segura e
  workflows passou: 44 testes em seis arquivos. A matriz Forge Linux e
  dependências Bubblewrap passou em três testes focados. Os
  testes do publicador usam transporte GitHub simulado; nenhuma publicação
  externa ocorreu.
- O YAML foi analisado e todos os blocos de shell passaram por `bash -n`;
  os dois módulos Node embutidos passaram por `node --check`.
- O run hospedado, o build Electron e a instalação real do DEB ainda precisam
  ser executados após a integração do workflow na `main` protegida. Esses
  resultados locais não são prova de candidata publicável.

## Limites da evidência

O harness Linux existente usa `--no-sandbox` exclusivamente no smoke devido
à política do runner hospedado. O workflow não altera o lançamento normal do
aplicativo; Xvfb não comprova a execução real da sandbox Bubblewrap nem uma
sessão Hyprland/Wayland.

Omarchy usa Arch e Hyprland. O novo ZIP elimina a necessidade de DEB/RPM para
distribuir o aplicativo x64 nesse alvo, mas não instala dependências, menu
ou atualizações. Não declara compatibilidade instalada ou validada com
Omarchy. O teste na sessão Hyprland continua pendente até haver prova real.

`linux-preview.yml` fornece evidência de build em PRs e pushes da main sem
tag ou credenciais de release: registra o SHA exato, mantém artifacts e schema
distintos e explicitamente não publicáveis, e abre DEB/ZIP sob Xvfb. O smoke
funcional de browser também roda em Electron real e salva sua evidência num
artifact separado. A versão do fonte permanece inalterada até os checks.

Este registro fica em `docs/analysis` porque a alteração adiciona a
infraestrutura de produção de candidatas já descrita pelo contrato de release.
A faixa de findings de build `F-5XX` estava esgotada; nenhum ID foi reciclado
nem atribuído fora dela.
