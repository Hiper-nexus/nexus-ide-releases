import { ProviderLogo } from '../ProviderLogo';
import { PixelIcon } from '../PixelIcon';
import { Fragment, useEffect, useState } from 'react';
import type {
  AgentSpecWriteRequest,
  RecipeOverlayResult,
  RemoteSpawnResult,
  RemoteSshHostView,
} from '../../../shared/types';
import { RemoteServersSection } from './RemoteServersSection';
import { useOrchStore } from '../../state/orch-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useLayoutStore } from '../../state/layout-store';
import { reportLicenseDenial } from '../../state/access-guard';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { askConfirm } from '../../state/confirm-store';
import { waitForSession } from '../../terminal/terminal-host';
import { formatShortcut } from '../../lib/platform';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import {
  recipeIssueKind,
  sortRecipeIssues,
  summarizeRecipeIssues,
  type RecipeIssueKind,
} from './recipe-issues-summary';

const RECIPE_ISSUE_KIND_LABEL: Readonly<Record<RecipeIssueKind, string>> = {
  'missing-tool': 'ferramenta ausente',
  'missing-skill': 'instrução ausente',
  'unrestricted-tools': 'sem lista de ferramentas',
  'invalid-gap': 'anotação incompleta',
};
import {
  SHORTCUT_GROUP_LABELS,
  shortcutsInGroup,
  type ShortcutGroupId,
} from '../../lib/shortcuts';

/**
 * Seções "operacionais" do catálogo — Recipes (lint/overlay), Atalhos e
 * Remote (ssh/tmux; o bridge do celular vive em CompanionRelaySection). Extraídas de CatalogSections.tsx para manter
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

  const issues = sortRecipeIssues(overlay?.issues ?? []);
  const issueSummary = summarizeRecipeIssues(issues);
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
    <section className="catalog-settings settings-recipes">
      <header className="catalog-settings__header">
        <div>
          <SettingsSectionTitle>Fluxos de trabalho</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Equipes sugeridas para este projeto e seus requisitos.
          </p>
        </div>
        <button
          type="button"
          className="settings-btn"
          onClick={() => setRefreshTick((tick) => tick + 1)}
          disabled={loading}
        >
          {loading ? 'Verificando…' : 'Verificar recursos'}
        </button>
      </header>

      {loading && !overlay ? (
        <p className="catalog-settings__loading" role="status">
          Verificando recursos do projeto…
        </p>
      ) : null}
      {!loading && overlay === null ? (
        <div className="catalog-settings__error" role="alert">
          <PixelIcon name="warn" className="catalog-status__icon" />
          <p>Não foi possível verificar os recursos do projeto.</p>
          <button
            type="button"
            className="settings-btn"
            onClick={() => setRefreshTick((tick) => tick + 1)}
          >
            Tentar novamente
          </button>
        </div>
      ) : null}

      <div className="settings-pill-row">
        {(overlay?.stacks.length ? overlay.stacks : ['workspace']).map((stack) => (
          <span key={stack} className="settings-chip">
            {stack}
          </span>
        ))}
        <span
          className={`settings-chip ${
            overlay === null
              ? loading ? '' : 'settings-chip--warn'
              : issueSummary.tone === 'ok' ? 'settings-chip--ok' : ''
          }`}
          data-testid="recipes-status"
        >
          {overlay === null
            ? loading ? 'Verificando…' : 'Verificação indisponível'
            : issueSummary.label}
        </span>
      </div>
      {overlay !== null && issueSummary.reason !== null ? (
        <p className="settings-detail__hint" data-testid="recipes-status-reason">
          {issueSummary.reason}
        </p>
      ) : null}

      {suggestions.length > 0 && (
        <div className="arsenal-band">
          <h3 className="arsenal-band__label">
            Equipes sugeridas
            <span className="arsenal-band__count">{suggestions.length}</span>
          </h3>
          <ul className="settings-list">
            {suggestions.map((recipe) => (
              <li key={recipe.id} className="settings-list__item catalog-item">
                <div className="catalog-item__head">
                  <span className="catalog-item__ident" aria-hidden="true">
                    <PixelIcon name="users" size={12} />
                  </span>
                  <div className="catalog-item__titles">
                    <span className="catalog-item__name">{recipe.title}</span>
                    <span className="catalog-item__meta settings-recipes__roles">
                      {recipe.agents.join(' · ')}
                    </span>
                  </div>
                  {recipe.gaps.length > 0 ? (
                    <div className="catalog-item__actions">
                      <span className="settings-chip">
                        {recipe.gaps.length === 1
                          ? 'falta 1 recurso'
                          : `faltam ${recipe.gaps.length} recursos`}
                      </span>
                    </div>
                  ) : null}
                </div>
                <details className="catalog-item__details"><summary>Recursos necessários</summary>
                <p className="settings-list__detail">
                  Ferramentas: {recipe.tools.join(', ')}
                </p>
                {recipe.gaps.length > 0 && (
                  <p className="settings-list__detail">Recursos que faltam: {recipe.gaps.join(', ')}</p>
                )}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {issues.length === 0 ? (
        overlay ? (
          <p className="settings-detail__hint">
            Nenhum ajuste pendente nas ferramentas e instruções declaradas.
          </p>
        ) : null
      ) : (
        <details className="catalog-item__details catalog-item__details--band">
          <summary>
            Ver {issues.length === 1 ? 'o ajuste' : `os ${issues.length} ajustes`}, do mais importante ao menor
          </summary>
          <ul className="settings-list">
            {issues.map((issue, index) => (
              <li key={`${issue.squadId}-${issue.agentId}-${issue.ref}-${index}`} className="settings-list__item catalog-item">
                <div className="catalog-item__head">
                  <span className="catalog-item__ident" aria-hidden="true">
                    <PixelIcon name="warn" size={12} />
                  </span>
                  <div className="catalog-item__titles">
                    <span className="catalog-item__name">
                      {issue.agentName ?? issue.squadName}
                    </span>
                    <span className="catalog-item__meta">
                      {issue.squadName} · {issue.ref}
                    </span>
                  </div>
                  <div className="catalog-item__actions">
                    <span className="settings-chip" title={issue.field}>
                      {RECIPE_ISSUE_KIND_LABEL[recipeIssueKind(issue)]}
                    </span>
                  </div>
                </div>
                <p className="settings-list__detail">{issue.message}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

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
            aria-label="Nome do agente"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, name: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.model}
            placeholder="modelo"
            aria-label="Modelo"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, model: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.effort}
            placeholder="Nível de raciocínio"
            aria-label="Nível de raciocínio"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, effort: e.target.value }))}
          />
          <input
            className="settings-input"
            value={agentSpec.category}
            placeholder="categoria"
            aria-label="Categoria"
            onChange={(e) => setAgentSpec((prev) => ({ ...prev, category: e.target.value }))}
          />
        </div>
        <input
          className="settings-input"
          value={(agentSpec.tools ?? []).join(', ')}
          placeholder="Ferramentas separadas por vírgula"
          aria-label="Ferramentas separadas por vírgula"
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
          aria-label="Instruções do agente"
          onChange={(e) =>
            setAgentSpec((prev) => ({ ...prev, systemPrompt: e.target.value }))
          }
        />
        {agentSpecResult && (
          <p className="settings-list__detail" role="status">{agentSpecResult}</p>
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
    </section>
  );
}

/**
 * Gestos de mouse: não são atalhos de teclado e por isso não moram no
 * catálogo compartilhado — mas o operador procura os dois no mesmo lugar.
 */
const GESTURES: Array<{ keys: string; action: string }> = [
  { keys: 'clique', action: 'Focar pane' },
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

/**
 * Teclas físicas ganham cap kbd; alternativas separadas por " / " viram duas
 * caps com separador anunciado como "ou" para leitor de tela.
 */
function KeyCombo({ keys }: { keys: string }) {
  const parts = keys.split(' / ');
  return (
    <span className="catalog-shortcut__keys">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <>
              <span className="catalog-shortcut__alt" aria-hidden="true">/</span>
              <span className="settings-visually-hidden">ou</span>
            </>
          ) : null}
          <kbd className="catalog-kbd">{part}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

export function ShortcutsSection() {
  return (
    <section className="catalog-settings catalog-settings--shortcuts">
      <SettingsSectionTitle>Atalhos</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Atalhos de teclado e mouse. Abra esta lista com{' '}
        <kbd className="catalog-kbd">{formatShortcut('mod', '/')}</kbd>.
      </p>
      {SHORTCUT_GROUP_ORDER.map((groupId) => {
        const shortcuts = shortcutsInGroup(groupId);
        return (
          <div key={groupId} className="arsenal-band">
            <h3 className="arsenal-band__label">
              {SHORTCUT_GROUP_LABELS[groupId]}
              <span className="arsenal-band__count">{shortcuts.length}</span>
            </h3>
            <ul className="settings-list">
              {shortcuts.map((shortcut) => (
                <li key={shortcut.id} className="settings-list__item">
                  <div className="settings-list__head">
                    <KeyCombo keys={shortcut.keys} />
                    <span className="settings-list__detail">
                      {shortcut.action}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <div className="arsenal-band">
        <h3 className="arsenal-band__label">
          Mouse
          <span className="arsenal-band__count">{GESTURES.length}</span>
        </h3>
        <ul className="settings-list">
          {GESTURES.map((gesture) => (
            <li key={gesture.keys} className="settings-list__item">
              <div className="settings-list__head">
                <span className="catalog-gesture">{gesture.keys}</span>
                <span className="settings-list__detail">{gesture.action}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function RemoteSection() {
  const [hosts, setHosts] = useState<RemoteSshHostView[]>([]);
  const [target, setTarget] = useState('');
  const [cli, setCli] = useState<'claude' | 'codex' | 'agy' | 'kimi'>('claude');
  const [sessionName, setSessionName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<RemoteSpawnResult | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  async function refresh() {
    const list = await window.nexus.remote.listSshHosts();
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
      let paneId: string;
      try {
        paneId = layout.addShellPane({ focus: false });
      } catch (error) {
        // F-228: acesso negado lança LicenseError — toast padrão, sem pane.
        if (!reportLicenseDenial(error)) throw error;
        return;
      }
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
            Conecte servidores pelo apelido e abra sessões neles. O celular fica na página Celular.
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
                    {host.alias}{host.user ? ` — ${host.user}` : ''}
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

        {result?.ok ? (
          <p className="settings-card__note" role="status">
            {result.attachCommand
              ? <>Sessão pronta — anexe com <code>{result.attachCommand}</code></>
              : 'Sessão criada.'}
          </p>
        ) : null}
        {result && !result.ok ? (
          <p className="settings-error" role="alert">
            {result.error}
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
