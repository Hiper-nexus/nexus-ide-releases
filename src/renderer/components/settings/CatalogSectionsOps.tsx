import { ProviderLogo } from '../ProviderLogo';
import { useEffect, useState } from 'react';
import type {
  AgentSpecWriteRequest,
  RecipeOverlayResult,
  RemoteBridgeInfo,
  RemoteSpawnResult,
  RemoteSshHostView,
} from '../../../shared/types';
import { RemoteServersSection } from './RemoteServersSection';
import { useOrchStore } from '../../state/orch-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { askConfirm } from '../../state/confirm-store';
import { QrCode } from '../QrCode';
import { waitForSession } from '../../terminal/terminal-host';
import { formatShortcut } from '../../lib/platform';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import {
  SHORTCUT_GROUP_LABELS,
  shortcutsInGroup,
  type ShortcutGroupId,
} from '../../lib/shortcuts';

/**
 * Seções "operacionais" do catálogo — Recipes (lint/overlay), Atalhos e
 * Remote (bridge + ssh/tmux). Extraídas de CatalogSections.tsx para manter
 * cada módulo abaixo do teto de 800 linhas; a API pública não muda porque
 * CatalogSections re-exporta estas seções.
 */

export function RecipesSection() {
  const workspace = useWorkspaceStore((s) => s.current);
  const squads = useOrchStore((s) => s.squads);
  const [overlay, setOverlay] = useState<RecipeOverlayResult | null>(null);
  const [manualStacks, setManualStacks] = useState('');
  const [agentSpec, setAgentSpec] = useState<AgentSpecWriteRequest>({
    name: '',
    tools: [],
    skills: [],
    model: '',
    effort: '',
    category: '',
    systemPrompt: '',
  });
  const [agentSpecResult, setAgentSpecResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.nexus.orch
      .getRecipeOverlay()
      .then((result) => {
        if (!cancelled) {
          setOverlay(result);
          setManualStacks(result.overlay?.stacks.join(', ') ?? '');
        }
      })
      .catch(() => {
        if (!cancelled) setOverlay(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.path, squads, refreshTick]);

  const issues = overlay?.issues ?? [];
  const suggestions = overlay?.suggestions ?? [];
  const categories = Object.entries(overlay?.categories ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  async function saveStacks() {
    await window.nexus.orch.saveCatalogOverlay({
      stacks: manualStacks
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setRefreshTick((tick) => tick + 1);
  }

  async function saveAgentSpec() {
    const result = await window.nexus.orch.writeAgentSpec({
      ...agentSpec,
      tools: (agentSpec.tools ?? []).filter(Boolean),
      skills: (agentSpec.skills ?? []).filter(Boolean),
    });
    setAgentSpecResult(result.ok ? result.path ?? 'salvo' : result.error ?? 'erro');
  }

  return (
    <section className="settings-recipes">
      <SettingsSectionTitle>Fluxos de trabalho</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Equipes sugeridas para este projeto e seus requisitos.
      </p>

      <div className="settings-pill-row">
        <button
          className="settings-btn"
          onClick={() => setRefreshTick((tick) => tick + 1)}
          disabled={loading}
        >
          {loading ? 'Atualizando…' : 'Verificar recursos'}
        </button>
        {(overlay?.stacks.length ? overlay.stacks : ['workspace']).map((stack) => (
          <span key={stack} className="settings-chip">
            {stack}
          </span>
        ))}
        <span className={`settings-chip ${overlay?.ok ? 'settings-chip--ok' : 'settings-chip--warn'}`}>
          {overlay?.ok ? 'Recursos verificados' : `${issues.length} pendências`}
        </span>
      </div>

      <details className="settings-recipes__advanced">
        <summary>Tecnologias do projeto</summary>
      <div className="settings-recipes__stack-editor">
        <div className="settings-list__head">
          <label htmlFor="recipe-project-stacks" className="settings-list__title">Tecnologias separadas por vírgula</label>
          <button className="settings-btn" onClick={() => void saveStacks()}>
            Salvar
          </button>
        </div>
        <input
          id="recipe-project-stacks"
          className="settings-input"
          value={manualStacks}
          placeholder="react, electron, rust"
          onChange={(e) => setManualStacks(e.target.value)}
        />
      </div>

      </details>

      {suggestions.length > 0 && (
        <ul className="settings-list">
          {suggestions.map((recipe) => (
            <li key={recipe.id} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{recipe.title}</span>
                <span className="settings-recipes__roles">{recipe.agents.join(' · ')}</span>
              </div>
              <details className="settings-advanced-field"><summary>Recursos necessários</summary>
              <p className="settings-list__detail">
                Ferramentas: {recipe.tools.join(', ')}
              </p>
              {recipe.gaps.length > 0 && (
                <p className="settings-list__detail">Pendências: {recipe.gaps.join(', ')}</p>
              )}
              </details>
            </li>
          ))}
        </ul>
      )}

      <details className="settings-advanced-field"><summary>Criar um agente personalizado</summary>
      <div className="settings-list__item">
        <div className="settings-list__head">
          <span className="settings-list__title">Criar arquivo de agente</span>
          <button
            className="settings-btn"
            onClick={() => void saveAgentSpec()}
            disabled={!agentSpec.name.trim()}
          >
            Salvar agente
          </button>
        </div>
        <div className="settings-form-grid">
          <input
            className="settings-input"
            value={agentSpec.name}
            placeholder="Nome do agente"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, name: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.model}
            placeholder="modelo"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, model: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.effort}
            placeholder="Nível de raciocínio"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, effort: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.category}
            placeholder="categoria"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, category: e.target.value }))}
          />
        </div>
        <input
          className="settings-input"
          value={(agentSpec.tools ?? []).join(', ')}
          placeholder="Ferramentas separadas por vírgula"
          onChange={(e) =>
            setAgentSpec((prev) => ({
              ...prev,
              tools: e.target.value.split(',').map((item) => item.trim()),
            }))
          }
        />
        <textarea
          className="settings-textarea"
          value={agentSpec.systemPrompt}
          placeholder="Instruções do agente"
          onChange={(e) =>
            setAgentSpec((prev) => ({ ...prev, systemPrompt: e.target.value }))
          }
        />
        {agentSpecResult && (
          <p className="settings-list__detail">{agentSpecResult}</p>
        )}
      </div>
      </details>

      {categories.length > 0 && (
        <details className="settings-recipes__advanced"><summary>Agentes por especialidade</summary>
        <ul className="settings-list settings-list--compact">
          {categories.map(([category, count]) => (
            <li key={category} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{category}</span>
                <span className="settings-chip">{count}</span>
              </div>
            </li>
          ))}
        </ul></details>
      )}

      {issues.length === 0 ? (
        <p className="settings-detail__hint">
          Nenhuma pendência nas ferramentas e instruções declaradas.
        </p>
      ) : (
        <details className="settings-advanced-field"><summary>Ver {issues.length} pendências de configuração</summary>
        <ul className="settings-list">
          {issues.map((issue, index) => (
            <li key={`${issue.squadId}-${issue.agentId}-${issue.ref}-${index}`} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">
                  {issue.agentName ?? issue.squadName}
                </span>
                <span className="settings-chip settings-chip--warn">{issue.field}</span>
              </div>
              <p className="settings-list__detail">{issue.message}</p>
              <p className="settings-list__detail">
                {issue.squadName} · {issue.ref}
              </p>
            </li>
          ))}
        </ul>        </details>
      )}
    </section>
  );
}

/**
 * Gestos de mouse: não são atalhos de teclado e por isso não moram no
 * catálogo compartilhado — mas o operador procura os dois no mesmo lugar.
 */
const GESTURES: Array<{ keys: string; action: string }> = [
  { keys: 'clique', action: 'Focar pane' },
  // Controles da barra, não teclas — mas o operador procura os dois aqui.
  // Antes vinham como glifos Unicode soltos (⬡ ☾ ☀), dívida pelo DESIGN.md §5.
  { keys: 'botão Canvas', action: 'Alternar entre grade e canvas (barra)' },
  {
    keys: 'botão do pane',
    action: 'Hibernar ou acordar o pane (barra do pane)',
  },
];

const SHORTCUT_GROUP_ORDER: ShortcutGroupId[] = [
  'command',
  'fleet',
  'surfaces',
];

export function ShortcutsSection() {
  return (
    <section className="catalog-settings catalog-settings--shortcuts">
      <SettingsSectionTitle>Atalhos</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Atalhos de teclado e mouse. Abra esta lista com (
        {formatShortcut('mod', '/')}).
      </p>
      {SHORTCUT_GROUP_ORDER.map((groupId) => (
        <div key={groupId}>
          <p className="arsenal-band__label">
            {SHORTCUT_GROUP_LABELS[groupId]}
          </p>
          <ul className="settings-list">
            {shortcutsInGroup(groupId).map((shortcut) => (
              <li key={shortcut.id} className="settings-list__item">
                <div className="settings-list__head">
                  <span className="settings-list__title settings-list__title--mono">
                    {shortcut.keys}
                  </span>
                  <span className="settings-list__detail">
                    {shortcut.action}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="arsenal-band__label">Mouse</p>
      <ul className="settings-list">
        {GESTURES.map((gesture) => (
          <li key={gesture.keys} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title settings-list__title--mono">
                {gesture.keys}
              </span>
              <span className="settings-list__detail">{gesture.action}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RemoteSection() {
  const [info, setInfo] = useState<RemoteBridgeInfo | null>(null);
  const [hosts, setHosts] = useState<RemoteSshHostView[]>([]);
  const [target, setTarget] = useState('');
  const [cli, setCli] = useState<'claude' | 'codex' | 'agy' | 'kimi'>('claude');
  const [sessionName, setSessionName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<RemoteSpawnResult | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  async function refresh() {
    const [bridge, list] = await Promise.all([
      window.nexus.remote.bridgeStatus(),
      window.nexus.remote.listSshHosts(),
    ]);
    setInfo(bridge);
    setHosts(list);
    setTarget((current) => current || list[0]?.alias || '');
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createRemote() {
    setTerminalError(null);
    const next = await window.nexus.remote.createTmux({
      target,
      cli,
      sessionName: sessionName || undefined,
      prompt: prompt || undefined,
    });
    setResult(next);
    if (next.ok && next.attachCommand) {
      const proceed = await askConfirm({
        title: 'Anexar à sessão tmux?',
        body: `Abrir um shell pane e executar automaticamente: ${next.attachCommand}`,
        confirmLabel: 'Abrir e executar',
      });
      if (!proceed) return;
      const layout = useLayoutStore.getState();
      const paneId = layout.addShellPane({ focus: false });
      let sessionId: string | null = null;
      try {
        sessionId = await waitForSession(paneId);
      } catch {
        // The announced failure below owns error presentation.
      }
      if (!sessionId) {
        layout.close(paneId, 'settings-remote-terminal-unavailable');
        setTerminalError(
          'O terminal remoto não ficou disponível. A sessão não foi anexada.',
        );
        return;
      }
      window.nexus.pty.write(sessionId, `${next.attachCommand}\n`);
      layout.focus(paneId);
      useProductNavigationStore.getState().openTerminal();
    }
  }

  return (
    <section className="settings-stack">
      <header className="settings-stack__header">
        <div>
          <SettingsSectionTitle>Remoto</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Conecte servidores pelo apelido ou acesse o Nexus pelo celular na rede local.
          </p>
        </div>
      </header>

      <RemoteServersSection
        onHostsChange={(list) => {
          setHosts([...list]);
          setTarget((current) =>
            list.some((host) => host.alias === current)
              ? current
              : list[0]?.alias ?? '',
          );
        }}
      />

      <section className="settings-card" aria-labelledby="remote-bridge-title">
        <div className="settings-card__head">
          <div className="settings-card__titles">
            <h3 id="remote-bridge-title" className="settings-card__title">
              Celular na rede local
            </h3>
            <p className="settings-card__subtitle">
              Conecte o celular na mesma rede usando o código ou QR code.
            </p>
          </div>
          <span
            className={`settings-status-pill ${
              info?.running ? 'settings-status-pill--ok' : 'settings-status-pill--warn'
            }`}
          >
            {info?.running ? 'Online' : 'Offline'}
          </span>
        </div>

        <div className="settings-action-row" role="group" aria-label="Ações do bridge">
          <button
            type="button"
            className="settings-btn"
            onClick={async () => {
              setInfo(await window.nexus.remote.bridgeStart());
            }}
            title="Só este computador (127.0.0.1)"
          >
            Iniciar neste computador
          </button>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={async () => {
              setInfo(await window.nexus.remote.bridgeStart({ host: '0.0.0.0' }));
            }}
            title="Expõe na rede local para o celular conectar — só faça em redes de confiança"
          >
            Iniciar na rede local
          </button>
          <button
            type="button"
            className="settings-btn"
            onClick={async () => {
              setInfo(await window.nexus.remote.bridgeRotatePairing());
            }}
          >
            Novo código
          </button>
          <button
            type="button"
            className="settings-btn"
            onClick={async () => {
              setInfo(await window.nexus.remote.bridgeRevokeTokens());
            }}
          >
            Revogar acessos
          </button>
        </div>

        {info ? (
          <div className="settings-card__body">
            <div className="settings-meta-grid">
              <div className="settings-meta">
                <span className="settings-meta__label">Código</span>
                <strong className="settings-meta__value settings-meta__value--mono">
                  {info.pairingCode ?? '------'}
                </strong>
              </div>
              <div className="settings-meta">
                <span className="settings-meta__label">Tokens</span>
                <strong className="settings-meta__value">
                  {info.tokenCount}
                </strong>
              </div>
              <div className="settings-meta">
                <span className="settings-meta__label">Clientes</span>
                <strong className="settings-meta__value">
                  {info.clientCount}
                </strong>
              </div>
              <div className="settings-meta settings-meta--wide">
                <span className="settings-meta__label">URL</span>
                <strong className="settings-meta__value settings-meta__value--mono">
                  {info.urls.join(' · ') || 'sem URL ativa'}
                </strong>
              </div>
              <div className="settings-meta settings-meta--wide">
                <span className="settings-meta__label">Certificado</span>
                <strong className="settings-meta__value settings-meta__value--mono">
                  {info.certFingerprint ?? '—'}
                </strong>
              </div>
            </div>

            {info.urls.length > 0
              ? (() => {
                  const lanUrl = info.urls
                    .filter((u) => !u.includes('127.0.0.1'))
                    .map((u) => u.replace('wss://', 'https://'))[0];
                  return (
                    <div className="settings-card__aside">
                      <p className="settings-card__note">
                        {lanUrl
                          ? `Abra no celular: ${lanUrl}`
                          : 'Só localhost — inicie em LAN e conecte na mesma rede.'}
                      </p>
                      {lanUrl ? (
                        <div className="settings-qr">
                          <QrCode
                            value={`${lanUrl}#code=${info.pairingCode ?? ''}`}
                            size={180}
                            label="QR code para parear o celular"
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })()
              : null}
          </div>
        ) : (
          <p className="settings-card__note">Carregando estado do bridge…</p>
        )}
      </section>

      <section className="settings-card" aria-labelledby="remote-ssh-title">
        <div className="settings-card__head">
          <div className="settings-card__titles">
            <h3 id="remote-ssh-title" className="settings-card__title">
              SSH / tmux
            </h3>
            <p className="settings-card__subtitle">
              Abre tmux no apelido já conectado. Sem apelido na lista acima,
              este formulário não tem destino.
            </p>
          </div>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={() => void createRemote()}
            disabled={!target.trim() || hosts.length === 0}
          >
            Criar / adotar
          </button>
        </div>

        <div className="settings-form-grid settings-form-grid--remote">
          <label className="settings-field">
            <span className="settings-field__label">Apelido</span>
            <select
              className="settings-input"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={hosts.length === 0}
            >
              {hosts.length === 0 ? (
                <option value="">Conecte um servidor primeiro</option>
              ) : (
                hosts.map((host) => (
                  <option key={host.alias} value={host.alias}>
                    {host.alias}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field__label"><ProviderLogo adapterId={cli} label={cli} size="xs" /> Ferramenta de IA</span>
            <select
              className="settings-input"
              value={cli}
              onChange={(e) => setCli(e.target.value as typeof cli)}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="agy">agy</option>
              <option value="kimi">kimi</option>
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Sessão tmux</span>
            <input
              className="settings-input"
              value={sessionName}
              placeholder="opcional"
              onChange={(e) => setSessionName(e.target.value)}
            />
          </label>
          <label className="settings-field settings-field--wide">
            <span className="settings-field__label">Prompt inicial</span>
            <textarea
              className="settings-textarea"
              value={prompt}
              placeholder="Mensagem opcional ao abrir a sessão"
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </label>
        </div>

        {result ? (
          <p className="settings-card__note" role="status">
            {result.ok ? result.attachCommand : result.error}
          </p>
        ) : null}
        {terminalError ? (
          <p className="settings-error" role="alert">
            {terminalError}
          </p>
        ) : null}
      </section>
    </section>
  );
}
