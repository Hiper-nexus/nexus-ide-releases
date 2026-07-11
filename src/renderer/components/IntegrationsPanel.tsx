import { useEffect, useState } from 'react';
import type { ExternalIssue, ForgePrSummary, PortForwardInfo } from '../../shared/integrations-types';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useLayoutStore } from '../state/layout-store';
import { CloseButton } from './CloseButton';

/**
 * Sprint A2/B6/C7/C8 — GitHub PR/issues, Linear, port-forward, tokens.
 */
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
  const [prs, setPrs] = useState<ForgePrSummary[]>([]);
  const [ghIssues, setGhIssues] = useState<ExternalIssue[]>([]);
  const [linIssues, setLinIssues] = useState<ExternalIssue[]>([]);
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState('');
  const [pfPort, setPfPort] = useState('3000');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [g, l, pf] = await Promise.all([
      window.nexus.integrations.hasGithubToken(),
      window.nexus.integrations.hasLinearKey(),
      window.nexus.integrations.listPortForwards(),
    ]);
    setHasGh(g);
    setHasLin(l);
    setForwards(pf);
    if (g) {
      const pr = await window.nexus.integrations.listPrs();
      if (pr.ok) setPrs(pr.prs);
      const issues = await window.nexus.integrations.listGithubIssues({ limit: 15 });
      if (issues.ok) setGhIssues(issues.issues);
    }
    if (l) {
      const issues = await window.nexus.integrations.listLinearIssues({ limit: 15 });
      if (issues.ok) setLinIssues(issues.issues);
    }
  }

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  if (!open) return null;

  return (
    <div className="int-panel" role="dialog" aria-label="Integrações">
      <header className="int-panel__head">
        <strong>Integrações</strong>
        <CloseButton onClick={onClose} label="Fechar integrações" />
      </header>
      <div className="int-panel__body">
        <section className="int-panel__sec">
          <h4>Tokens</h4>
          <label className="int-panel__field">
            GitHub PAT {hasGh ? '✓' : '—'}
            <input
              type="password"
              value={ghToken}
              placeholder="ghp_…"
              onChange={(e) => setGhToken(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="int-panel__btn"
            disabled={busy || !ghToken.trim()}
            onClick={() => {
              setBusy(true);
              void window.nexus.integrations
                .setGithubToken(ghToken.trim())
                .then((r) => {
                  setNote(r.ok ? 'GitHub token guardado' : r.error ?? 'erro');
                  if (r.ok) setGhToken('');
                  return refresh();
                })
                .finally(() => setBusy(false));
            }}
          >
            Guardar GitHub
          </button>
          <label className="int-panel__field">
            Linear API key {hasLin ? '✓' : '—'}
            <input
              type="password"
              value={linKey}
              placeholder="lin_api_…"
              onChange={(e) => setLinKey(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="int-panel__btn"
            disabled={busy || !linKey.trim()}
            onClick={() => {
              setBusy(true);
              void window.nexus.integrations
                .setLinearKey(linKey.trim())
                .then((r) => {
                  setNote(r.ok ? 'Linear key guardada' : r.error ?? 'erro');
                  if (r.ok) setLinKey('');
                  return refresh();
                })
                .finally(() => setBusy(false));
            }}
          >
            Guardar Linear
          </button>
        </section>

        <section className="int-panel__sec">
          <h4>Criar PR (GitHub)</h4>
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
          <ul className="int-panel__list">
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
          </ul>
        </section>

        <section className="int-panel__sec">
          <h4>GitHub Issues</h4>
          <ul className="int-panel__list">
            {ghIssues.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className="int-panel__link"
                  title={i.url}
                  onClick={() => {
                    openAgentic(
                      `GitHub #${i.number}: ${i.title}\n${i.url}\nLabels: ${i.labels.join(', ') || '—'}`,
                    );
                    setNote(`Wizard aberto a partir de #${i.number}`);
                  }}
                >
                  #{i.number} {i.title}
                </button>
              </li>
            ))}
            {hasGh && ghIssues.length === 0 && (
              <li className="int-panel__dim">Nenhuma issue aberta</li>
            )}
            {!hasGh && <li className="int-panel__dim">Configure o token GitHub</li>}
          </ul>
        </section>

        <section className="int-panel__sec">
          <h4>Linear</h4>
          <ul className="int-panel__list">
            {linIssues.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className="int-panel__link"
                  onClick={() => {
                    openAgentic(
                      `Linear: ${i.title}\n${i.url}\nEstado: ${i.state}\nLabels: ${i.labels.join(', ') || '—'}`,
                    );
                    setNote(`Wizard aberto a partir de Linear`);
                  }}
                >
                  {i.title} · {i.state}
                </button>
              </li>
            ))}
            {!hasLin && <li className="int-panel__dim">Configure a API key Linear</li>}
          </ul>
        </section>

        <section className="int-panel__sec">
          <h4>Port forward → Browser</h4>
          <div className="int-panel__row">
            <input
              className="int-panel__input"
              value={pfPort}
              onChange={(e) => setPfPort(e.target.value)}
              placeholder="porta local (ex 3000)"
            />
            <button
              type="button"
              className="int-panel__btn"
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
          <ul className="int-panel__list">
            {forwards.map((f) => (
              <li key={f.id}>
                {f.localUrl}{' '}
                <button
                  type="button"
                  className="int-panel__link"
                  onClick={() => {
                    void window.nexus.integrations.closePortForward(f.id).then(refresh);
                  }}
                >
                  fechar
                </button>
              </li>
            ))}
          </ul>
        </section>

        {note && <p className="int-panel__note">{note}</p>}
      </div>
    </div>
  );
}
