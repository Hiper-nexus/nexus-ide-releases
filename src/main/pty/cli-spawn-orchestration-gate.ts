// Gate de orquestração para spawn de pane CLI (corrida de 16/08): com o
// renderer navegando em paralelo ao bootstrap, um pane restaurado pode pedir
// spawn antes do MCP/coordinator subir. O funil de spawn espera aqui — antes
// do provider e do PTY; pane de shell nunca passa por este caminho.
//
// Módulo-folha de propósito: ligado uma vez no arranque (orch-ipc) para não
// criar aresta pty → orch no bundle. Sem gate configurado é no-op — os
// caminhos que nunca tocam orquestração (testes, smoke isolado) seguem como
// sempre seguiram.
export type CliSpawnOrchestrationGate = () => Promise<unknown>;

// Teto da espera: o supervisor retenta bind de localhost para sempre — um
// MCP que nunca sobe não pode deixar o pane mudo sem resposta. Estourado o
// prazo, o spawn fecha com motivo legível (NÃO spawna sem MCP: isso
// reintroduziria a corrida original). O flight continua em background e a
// próxima tentativa já o encontra mais perto de pronto.
export const CLI_SPAWN_ORCHESTRATION_TIMEOUT_MS = 30_000;

let gate: CliSpawnOrchestrationGate | null = null;

export function setCliSpawnOrchestrationGate(
  next: CliSpawnOrchestrationGate | null,
): void {
  gate = next;
}

/**
 * Sem gate configurado o chamador segue o caminho síncrono de sempre —
 * nenhum microtask a mais no funil de spawn fora do boot paralelo.
 */
export function hasCliSpawnOrchestrationGate(): boolean {
  return gate !== null;
}

/**
 * Aguarda a orquestração ficar pronta. Rejeita quando o lifecycle está
 * fechando ou quando o teto estoura — o chamador falha fechado, sem tocar
 * provider nem PTY.
 */
export async function awaitCliSpawnOrchestration(): Promise<void> {
  if (!gate) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `orchestration did not become ready within ${
                CLI_SPAWN_ORCHESTRATION_TIMEOUT_MS / 1000
              }s — MCP startup still retrying`,
            ),
          );
        }, CLI_SPAWN_ORCHESTRATION_TIMEOUT_MS);
        // O timer não segura o processo num shutdown em andamento.
        (timer as ReturnType<typeof setTimeout> & { unref?: () => void })
          .unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
