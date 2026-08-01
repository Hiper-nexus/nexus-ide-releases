import { useEffect, useRef, useState } from 'react';
import { PixelIcon } from './PixelIcon';
import type {
  ExternalIssue,
  ForgePrSummary,
  GitHubDeviceCodePayload,
  PortForwardInfo,
} from '../../shared/integrations-types';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useLayoutStore } from '../state/layout-store';
import { CloseButton } from './CloseButton';
import { emitIntegrationsChanged } from '../lib/integrations-events';

/**
 * GitHub PR/issues, Linear, port-forward e tokens — modal focado.
 * Três zonas: Conexões (status + tokens), Ações rápidas (Criar PR, port
 * forward) e Trabalho (PRs / issues em abas).
 */

type WorkTab = 'prs' | 'github' | 'linear';

function StatusChip({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={on ? 'int-chip int-chip--on' : 'int-chip int-chip--off'}>
      {label}
    </span>
  );
}

export function IntegrationsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const openAgentic = useMissionWizardStore((s) => s.openForAgentic);
  const addBrowserPane = useLayoutStore((s) => s.addBrowserPane);
  const [hasGh, setHasGh] = useState(false);
  const [hasLin, setHasLin] = useState(false);
  const [ghToken, setGhToken] = useState('');
  const [linKey, setLinKey] = useState('');
  // Device Flow: opção oculta enquanto não há OAuth App clientId registrado
  // (dfAvailable=false); dfHint explica como habilitar.
  const [dfAvailable, setDfAvailable] = useState(false);
  const [dfHint, setDfHint] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<GitHubDeviceCodePayload | null>(null);
  const [prs, setPrs] = useState<ForgePrSummary[]>([]);
  const [branchReview, setBranchReviewState] = useState<{
    branch: string;
    review: ForgePrSummary | null;
  } | null>(null);
  const [ghIssues, setGhIssues] = useState<ExternalIssue[]>([]);
  const [linIssues, setLinIssues] = useState<ExternalIssue[]>([]);
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [note, setNote] = useState<string | null>(null);
  // Erros de listagem por fonte: sem isto, token inválido / origin não-GitHub
  // / offline apareciam como listas vazias ("parece não funcionar nada").
  const [ghError, setGhError] = useState<string | null>(null);
  const [linError, setLinError] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState('');
  const [pfPort, setPfPort] = useState('3000');
  const [busy, setBusy] = useState(false);
  const [workTab, setWorkTab] = useState<WorkTab>('prs');
  // Epoch monotônico: um refresh mais novo invalida o commit de um mais antigo,
  // evitando estado fora de ordem quando dois refreshes correm em paralelo.
  const refreshEpoch = useRef(0);

  async function refresh() {
    const epoch = ++refreshEpoch.current;
    const live = () => epoch === refreshEpoch.current;
    const [g, l, pf, df] = await Promise.all([
      window.nexus.integrations.hasGithubToken(),
      window.nexus.integrations.hasLinearKey(),
      window.nexus.integrations.listPortForwards(),
      window.nexus.integrations.githubDeviceFlowStatus(),
    ]);
    if (!live()) return;
    setHasGh(g);
    setHasLin(l);
    setForwards(pf);
    setDfAvailable(df.available);
    setDfHint(df.hint ?? null);
    if (g) {
      const pr = await window.nexus.integrations.listPrs();
      const issues = await window.nexus.integrations.listGithubIssues({ limit: 15 });
      const branch = await window.nexus.integrations.branchReview();
      if (!live()) return;
      setPrs(pr.ok ? pr.prs : []);
      setGhIssues(issues.ok ? issues.issues : []);
      setBranchReviewState(
        branch.ok ? { branch: branch.branch, review: branch.review } : null,
      );
      // Mostra o primeiro erro real (PRs e issues compartilham token/origin).
      setGhError(!pr.ok ? pr.error : !issues.ok ? issues.error : null);
    } else {
      setPrs([]);
      setGhIssues([]);
      setGhError(null);
    }
    if (l) {
      const issues = await window.nexus.integrations.listLinearIssues({ limit: 15 });
      if (!live()) return;
      setLinIssues(issues.ok ? issues.issues : []);
      setLinError(issues.ok ? null : issues.error);
    } else {
      setLinIssues([]);
      setLinError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    void refresh();
    // refresh usa refs/setters estáveis; roda ao abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Device Flow: o main empurra o user_code assim que o GitHub o emite.
  useEffect(() => {
    if (!open) return;
    const offCode = window.nexus.integrations.onGithubDeviceCode((p) => setDeviceCode(p));
    const offErr = window.nexus.integrations.onGithubAuthError((p) =>
      setNote(p.message ?? p.error),
    );
    return () => {
      offCode();
      offErr();
    };
  }, [open]);

  function startDeviceFlow() {
    setBusy(true);
    setNote(null);
    void window.nexus.integrations
      .startGithubDeviceFlow()
      .then((r) => {
        if (r.ok) {
          setNote(`GitHub conectado como ${r.user.login}`);
          emitIntegrationsChanged();
        } else if (r.error !== 'Auth cancelled') {
          setNote(r.error);
        }
        return refresh();
      })
      .finally(() => {
        setDeviceCode(null);
        setBusy(false);
      });
  }

  function cancelDeviceFlow() {
    void window.nexus.integrations.cancelGithubDeviceFlow();
    setDeviceCode(null);
  }

  if (!open) return null;

  /** Guarda um token (GitHub/Linear) — mesmo fluxo, fontes diferentes. */
  function persistToken(
    value: string,
    save: (v: string) => Promise<{ ok: boolean; error?: string }>,
    okMsg: string,
    clear: () => void,
  ) {
    setBusy(true);
    void save(value.trim())
      .then((r) => {
        setNote(r.ok ? okMsg : r.error ?? 'erro');
        if (r.ok) {
          clear();
          emitIntegrationsChanged();
        }
        return refresh();
      })
      .finally(() => setBusy(false));
  }

  return (
    <div
      className="int-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="int-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Integrações"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <header className="int-panel__head">
          <strong>Integrações</strong>
          <CloseButton onClick={onClose} label="Fechar integrações" />
        </header>

        <div className="int-panel__body">
          <div className="int-panel__grid">
            {/* ---- Conexões ---- */}
            <section className="int-card">
              <h4 className="int-card__title">Conexões</h4>

              <div className="int-conn">
                <div className="int-conn__head">
                  <span>GitHub</span>
                  <StatusChip
                    on={hasGh}
                    label={hasGh ? 'conectado' : 'desconectado'}
                  />
                </div>
                {!hasGh && (
                  <p className="int-panel__dim">
                    “Entrar com GitHub” nas Configurações conecta sua conta Nexus —
                    não dá acesso à API. Para PRs e issues, cole um Personal Access
                    Token (github.com/settings/tokens) ou rode `gh auth login` num
                    terminal: o Nexus reaproveita a sessão do gh CLI.
                  </p>
                )}
                {!hasGh && deviceCode && (
                  <div>
                    <p className="int-panel__dim">
                      Abra{' '}
                      <button
                        type="button"
                        className="int-panel__link"
                        onClick={() =>
                          void window.nexus.app.openExternal(deviceCode.verificationUri)
                        }
                      >
                        {deviceCode.verificationUri}
                      </button>{' '}
                      e digite o código:
                    </p>
                    <p className="int-panel__note" role="status">
                      <strong>{deviceCode.userCode}</strong>
                    </p>
                    <button
                      type="button"
                      className="int-panel__btn int-panel__btn--sm"
                      onClick={cancelDeviceFlow}
                    >
                      Cancelar
                    </button>
                  </div>
                )}
                {!hasGh && !deviceCode && dfAvailable && (
                  <button
                    type="button"
                    className="int-panel__btn int-panel__btn--sm"
                    disabled={busy}
                    onClick={startDeviceFlow}
                  >
                    Entrar com GitHub (navegador)
                  </button>
                )}
                {!hasGh && !dfAvailable && dfHint && (
                  <p className="int-panel__dim">{dfHint}</p>
                )}
                <div className="int-conn__save">
                  <input
                    className="int-panel__input"
                    type="password"
                    value={ghToken}
                    placeholder="ghp_…"
                    onChange={(e) => setGhToken(e.target.value)}
                  />
                  <button
                    type="button"
                    className="int-panel__btn int-panel__btn--sm"
                    disabled={busy || !ghToken.trim()}
                    onClick={() =>
                      persistToken(
                        ghToken,
                        (v) => window.nexus.integrations.setGithubToken(v),
                        'GitHub token guardado',
                        () => setGhToken(''),
                      )
                    }
                  >
                    Salvar
                  </button>
                </div>
              </div>

              <div className="int-conn">
                <div className="int-conn__head">
                  <span>Linear</span>
                  <StatusChip
                    on={hasLin}
                    label={hasLin ? 'conectado' : 'desconectado'}
                  />
                </div>
                <div className="int-conn__save">
                  <input
                    className="int-panel__input"
                    type="password"
                    value={linKey}
                    placeholder="lin_api_…"
                    onChange={(e) => setLinKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="int-panel__btn int-panel__btn--sm"
                    disabled={busy || !linKey.trim()}
                    onClick={() =>
                      persistToken(
                        linKey,
                        (v) => window.nexus.integrations.setLinearKey(v),
                        'Linear key guardada',
                        () => setLinKey(''),
                      )
                    }
                  >
                    Salvar
                  </button>
                </div>
              </div>
            </section>

            {/* ---- Ações rápidas ---- */}
            <section className="int-card">
              <h4 className="int-card__title">Ações rápidas</h4>

              <div className="int-conn">
                <div className="int-conn__head">
                  <span>Criar PR</span>
                </div>
                {branchReview && (
                  <p className="int-panel__dim">
                    Branch <strong>{branchReview.branch}</strong>:{' '}
                    {branchReview.review ? (
                      <button
                        type="button"
                        className="int-panel__link"
                        onClick={() =>
                          void window.nexus.app.openExternal(
                            branchReview.review!.url,
                          )
                        }
                      >
                        PR #{branchReview.review.number} ({branchReview.review.state}
                        )
                      </button>
                    ) : (
                      'sem PR aberto ainda'
                    )}
                  </p>
                )}
                <input
                  className="int-panel__input"
                  value={prTitle}
                  placeholder="Título do PR"
                  onChange={(e) => setPrTitle(e.target.value)}
                />
                <button
                  type="button"
                  className="int-panel__btn int-panel__btn--primary"
                  disabled={busy || !prTitle.trim() || !hasGh}
                  onClick={() => {
                    setBusy(true);
                    void window.nexus.integrations
                      .createPr({ title: prTitle.trim() })
                      .then((r) => {
                        if (r.ok) {
                          setNote(`PR #${r.number} criado`);
                          setPrTitle('');
                          void window.nexus.app.openExternal(r.url);
                        } else setNote(r.error);
                        return refresh();
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  Criar PR da branch atual
                </button>
              </div>

              <div className="int-conn">
                <div className="int-conn__head">
                  <span>Port forward → browser</span>
                </div>
                <div className="int-panel__row">
                  <input
                    className="int-panel__input"
                    value={pfPort}
                    onChange={(e) => setPfPort(e.target.value)}
                    placeholder="porta local (ex 3000)"
                  />
                  <button
                    type="button"
                    className="int-panel__btn int-panel__btn--sm"
                    disabled={busy}
                    onClick={() => {
                      const port = Number(pfPort);
                      if (!Number.isFinite(port)) {
                        setNote('porta inválida');
                        return;
                      }
                      setBusy(true);
                      void window.nexus.integrations
                        .startPortForward({
                          localPort: port,
                          remoteHost: '127.0.0.1',
                          remotePort: port,
                          label: `dev:${port}`,
                        })
                        .then((r) => {
                          if (r.ok) {
                            setNote(`Forward ${r.info.localUrl}`);
                            addBrowserPane(r.info.localUrl);
                            return refresh();
                          }
                          setNote(r.error);
                          return undefined;
                        })
                        .finally(() => setBusy(false));
                    }}
                  >
                    Forward + abrir
                  </button>
                </div>
                {forwards.length > 0 && (
                  <ul className="int-panel__list">
                    {forwards.map((f) => (
                      <li key={f.id}>
                        {f.localUrl}{' '}
                        <button
                          type="button"
                          className="int-panel__link"
                          onClick={() => {
                            void window.nexus.integrations
                              .closePortForward(f.id)
                              .then(refresh);
                          }}
                        >
                          fechar
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          {/* ---- Trabalho ---- */}
          <section className="int-card">
            <h4 className="int-card__title">Trabalho</h4>
            <div className="int-tabs" role="tablist" aria-label="Trabalho">
              <button
                type="button"
                role="tab"
                aria-selected={workTab === 'prs'}
                className={workTab === 'prs' ? 'int-tab int-tab--active' : 'int-tab'}
                onClick={() => setWorkTab('prs')}
              >
                PRs<span className="int-tab__count">{prs.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={workTab === 'github'}
                className={
                  workTab === 'github' ? 'int-tab int-tab--active' : 'int-tab'
                }
                onClick={() => setWorkTab('github')}
              >
                Issues GitHub<span className="int-tab__count">{ghIssues.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={workTab === 'linear'}
                className={
                  workTab === 'linear' ? 'int-tab int-tab--active' : 'int-tab'
                }
                onClick={() => setWorkTab('linear')}
              >
                Linear<span className="int-tab__count">{linIssues.length}</span>
              </button>
            </div>

            {workTab === 'prs' && (
              <ul className="int-panel__list" role="tabpanel">
                {prs.map((p) => (
                  <li key={p.number}>
                    <button
                      type="button"
                      className="int-panel__link"
                      onClick={() => void window.nexus.app.openExternal(p.url)}
                    >
                      #{p.number} {p.title}
                    </button>
                  </li>
                ))}
                {hasGh && !ghError && prs.length === 0 && (
                  <li className="int-panel__dim">Nenhum PR aberto</li>
                )}
                {hasGh && ghError && (
                  <li className="int-panel__error" role="alert">
                    <PixelIcon name="warn" size={11} /> {ghError}
                  </li>
                )}
                {!hasGh && (
                  <li className="int-panel__dim">Configure o token GitHub</li>
                )}
              </ul>
            )}

            {workTab === 'github' && (
              <ul className="int-panel__list" role="tabpanel">
                {ghIssues.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      className="int-panel__link"
                      title={i.url}
                      onClick={() => {
                        openAgentic(
                          `GitHub #${i.number}: ${i.title}\n${i.url}\nLabels: ${i.labels.join(', ') || '—'}`,
                          'imported-issue',
                        );
                        setNote(`Wizard aberto a partir de #${i.number}`);
                      }}
                    >
                      #{i.number} {i.title}
                    </button>
                  </li>
                ))}
                {hasGh && ghError && (
                  <li className="int-panel__error" role="alert">
                    <PixelIcon name="warn" size={11} /> {ghError}
                  </li>
                )}
                {hasGh && !ghError && ghIssues.length === 0 && (
                  <li className="int-panel__dim">Nenhuma issue aberta</li>
                )}
                {!hasGh && (
                  <li className="int-panel__dim">Configure o token GitHub</li>
                )}
              </ul>
            )}

            {workTab === 'linear' && (
              <ul className="int-panel__list" role="tabpanel">
                {linIssues.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      className="int-panel__link"
                      onClick={() => {
                        openAgentic(
                          `Linear: ${i.title}\n${i.url}\nEstado: ${i.state}\nLabels: ${i.labels.join(', ') || '—'}`,
                          'imported-issue',
                        );
                        setNote(`Wizard aberto a partir de Linear`);
                      }}
                    >
                      {i.title} · {i.state}
                    </button>
                  </li>
                ))}
                {hasLin && linError && (
                  <li className="int-panel__error" role="alert">
                    <PixelIcon name="warn" size={11} /> {linError}
                  </li>
                )}
                {hasLin && !linError && linIssues.length === 0 && (
                  <li className="int-panel__dim">Nenhuma issue aberta</li>
                )}
                {!hasLin && (
                  <li className="int-panel__dim">Configure a API key Linear</li>
                )}
              </ul>
            )}
          </section>
        </div>

        {note && <p className="int-panel__note">{note}</p>}
      </div>
    </div>
  );
}
