import { useEffect, useState } from 'react';
import type {
  AgentSpecWriteRequest,
  RecipeOverlayResult,
  RemoteBridgeInfo,
  RemoteSpawnResult,
} from '../../../shared/types';
import { useOrchStore } from '../../state/orch-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useLayoutStore } from '../../state/layout-store';
import { askConfirm } from '../../state/confirm-store';
import { QrCode } from '../QrCode';
import { waitForSession } from '../../terminal/terminal-host';

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
      .getRecipeOverlay(workspace?.path)
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
      workspacePath: workspace?.path,
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
    <section>
      <h3 className="settings-detail__title">Recipes</h3>
      <p className="settings-detail__hint">
        Lint de squads/recipes contra catálogo local. Referências inexistentes
        precisam de gap explícito no formato <code>gap:nome: motivo</code>.
      </p>

      <div className="settings-pill-row">
        <button
          className="settings-btn"
          onClick={() => setRefreshTick((tick) => tick + 1)}
          disabled={loading}
        >
          {loading ? 'Atualizando…' : 'Atualizar lint'}
        </button>
        {(overlay?.stacks.length ? overlay.stacks : ['workspace']).map((stack) => (
          <span key={stack} className="settings-chip">
            {stack}
          </span>
        ))}
        <span className={`settings-chip ${overlay?.ok ? 'settings-chip--ok' : 'settings-chip--warn'}`}>
          {overlay?.ok ? 'lint ok' : `${issues.length} issue(s)`}
        </span>
      </div>

      <div className="settings-list__item">
        <div className="settings-list__head">
          <span className="settings-list__title">Overlay de stacks</span>
          <button className="settings-btn" onClick={() => void saveStacks()}>
            Salvar
          </button>
        </div>
        <input
          className="settings-input"
          value={manualStacks}
          placeholder="react, electron, rust"
          onChange={(e) => setManualStacks(e.target.value)}
        />
      </div>

      {suggestions.length > 0 && (
        <ul className="settings-list">
          {suggestions.map((recipe) => (
            <li key={recipe.id} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{recipe.title}</span>
                <span className="settings-chip">{recipe.agents.join(' · ')}</span>
              </div>
              <p className="settings-list__detail">
                tools: {recipe.tools.join(', ')}
              </p>
              {recipe.gaps.length > 0 && (
                <p className="settings-list__detail">gaps: {recipe.gaps.join(', ')}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="settings-list__item">
        <div className="settings-list__head">
          <span className="settings-list__title">Agent spec writer</span>
          <button
            className="settings-btn"
            onClick={() => void saveAgentSpec()}
            disabled={!agentSpec.name.trim()}
          >
            Salvar agent
          </button>
        </div>
        <div className="settings-form-grid">
          <input
            className="settings-input"
            value={agentSpec.name}
            placeholder="nome-do-agent"
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
            placeholder="effort"
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
          placeholder="tools separadas por vírgula"
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
          placeholder="system prompt"
          onChange={(e) =>
            setAgentSpec((prev) => ({ ...prev, systemPrompt: e.target.value }))
          }
        />
        {agentSpecResult && (
          <p className="settings-list__detail">{agentSpecResult}</p>
        )}
      </div>

      {categories.length > 0 && (
        <ul className="settings-list settings-list--compact">
          {categories.map(([category, count]) => (
            <li key={category} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{category}</span>
                <span className="settings-chip">{count}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {issues.length === 0 ? (
        <p className="settings-detail__hint">
          Nenhum problema encontrado em allowedTools/allowedSkills.
        </p>
      ) : (
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
        </ul>
      )}
    </section>
  );
}

const SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: '⌘D', action: 'Split à direita' },
  { keys: '⌘⇧D', action: 'Split abaixo' },
  { keys: '⌘W', action: 'Fechar pane focado' },
  { keys: 'clique', action: 'Focar pane' },
  { keys: '⬡ Canvas', action: 'Alternar grid ↔ canvas (barra)' },
  { keys: '☾ / ☀', action: 'Dormir/acordar pane' },
  { keys: 'Space (segurar)', action: 'Push-to-talk de voz (configurável)' },
];

export function ShortcutsSection() {
  return (
    <section>
      <h3 className="settings-detail__title">Atalhos</h3>
      <p className="settings-detail__hint">Teclado e gestos do workspace.</p>
      <ul className="settings-list">
        {SHORTCUTS.map((shortcut) => (
          <li key={shortcut.keys} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title settings-list__title--mono">
                {shortcut.keys}
              </span>
              <span className="settings-list__detail">{shortcut.action}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RemoteSection() {
  const [info, setInfo] = useState<RemoteBridgeInfo | null>(null);
  const [target, setTarget] = useState('');
  const [cli, setCli] = useState<'claude' | 'codex' | 'agy' | 'kimi'>('claude');
  const [sessionName, setSessionName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<RemoteSpawnResult | null>(null);

  async function refresh() {
    setInfo(await window.nexus.remote.bridgeStatus());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createRemote() {
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
      const paneId = useLayoutStore.getState().addShellPane();
      const sessionId = await waitForSession(paneId);
      if (sessionId) window.nexus.pty.write(sessionId, `${next.attachCommand}\n`);
    }
  }

  return (
    <section>
      <h3 className="settings-detail__title">Remote</h3>
      <div className="settings-pill-row">
        <span className={`settings-chip ${info?.running ? 'settings-chip--ok' : 'settings-chip--warn'}`}>
          {info?.running ? 'wss online' : 'offline'}
        </span>
        <button
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeStart());
          }}
          title="Só este computador (127.0.0.1)"
        >
          Iniciar (local)
        </button>
        <button
          className="settings-btn settings-btn--primary"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeStart({ host: '0.0.0.0' }));
          }}
          title="Expõe na rede local para o celular conectar — só faça em redes de confiança"
        >
          Iniciar (LAN — celular)
        </button>
        <button
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeRotatePairing());
          }}
        >
          Novo código
        </button>
        <button
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeRevokeTokens());
          }}
        >
          Revogar tokens
        </button>
      </div>

      {info && (
        <ul className="settings-list">
          <li className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title settings-list__title--mono">
                {info.pairingCode ?? '------'}
              </span>
              <span className="settings-chip">{info.tokenCount} token(s)</span>
            </div>
            <p className="settings-list__detail">
              {info.urls.join(' · ') || 'sem URL ativa'}
            </p>
            {info.urls.length > 0 && (() => {
              const lanUrl = info.urls
                .filter((u) => !u.includes('127.0.0.1'))
                .map((u) => u.replace('wss://', 'https://'))[0];
              return (
                <>
                  <p className="settings-list__detail">
                    📱 abra no celular:{' '}
                    {lanUrl ?? 'só localhost — inicie em LAN e conecte na mesma rede'}
                  </p>
                  {lanUrl && (
                    <div className="settings-qr">
                      <QrCode
                        value={`${lanUrl}#code=${info.pairingCode ?? ''}`}
                        size={180}
                        label="QR code para parear o celular"
                      />
                    </div>
                  )}
                </>
              );
            })()}
            <p className="settings-list__detail">
              cert: {info.certFingerprint ?? '—'} · clients: {info.clientCount}
            </p>
          </li>
        </ul>
      )}

      <div className="settings-list__item">
        <div className="settings-list__head">
          <span className="settings-list__title">SSH/tmux</span>
          <button
            className="settings-btn"
            onClick={() => void createRemote()}
            disabled={!target.trim()}
          >
            Criar/adotar
          </button>
        </div>
        <div className="settings-form-grid">
          <input
            className="settings-input"
            value={target}
            placeholder="user@host"
            onChange={(e) => setTarget(e.target.value)}
          />
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
          <input
            className="settings-input"
            value={sessionName}
            placeholder="tmux session"
            onChange={(e) => setSessionName(e.target.value)}
          />
        </div>
        <textarea
          className="settings-textarea"
          value={prompt}
          placeholder="prompt inicial"
          onChange={(e) => setPrompt(e.target.value)}
        />
        {result && (
          <p className="settings-list__detail">
            {result.ok ? result.attachCommand : result.error}
          </p>
        )}
      </div>
    </section>
  );
}
