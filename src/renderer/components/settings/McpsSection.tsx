import { useCallback, useEffect, useRef, useState } from 'react';
import type { McpAcrossToolsReport } from '../../../shared/mcp-across-tools';
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

  return (
    <section className="arsenal-section mcp-ritual" aria-label="MCPs">
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
      {across ? <details className="settings-advanced-field"><summary>Comparar conexões por aplicativo</summary><McpAcrossToolsMatrix report={across} hideBanner /></details> : null}

      {hubError ? (
        <p className="settings-list__detail" role="note">
          Hub canônico: {hubError}
        </p>
      ) : null}

      <ul className="settings-list">
        <li className="settings-list__item arsenal-card">
          <div className="settings-list__head">
            <span className="settings-list__title">
              <PixelIcon name="bolt" size={12} /> nexus (embutido)
            </span>
            <span
              className={`settings-chip ${
                loading
                  ? ''
                  : running
                    ? 'settings-chip--ok'
                    : 'settings-chip--warn'
              }`}
            >
              {loading ? '…' : running ? 'online' : 'offline'}
            </span>
            <button
              type="button"
              className="settings-btn settings-btn--sm"
              onClick={() =>
                useProductNavigationStore.getState().openSettings('tools')
              }
            >
              Ver ferramentas
            </button>
          </div>
          <details className="settings-advanced-field">
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
    </section>
  );
}
