import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MCP_ACROSS_TOOL_IDS,
  type McpAcrossToolsReport,
} from '../../../shared/mcp-across-tools';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { PixelIcon } from '../PixelIcon';
import { McpAcrossToolsMatrix } from '../McpAcrossToolsMatrix';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import {
  exportToolsFromPlan,
  McpAcrossSyncControls,
  type McpExportToolId,
  type McpSyncPlan,
} from '../McpAcrossSyncControls';

type HubLoad = {
  path?: string;
  config?: { servers?: Array<{ id: string }> };
};

/**
 * Settings → MCPs: observe Across Tools + Sync fill-gaps
 * (dry-run + opt-in por tool + confirm + backup).
 */

export function McpsSection() {
  const storeInfo = useOrchStore((s) => s.mcpInfo);
  const [mcpInfo, setMcpInfo] = useState(storeInfo);
  const [loading, setLoading] = useState(!storeInfo);
  const [hub, setHub] = useState<HubLoad | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [across, setAcross] = useState<McpAcrossToolsReport | null>(null);
  const [acrossError, setAcrossError] = useState<string | null>(null);
  const [plan, setPlan] = useState<McpSyncPlan | null>(null);
  const [exportTools, setExportTools] = useState<McpExportToolId[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const refreshGen = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++refreshGen.current;
    setRefreshing(true);
    setLoading(true);
    try {
      try {
        const info = await window.nexus.orch.getMcpInfo();
        if (gen !== refreshGen.current) return;
        setMcpInfo(info);
      } catch {
        if (gen !== refreshGen.current) return;
        // Keep prior mcpInfo; banner falls back to hub/across probes.
      } finally {
        if (gen === refreshGen.current) setLoading(false);
      }

      const api = window.nexus?.product;
      if (!api) {
        if (gen !== refreshGen.current) return;
        setHub(null);
        setAcross(null);
        setPlan(null);
        return;
      }

      try {
        if (api.mcpHubLoad) {
          const loaded = (await api.mcpHubLoad()) as HubLoad;
          if (gen !== refreshGen.current) return;
          setHub(loaded);
          setHubError(null);
        }
      } catch (err) {
        if (gen !== refreshGen.current) return;
        setHub(null);
        setHubError(err instanceof Error ? err.message : 'Hub MCP indisponível');
      }

      try {
        if (api.mcpHubObserve) {
          const report = (await api.mcpHubObserve()) as McpAcrossToolsReport;
          if (gen !== refreshGen.current) return;
          setAcross(report);
          setAcrossError(null);
        }
      } catch (err) {
        if (gen !== refreshGen.current) return;
        setAcross(null);
        setAcrossError(
          err instanceof Error ? err.message : 'Falha ao observar tools',
        );
      }

      try {
        if (api.mcpHubSyncPlan) {
          const next = (await api.mcpHubSyncPlan()) as McpSyncPlan;
          if (gen !== refreshGen.current) return;
          setPlan(next);
          setExportTools(exportToolsFromPlan(next));
        }
      } catch {
        if (gen !== refreshGen.current) return;
        setPlan(null);
      }
    } finally {
      if (gen === refreshGen.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = Boolean(mcpInfo?.running);
  const toolCount = mcpInfo?.toolCount ?? 0;
  const ritualTone =
    across == null
      ? ('idle' as const)
      : across.driftCount === 0
        ? ('ok' as const)
        : ('drift' as const);

  const acrossCols =
    across?.columns.filter((c) =>
      (MCP_ACROSS_TOOL_IDS as readonly string[]).includes(c.id),
    ) ?? [];
  const hubServers = hub?.config?.servers ?? [];

  return (
    <section className="arsenal-section mcp-ritual mcps-section" aria-label="MCPs">
      <header className="arsenal-section__intro">
        <SettingsSectionTitle>Conexões de ferramentas</SettingsSectionTitle>
        <p className="settings-detail__hint">
          Compare as conexões entre suas ferramentas de IA. Simular mostra uma prévia;
          sincronizar adiciona as conexões ausentes, com confirmação e cópia de segurança.
        </p>
      </header>

      <McpAcrossSyncControls
        tone={ritualTone}
        plan={plan}
        exportTools={exportTools}
        onExportToolsChange={setExportTools}
        busy={refreshing}
        onObserve={refresh}
        onSynced={refresh}
        status={
          <>
            <span className="mcp-ritual__banner-kicker">
              <span className="mcp-ritual__banner-label">Conexões entre apps</span>
              {across ? (
                across.driftCount > 0 ? (
                  <span className="mcp-ritual__pill mcp-ritual__pill--drift">
                    {across.driftCount} diferenças
                  </span>
                ) : (
                  <span className="mcp-ritual__pill mcp-ritual__pill--ok">
                    alinhado
                  </span>
                )
              ) : (
                <span className="mcp-ritual__pill mcp-ritual__pill--miss">
                  {loading ? '…' : running ? 'armado' : 'offline'}
                </span>
              )}
            </span>
            <span className="mcp-ritual__banner-line">
              {across ? `${across.driftCount} conexões com diferenças entre os aplicativos.` :
                (loading
                  ? 'Verificando conexões…'
                  : running
                    ? `${toolCount} ferramentas disponíveis${hub?.config?.servers ? ` · ${hub.config.servers.length} no hub` : ''}`
                    : 'Agentes sem ferramentas até o servidor voltar.')}
            </span>
          </>
        }
      />

      {acrossError ? (
        <p className="settings-list__detail" role="alert">
          Across Tools: {acrossError}
        </p>
      ) : null}

      <div className="arsenal-band">
        <h3 className="arsenal-band__label">Servidor do Nexus</h3>
        <ul className="settings-list">
          <li className="settings-list__item arsenal-card mcps-server">
            <div className="settings-list__head">
              <span className="settings-list__title">
                <PixelIcon name="bolt" size={12} /> nexus (embutido)
              </span>
              <span
                className={`settings-chip mcps-state ${
                  loading
                    ? ''
                    : running
                      ? 'settings-chip--ok'
                      : 'settings-chip--warn'
                }`}
              >
                <span className="media-state-dot" aria-hidden="true" />
                {loading ? '…' : running ? 'online' : 'offline'}
              </span>
              {!loading && running && (
                <span className="settings-chip">
                  {toolCount}{' '}
                  {toolCount === 1 ? 'ferramenta exposta' : 'ferramentas expostas'}
                </span>
              )}
              <button
                type="button"
                className="settings-btn settings-btn--sm mcps-server__action"
                onClick={() =>
                  useProductNavigationStore.getState().openSettings('tools')
                }
              >
                Ver ferramentas
              </button>
            </div>
            <details className="settings-advanced-field mcps-server__details">
            <summary>Detalhes da conexão local</summary>
            <p className="settings-list__detail">
              Endereço: <code>{mcpInfo?.url ?? '—'}</code>
            </p>
            {hub?.path ? (
              <p className="settings-list__detail arsenal-card__hint">
                Hub: <code>{hub.path}</code>
              </p>
            ) : null}
            </details>
          </li>
        </ul>
      </div>

      {across && across.rows.length > 0 ? (
        <div className="arsenal-band">
          <h3 className="arsenal-band__label">
            Servidores detectados{' '}
            <span className="arsenal-band__count">{across.rows.length}</span>
          </h3>
          <ul className="settings-list mcps-server-list">
            {across.rows.map((row) => {
              const presentIn = acrossCols
                .filter((c) => row.cells[c.id] === 'present')
                .map((c) => c.label);
              const absentIn = acrossCols
                .filter((c) => row.cells[c.id] === 'absent')
                .map((c) => c.label);
              const drifted = presentIn.length > 0 && absentIn.length > 0;
              return (
                <li
                  key={row.serverKey}
                  className="settings-list__item mcps-server"
                >
                  <div className="settings-list__head">
                    <span className="settings-list__title settings-list__title--mono">
                      {row.label}
                    </span>
                    <span
                      className={`settings-chip mcps-state ${
                        drifted
                          ? 'settings-chip--warn'
                          : 'settings-chip--ok'
                      }`}
                    >
                      <span className="media-state-dot" aria-hidden="true" />
                      {drifted ? 'Com diferenças' : 'Alinhado'}
                    </span>
                  </div>
                  <p className="settings-list__detail">
                    {presentIn.length > 0
                      ? `Presente em: ${presentIn.join(' · ')}`
                      : 'Sem presença confirmada nas configs lidas.'}
                    {drifted ? ` Ausente em: ${absentIn.join(' · ')}.` : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {across ? <details className="settings-advanced-field"><summary>Comparar conexões por aplicativo</summary><McpAcrossToolsMatrix report={across} hideBanner /></details> : null}

      {hubError ? (
        <p className="settings-list__detail" role="note">
          Configuração principal das conexões: {hubError}
        </p>
      ) : null}

      {hubServers.length > 0 ? (
        <div className="arsenal-band">
          <h3
            className="arsenal-band__label"
            title="Lista central de conexões (hub MCP) que o Nexus entrega aos agentes"
          >
            Configuração principal{' '}
            <span className="arsenal-band__count">{hubServers.length}</span>
          </h3>
          <ul
            className="mcps-hub"
            aria-label="Conexões na configuração principal"
          >
            {hubServers.map((server) => (
              <li key={server.id} className="mcps-hub__item">
                <code>{server.id}</code>
              </li>
            ))}
          </ul>
          {hub?.path ? (
            <p className="settings-list__detail arsenal-card__hint">
              Configuração: <code>{hub.path}</code>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
