# Timers auxiliares e encerramento do Main — F-764 C.4

Os timers mantêm seus relógios existentes, com orçamento/flight em `periodic-task`.
O adapter `periodicCallback` não cria outro relógio: registra a execução e limita
reentrada; callbacks de IO devolvem/aguardam a Promise física. Os passos atômicos
(Electron window/cursor, histograma, heartbeat e métricas de processos) continuam
no Main. Orçamento cooperativo não interrompe uma chamada nativa síncrona; o
aceite de latência depende do teste de carga do candidato.

- Sentinel: pulso periódico grava temporário assíncrono; encerramento aguarda o
  pulso e só depois grava `expectedExit`, evitando reverter o marcador.
- Métricas de memória: amostragem barata continua mesmo durante statfs lento;
  a consulta de volume tem flight próprio, aguardado no encerramento.
- Renderer: polling adota as Promises de JavaScript, mantendo verificação da
  janela/navegação antes de aplicar uma resposta. Watchdog de prazo continua independente.
- Pet: movimentos/leitura do cursor têm orçamento; persistência assíncrona
  coalesce a escrita e mantém mutações que chegaram durante IO para o próximo flush.
- Licença/updater/orientação/perguntas de voz: flights aguardados e timers
  encerrados antes de liberar os respectivos serviços. Fonte de pergunta é
  percorrida com checkpoints; dedup em RAM tem teto de 4096 entradas.
- Main aguarda stops de reaper/mortalidade/GC/auth/contas/Redline e os novos
  stops, antes de fechar bancos. Redline devolve a Promise real do refresh.

Verificação no checkout de integração: 12 suítes/144 testes, mais 2 suítes/15
(depois de adicionar testes de persistência concorrente e cancelamento da voz),
typecheck completo e renderer-sinks (zero sinks). Os grupos se sobrepõem: não
somar como contagem da suíte inteira. A suíte completa e o pacote assinado
continuam pendentes. Catálogo assíncrono está no F-831; coletores e scanners são
entregas complementares. Este documento não encerra o F-764.
