/**
 * Tempo de CPU (usuário + sistema) do processo gasto por `run`, o melhor de
 * `rounds` medidas depois de um aquecimento (F-764 C.3).
 *
 * Os testes de "tempo linear" medem CPU, não relógio de parede: com outras
 * suítes e agentes disputando a máquina, o relógio inclui o tempo em que o
 * processo nem estava rodando e um teste linear falharia por fila. A CPU do
 * processo só cresce com o trabalho dele — uma varredura quadrática continua
 * estourando o teto, uma linear continua abaixo, com qualquer carga.
 */
export function cpuTimeMs(run: () => unknown, rounds = 2): number {
  run();
  let best = Infinity;
  for (let i = 0; i < rounds; i += 1) {
    const before = process.cpuUsage();
    run();
    const spent = process.cpuUsage(before);
    best = Math.min(best, (spent.user + spent.system) / 1000);
  }
  return best;
}
