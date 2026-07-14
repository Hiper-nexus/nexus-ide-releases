import type {
  McpAcrossToolsReport,
  McpCellState,
  McpAcrossToolId,
} from '../../shared/mcp-across-tools';
import { MCP_ACROSS_TOOL_IDS } from '../../shared/mcp-across-tools';

/**
 * Matrix Bridge-style: servers × tools, células só com evidência de disco.
 */

function cellGlyph(state: McpCellState): string {
  if (state === 'present') return '✓';
  if (state === 'absent') return '·';
  return '—';
}

function cellTitle(
  tool: McpAcrossToolId,
  state: McpCellState,
  server: string,
): string {
  if (state === 'present') return `${server} presente em ${tool}`;
  if (state === 'absent') return `${server} ausente em ${tool}`;
  return `${tool}: config não lida`;
}

export function McpAcrossToolsMatrix({
  report,
  /** When true, omit status banner (parent already shows CTAs). */
  hideBanner = false,
}: {
  report: McpAcrossToolsReport;
  hideBanner?: boolean;
}) {
  const cols = report.columns.filter((c) =>
    (MCP_ACROSS_TOOL_IDS as readonly string[]).includes(c.id),
  );

  return (
    <div className="mcp-matrix" data-testid="mcp-across-tools">
      {hideBanner ? null : (
        <div
          className={`mcp-ritual__banner${
            report.driftCount === 0
              ? ' mcp-ritual__banner--ok'
              : ' mcp-ritual__banner--drift'
          }`}
          role="status"
        >
          <div className="mcp-ritual__banner-main">
            <div className="mcp-ritual__banner-copy">
              <span className="mcp-ritual__banner-kicker">
                <span className="mcp-ritual__banner-label">
                  {report.bannerKicker}
                </span>
                {report.driftCount > 0 ? (
                  <span className="mcp-ritual__pill mcp-ritual__pill--drift">
                    {report.driftCount} drift
                  </span>
                ) : (
                  <span className="mcp-ritual__pill mcp-ritual__pill--ok">
                    alinhado
                  </span>
                )}
              </span>
              <span className="mcp-ritual__banner-line">
                {report.bannerLine}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="mcp-matrix__tools" aria-label="Tools observadas">
        {cols.map((col) => (
          <div
            key={col.id}
            className={`mcp-ritual__source mcp-matrix__tool mcp-matrix__tool--${col.status}`}
            title={col.path ?? col.error ?? col.label}
          >
            <strong>{col.label}</strong>
            <span>
              {col.status === 'ok'
                ? `${col.serverCount} server${col.serverCount === 1 ? '' : 's'}`
                : col.status === 'missing'
                  ? 'MISSING'
                  : 'ERROR'}
            </span>
          </div>
        ))}
      </div>

      {report.rows.length === 0 ? (
        <p className="mcp-matrix__empty">
          Nenhum server MCP encontrado nas configs lidas.
        </p>
      ) : (
        <div className="mcp-matrix__scroll">
          <table className="mcp-matrix__table">
            <thead>
              <tr>
                <th scope="col">Server</th>
                {cols.map((col) => (
                  <th key={col.id} scope="col" title={col.path ?? undefined}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => {
                const drifted =
                  Object.values(row.cells).includes('present') &&
                  Object.values(row.cells).includes('absent');
                return (
                  <tr
                    key={row.serverKey}
                    className={drifted ? 'mcp-matrix__row--drift' : undefined}
                  >
                    <th scope="row">
                      <span className="mcp-matrix__row-label">
                        {row.label}
                        {drifted ? (
                          <span className="mcp-ritual__pill mcp-ritual__pill--drift">
                            DRIFT
                          </span>
                        ) : null}
                      </span>
                    </th>
                    {cols.map((col) => {
                      const state = row.cells[col.id];
                      return (
                        <td
                          key={col.id}
                          className={`mcp-matrix__cell mcp-matrix__cell--${state}`}
                          title={cellTitle(col.id, state, row.label)}
                          aria-label={cellTitle(col.id, state, row.label)}
                        >
                          <span aria-hidden="true">{cellGlyph(state)}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
