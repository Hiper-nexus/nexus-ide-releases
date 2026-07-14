import { useMemo, useState, type ReactNode } from 'react';
import { MCP_ACROSS_TOOL_LABELS } from '../../shared/mcp-across-tools';
import {
  MCP_HUB_SYNC_EXPORT_TOOLS,
  type McpHubSyncApplyInput,
  type McpHubSyncExportToolId,
} from '../../shared/mcp-hub-sync-api';
import { askConfirm } from '../state/confirm-store';
import { useToastStore } from '../state/toast-store';

export type McpExportToolId = McpHubSyncExportToolId;

export type McpSyncPlan = {
  importIds: string[];
  exportByTool: Partial<Record<McpExportToolId, string[]>>;
  skipped: string[];
  summary: string;
};

type SyncApplyResult = {
  dryRun: boolean;
  hubWrote: boolean;
  toolWrites: Array<{ tool: string; added: string[]; path: string }>;
};

export const MCP_EXPORT_TOOL_IDS: McpExportToolId[] = [
  ...MCP_HUB_SYNC_EXPORT_TOOLS,
];

function formatSyncBody(
  plan: McpSyncPlan,
  exportTools: McpExportToolId[],
  dryRun: boolean,
): string {
  const lines = [
    dryRun ? 'DRY-RUN — nenhum arquivo será escrito.' : plan.summary,
    '',
    `Import → hub: ${plan.importIds.length}`,
  ];
  if (plan.importIds.length > 0) {
    lines.push(`→ Hub: +${plan.importIds.join(', ')}`);
  }
  for (const tool of exportTools) {
    const ids = plan.exportByTool[tool];
    if (ids?.length) {
      lines.push(`→ ${MCP_ACROSS_TOOL_LABELS[tool]}: +${ids.join(', ')}`);
    }
  }
  if (plan.skipped.length > 0) {
    lines.push('', `Ignorado: ${plan.skipped.join('; ')}`);
  }
  lines.push(
    '',
    'Fill-gaps only: nada é apagado. Backup .bak antes de cada write.',
  );
  return lines.join('\n');
}

function syncMode(
  plan: McpSyncPlan,
  exportTools: McpExportToolId[],
): 'both' | 'import' | 'export' {
  const hasImport = plan.importIds.length > 0;
  const hasExport = exportTools.some(
    (t) => (plan.exportByTool[t]?.length ?? 0) > 0,
  );
  if (hasImport && hasExport) return 'both';
  if (hasImport) return 'import';
  return 'export';
}

async function invokeSyncApply(
  input: McpHubSyncApplyInput,
): Promise<SyncApplyResult> {
  const api = window.nexus?.product;
  if (!api?.mcpHubSyncApply) {
    throw new Error('mcpHubSyncApply indisponível — reinicie o app');
  }
  return (await api.mcpHubSyncApply(input)) as SyncApplyResult;
}

export function exportToolsFromPlan(plan: McpSyncPlan): McpExportToolId[] {
  return MCP_EXPORT_TOOL_IDS.filter(
    (t) => (plan.exportByTool[t]?.length ?? 0) > 0,
  );
}

export function countExportGaps(
  plan: McpSyncPlan,
  exportTools: McpExportToolId[],
): number {
  return exportTools.reduce(
    (n, t) => n + (plan.exportByTool[t]?.length ?? 0),
    0,
  );
}

type Props = {
  /** Status narrativo (kicker + linha) — filho do banner herói. */
  status: ReactNode;
  /** `ok` = alinhado; `drift` = precisa Sync; `idle` = ainda sem observe. */
  tone?: 'ok' | 'drift' | 'idle';
  plan: McpSyncPlan | null;
  exportTools: McpExportToolId[];
  onExportToolsChange: (next: McpExportToolId[]) => void;
  busy?: boolean;
  onObserve: () => void | Promise<void>;
  onSynced?: () => void | Promise<void>;
};

/**
 * Ritual one-story: status → CTAs horizontais → chips de export (fora do hero).
 * Shared by Settings → MCPs and product Hub panel.
 */
export function McpAcrossSyncControls({
  status,
  tone = 'idle',
  plan,
  exportTools,
  onExportToolsChange,
  busy = false,
  onObserve,
  onSynced,
}: Props) {
  const pushToast = useToastStore((s) => s.push);
  const [syncing, setSyncing] = useState(false);
  const [dryNote, setDryNote] = useState<string | null>(null);

  const exportGaps = useMemo(
    () => (plan ? countExportGaps(plan, exportTools) : 0),
    [plan, exportTools],
  );

  const toolsWithGaps = useMemo(
    () => (plan ? exportToolsFromPlan(plan) : []),
    [plan],
  );

  const syncLabel =
    plan && (plan.importIds.length > 0 || exportGaps > 0)
      ? `Sync ${plan.importIds.length} → hub · ${exportGaps} gaps`
      : 'Sync fill-gaps';

  function toggleTool(tool: McpExportToolId) {
    onExportToolsChange(
      exportTools.includes(tool)
        ? exportTools.filter((t) => t !== tool)
        : [...exportTools, tool],
    );
    setDryNote(null);
  }

  async function runSync(dryRun: boolean) {
    const api = window.nexus?.product;
    if (!api?.mcpHubSyncApply || !api.mcpHubSyncPlan) return;
    let nextPlan: McpSyncPlan;
    try {
      nextPlan = (await api.mcpHubSyncPlan()) as McpSyncPlan;
    } catch (err) {
      pushToast(
        'error',
        'Sync indisponível',
        err instanceof Error ? err.message : 'feature.mcp.hub?',
      );
      return;
    }

    const selected = exportTools.filter(
      (t) => (nextPlan.exportByTool[t]?.length ?? 0) > 0,
    );
    const hasImport = nextPlan.importIds.length > 0;
    const anyExportGaps = MCP_EXPORT_TOOL_IDS.some(
      (t) => (nextPlan.exportByTool[t]?.length ?? 0) > 0,
    );

    if (!hasImport && !anyExportGaps) {
      pushToast('info', 'Já alinhado', nextPlan.summary);
      return;
    }

    // Fail-closed UX: gaps só de export exigem tools marcadas (opt-in).
    if (!hasImport && selected.length === 0) {
      pushToast(
        'warn',
        'Selecione uma tool',
        'Marque ao menos uma tool com gaps para exportar.',
      );
      return;
    }

    const ok = await askConfirm({
      title: dryRun
        ? 'Simular Sync MCP (dry-run)?'
        : 'Sincronizar MCP Across Tools?',
      body: formatSyncBody(nextPlan, selected, dryRun),
      confirmLabel: dryRun ? 'Simular' : 'Sync fill-gaps',
      cancelLabel: 'Cancelar',
    });
    if (!ok) return;

    setSyncing(true);
    setDryNote(null);
    try {
      const result = await invokeSyncApply({
        dryRun,
        mode: syncMode(nextPlan, selected),
        // Always pass explicit list when exporting — never implicit "all".
        exportTools: selected,
      });
      const toolAdds = result.toolWrites.reduce(
        (n, w) => n + w.added.length,
        0,
      );
      const hubBit = dryRun
        ? nextPlan.importIds.length > 0
          ? `escreveria +${nextPlan.importIds.length}`
          : 'intacto'
        : result.hubWrote
          ? 'atualizado'
          : 'intacto';
      const detail = `Hub ${hubBit} · ${toolAdds} gap(s) → ${
        result.toolWrites.map((w) => w.tool).join(', ') || 'nenhuma tool'
      }`;

      if (dryRun) {
        setDryNote(detail);
        pushToast('info', 'Dry-run ok', detail);
      } else {
        pushToast('success', 'Sync ok', detail);
        await onSynced?.();
      }
    } catch (err) {
      pushToast(
        'error',
        dryRun ? 'Dry-run falhou' : 'Sync falhou',
        err instanceof Error ? err.message : 'erro desconhecido',
      );
    } finally {
      setSyncing(false);
    }
  }

  const locked = busy || syncing;
  const bannerMod =
    tone === 'ok'
      ? ' mcp-ritual__banner--ok'
      : tone === 'drift'
        ? ' mcp-ritual__banner--drift'
        : '';

  return (
    <div className="mcp-ritual__story">
      <div className={`mcp-ritual__banner${bannerMod}`} role="status">
        <div className="mcp-ritual__banner-main">
          <div className="mcp-ritual__banner-copy">{status}</div>
          <div
            className="mcp-ritual__cta-row"
            role="group"
            aria-label="Ritual Across Tools"
          >
            <button
              type="button"
              className="mcp-ritual__btn mcp-ritual__btn--ghost"
              disabled={locked}
              onClick={() => void onObserve()}
            >
              {busy ? 'Observando…' : 'Observe'}
            </button>
            <button
              type="button"
              className="mcp-ritual__btn mcp-ritual__btn--ghost"
              disabled={locked || !plan}
              onClick={() => void runSync(true)}
            >
              Simular
            </button>
            <button
              type="button"
              className="mcp-ritual__btn mcp-ritual__btn--primary"
              disabled={locked || !plan}
              onClick={() => void runSync(false)}
            >
              {syncing ? 'Sync…' : syncLabel}
            </button>
          </div>
        </div>
      </div>

      {toolsWithGaps.length > 0 ? (
        <div
          className="mcp-ritual__export"
          role="group"
          aria-label="Export fill-gaps para tools"
        >
          <span className="mcp-ritual__export-label">Exportar gaps para</span>
          <div className="mcp-ritual__export-chips">
            {toolsWithGaps.map((tool) => {
              const n = plan?.exportByTool[tool]?.length ?? 0;
              const on = exportTools.includes(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  className={`mcp-ritual__chip${on ? ' mcp-ritual__chip--on' : ''}`}
                  aria-pressed={on}
                  disabled={locked}
                  onClick={() => toggleTool(tool)}
                >
                  <span>{MCP_ACROSS_TOOL_LABELS[tool]}</span>
                  <em>
                    {n} gap{n === 1 ? '' : 's'}
                  </em>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {dryNote ? (
        <p className="mcp-ritual__dry" role="status">
          Dry-run: {dryNote}
        </p>
      ) : null}
    </div>
  );
}
