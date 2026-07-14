/**
 * Across Tools matrix — presença real de MCP servers por ferramenta.
 * Células nunca inventadas: present | absent | unknown.
 */

export const MCP_ACROSS_TOOL_IDS = [
  'nexus',
  'cursor',
  'claude-code',
  'codex',
  'opencode',
  'cline',
] as const;

export type McpAcrossToolId = (typeof MCP_ACROSS_TOOL_IDS)[number];

export type McpCellState = 'present' | 'absent' | 'unknown';

export type McpToolProbeStatus = 'ok' | 'missing' | 'error';

export interface McpAcrossColumn {
  readonly id: McpAcrossToolId;
  readonly label: string;
  readonly path: string | null;
  readonly status: McpToolProbeStatus;
  readonly serverCount: number;
  readonly error?: string;
}

export interface McpAcrossRow {
  readonly serverKey: string;
  readonly label: string;
  readonly cells: Readonly<Record<McpAcrossToolId, McpCellState>>;
}

export interface McpAcrossToolsReport {
  readonly columns: readonly McpAcrossColumn[];
  readonly rows: readonly McpAcrossRow[];
  /** Servers present in some tools but missing in others that are ok. */
  readonly driftCount: number;
  readonly bannerKicker: string;
  readonly bannerLine: string;
  readonly observedAt: number;
}

export const MCP_ACROSS_TOOL_LABELS: Record<McpAcrossToolId, string> = {
  nexus: 'Nexus',
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  cline: 'Cline',
};

/** Normalize ids so TestSprite ≈ testsprite. */
export function normalizeMcpServerKey(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function countAcrossDrift(rows: readonly McpAcrossRow[]): number {
  let n = 0;
  for (const row of rows) {
    const states = MCP_ACROSS_TOOL_IDS.map((id) => row.cells[id]);
    const presents = states.filter((s) => s === 'present').length;
    const absents = states.filter((s) => s === 'absent').length;
    if (presents > 0 && absents > 0) n += 1;
  }
  return n;
}

export function acrossToolsBanner(driftCount: number, toolOkCount: number): {
  kicker: string;
  line: string;
} {
  // Kicker is always "Across Tools" — status lives in the pill (N DRIFT / OK).
  if (toolOkCount === 0) {
    return {
      kicker: 'Across Tools',
      line: 'Nenhuma config MCP legível nas tools deste Mac.',
    };
  }
  if (driftCount === 0) {
    return {
      kicker: 'Across Tools',
      line: `${toolOkCount} tools lidas · frota alinhada, sem gaps.`,
    };
  }
  return {
    kicker: 'Across Tools',
    line: `${driftCount} server${driftCount === 1 ? '' : 's'} divergente${driftCount === 1 ? '' : 's'} · Simular, depois Sync fill-gaps (backup + confirmação).`,
  };
}
