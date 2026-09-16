/**
 * Footprint de memória por sessão PTY (F-572): RSS somado da árvore de
 * processos abaixo do root de cada sessão.
 *
 * Por que existe: o Electron só mede os próprios processos. No incidente de
 * 16/09 o app inteiro somava ~450 MB enquanto os panes (CLI + servidores MCP
 * filhos, ~1 GB cada) esgotavam a RAM — invisíveis para nexus_perf_snapshot e
 * para o crash report. Este módulo é a parte pura: parse de `ps` e atribuição
 * por root. O host PTY (que conhece os PIDs) roda a captura; o main só pede.
 *
 * Regras herdadas de pty-descendant-termination: PID duplicado invalida a
 * tabela; root ausente (PID reciclado) vira null — nunca chutar.
 */

export interface RssProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** Resident set size em KB, como o `ps` imprime. */
  readonly rssKB: number;
}

export interface SessionRoot {
  readonly sessionId: string;
  readonly rootPid: number;
}

export interface SessionFootprint {
  readonly sessionId: string;
  readonly rootPid: number;
  /** Root + descendentes vivos; 0 quando o root não existe mais. */
  readonly processCount: number;
  /** null = não atribuível (root sumiu ou tabela inconsistente). */
  readonly rssBytes: number | null;
}

export interface FootprintSummary {
  readonly sessions: number;
  readonly totalRssBytes: number;
  readonly largest: SessionFootprint | null;
}

/** `ps -axo pid=,ppid=,rss=` → linhas; qualquer linha fora do padrão é ignorada. */
export function parseRssProcessTable(output: string): RssProcessRow[] {
  const rows: RssProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKB: Number(match[3]),
    });
  }
  return rows;
}

export function attributeSessionFootprints(
  table: readonly RssProcessRow[],
  roots: readonly SessionRoot[],
): SessionFootprint[] {
  const byPid = new Map<number, RssProcessRow>();
  const childrenByPpid = new Map<number, RssProcessRow[]>();
  let consistent = true;
  for (const row of table) {
    if (byPid.has(row.pid)) {
      consistent = false;
      break;
    }
    byPid.set(row.pid, row);
    const siblings = childrenByPpid.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }
  return roots.map((root) => {
    const rootRow = consistent ? byPid.get(root.rootPid) : undefined;
    if (!rootRow) {
      return { sessionId: root.sessionId, rootPid: root.rootPid, processCount: 0, rssBytes: null };
    }
    let rssKB = rootRow.rssKB;
    let count = 1;
    const queue = [root.rootPid];
    const visited = new Set(queue);
    for (let index = 0; index < queue.length; index += 1) {
      for (const child of childrenByPpid.get(queue[index]!) ?? []) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        rssKB += child.rssKB;
        count += 1;
        queue.push(child.pid);
      }
    }
    return {
      sessionId: root.sessionId,
      rootPid: root.rootPid,
      processCount: count,
      rssBytes: rssKB * 1024,
    };
  });
}

export function summarizeFootprints(footprints: readonly SessionFootprint[]): FootprintSummary {
  let total = 0;
  let largest: SessionFootprint | null = null;
  for (const footprint of footprints) {
    if (footprint.rssBytes === null) continue;
    total += footprint.rssBytes;
    if (!largest || (largest.rssBytes ?? 0) < footprint.rssBytes) largest = footprint;
  }
  return { sessions: footprints.length, totalRssBytes: total, largest };
}
