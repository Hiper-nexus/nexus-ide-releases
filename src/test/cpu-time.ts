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

/**
 * CPU time of ONE call, for work that changes state and cannot be repeated
 * (a paste into the editor). Same reason as above: the wall clock of a shared
 * CI runner counts the time this process waited for a core.
 */
export function cpuTimeOnceMs(run: () => unknown): number {
  const before = process.cpuUsage();
  run();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / 1000;
}
