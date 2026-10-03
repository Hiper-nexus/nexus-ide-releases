# Carga real do Main com host de PTY simulado

Fonte: branch do executor em `0d859fc465617a1f81ae0ba3e3d33350958b4019`,
Node v22.23.2. O harness usa Main/SQLite/supervisor/roteamento e criação de worktree
reais, com transporte de PTY simulado e controle de créditos. Não é prova do
host nativo assinado nem do SHA final da integração.

`metrics.json`: 30.019 s; 483,018,913 bytes gerados/recebidos/admitidos/confirmados;
16.09 MB/s; p99 5.874 ms; máximo 101.696 ms; bloqueio do spawn 12.074 ms.
SHA256 de cada sessão confere. Quinze sessões iniciais e uma criada durante a
carga; 298 varreduras do supervisor, handoff de travamento e marcadores de
colagem/conclusão/handoff/OSC confirmados. O tempo total do spawn roteado foi
32.384 ms, distinto do bloqueio do Main.

`main.cpuprofile` SHA256:
`6e52d184370bf96124ed0c7c52095928a52b5525bcd0df930b7563df40ddccde`.

O próprio arquivo de métricas registra os limites: faltam o teste de falha do
worker, a equivalência do host nativo e a validação do candidato final. Não
usar este resultado isolado para declarar F-764 ou a release concluídos.
