# Muse: reserva privada e execução nativa

Fonte medida: `Muse Code 1.4.0 (1.4.0-R4302.1)`. O controle real usa o executável descoberto no PATH e o supervisor Nexus, gateway loopback/credencial fictícia e diretórios próprios; não lê nem altera perfil/login de operador.

`reserveMuseNativeHeavyProfile` reserva o artifact `muse` no registry existente e devolve XDG_CONFIG_HOME antes do spec de spawn. `initialize(assertCurrent)` lê apenas o settings selecionado, preserva seus campos/hooks e liga entradas complementares aos destinos selecionados. O hook adicional contém somente caminhos fixos do Node/recurso Main e flags de controle; as quatro chaves do canal ficam em memória/env. HOME, XDG_DATA_HOME e XDG_STATE_HOME não mudam. Sem sync-back da configuração privada.

O manager espera a inicialização e cria o mesmo canal Main em modo file após registrar a sessão. A callback F886 e sessão/abort/current são verificadas depois das esperas e pelo bridge antes do post. Cancelamento/host-down mantêm a limpeza física existente; falha antes do nascimento remove a reserva do perfil. Nenhum campo Promise/callback é enviado por IPC. F892 preserva writes e o último resize durante readiness.

O fixture real chama esse preparer, sem settings de scheduling escritos à mão. Ele mede pares baseline/scheduled em dois modos:

| Modo | Args de permissão | Write em caminho externo próprio | Scheduling |
|---|---|---|---|
| Padrão Nexus full-auto | `buildControlArgs` do adapter Muse, escolha vazia (`--yolo`) | permitido | target ausente antes do grant; Make completo; um grant/release físico |
| Inner Managed opcional | escolha já medida `--approval-mode never` | negado | mesma prova A+B/file, sem alteração de rede/FS |

Comando do target: `NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"`. Os settings selecionados permanecem byte a byte intactos. O helper aplica admissão dentro da mesma boundary herdada do target; não executa trabalho do projeto em proxy externo.

Verificação local final: 146 PASS / 8 skips existentes / 3 suítes (32.84s), full tsc exit0, sinks0, main-sync91. Controles específicos cobrem reserva síncrona/leitura deferred, configuração preservada, companions, cancelamento, registry rebind durante IO, FIFO e arquivo estrangeiro. A união com Root e a prova do candidato assinado são etapas separadas.
