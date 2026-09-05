import { useEffect, useState } from 'react';
import type React from 'react';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Nexus Arms — conector externo (Settings › Conectores). Paridade Overclock
 * 1.3.9–1.3.11: quem NÃO mora num pane (Grok Bot, Cursor) passa a ver o
 * estado do app em JSON e receber eventos com cursor, via MCP stdio.
 *
 * O token é mostrado UMA vez na geração/rotação — depois só existe o hash
 * em ~/.nexus/arms.json. A superfície do conector é observação por
 * construção: app_observe + app_events, nada mais.
 */

interface ArmsBridge {
  status(): Promise<{
    configured: boolean;
    revoked: boolean;
    createdAt: number | null;
    rotatedAt: number | null;
    lastUsedAt: number | null;
  }>;
  generate(): Promise<{ token: string; createdAt: number }>;
  rotate(): Promise<{ token: string; createdAt: number }>;
  revoke(): Promise<{ ok: boolean }>;
}

function bridge(): ArmsBridge | null {
  const arms = (window as { nexus?: { arms?: ArmsBridge } }).nexus?.arms;
  return arms ?? null;
}

const SNIPPET_BIN =
  '/Applications/NexusIDE.app/Contents/Resources/nexus-arms.mjs';

export function ArmsSection(): React.ReactElement {
  const [status, setStatus] = useState<
    Awaited<ReturnType<ArmsBridge['status']>> | null
  >(null);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    bridge()
      ?.status()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const run = (action: 'generate' | 'rotate' | 'revoke'): void => {
    const api = bridge();
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    const call =
      action === 'generate'
        ? api.generate()
        : action === 'rotate'
          ? api.rotate()
          : api.revoke();
    void call
      .then((result) => {
        if ('token' in result) setPlaintext(result.token);
        else setPlaintext(null);
        return api.status();
      })
      .then((next) => setStatus(next))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  const copyToken = (): void => {
    if (!plaintext) return;
    void navigator.clipboard
      .writeText(plaintext)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const fmt = (ms: number | null): string =>
    ms ? new Date(ms).toLocaleString() : '—';

  return (
    <section className="settings-section" aria-label="Conectores">
      <SettingsSectionTitle>Conectores</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Permita que ferramentas externas acompanhem o estado do Nexus.
        Elas não recebem o conteúdo dos terminais, mensagens ou segredos.
      </p>

      {status === null ? (
        <p className="settings-detail__hint">Carregando…</p>
      ) : (
        <div className="arms">
          <div className="arms__row">
            <span className="arms__state">
              {status.configured
                ? 'Token ativo'
                : status.revoked
                  ? 'Revogado'
                  : 'Sem token'}
            </span>
            {status.configured && (
              <>
                <span className="arms__meta">
                  criado {fmt(status.createdAt)} · último uso{' '}
                  {fmt(status.lastUsedAt)}
                  {status.rotatedAt ? ` · rotacionado ${fmt(status.rotatedAt)}` : ''}
                </span>
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy}
                  onClick={() => run('rotate')}
                >
                  Rotacionar
                </button>
                <button
                  type="button"
                  className="settings-btn settings-btn--danger"
                  disabled={busy}
                  onClick={() => run('revoke')}
                >
                  Revogar
                </button>
              </>
            )}
            {!status.configured && !status.revoked && (
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                onClick={() => run('generate')}
              >
                Gerar token
              </button>
            )}
            {status.revoked && (
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                onClick={() => run('generate')}
              >
                Gerar novo token
              </button>
            )}
          </div>

          {plaintext && (
            <div className="arms__token" role="alert">
              <p>
                Copie agora — este valor <strong>não aparece de novo</strong>:
              </p>
              <div className="arms__token-row">
                <code className="arms__token-value">{plaintext}</code>
                <button type="button" className="settings-btn" onClick={copyToken}>
                  {copied ? 'Copiado ✓' : 'Copiar'}
                </button>
              </div>
              <p className="settings-detail__hint">
                Na config MCP do cliente externo:
              </p>
              <pre className="arms__snippet">{`{
  "mcpServers": {
    "nexus-arms": {
      "command": "node",
      "args": ["${SNIPPET_BIN}"],
      "env": { "NEXUS_ARMS_TOKEN": "<cole o token aqui>" }
    }
  }
}`}</pre>
            </div>
          )}

          {error && <p className="arms__error">{error}</p>}

          <p className="settings-detail__hint">
            Mantenha o Nexus aberto enquanto usa a conexão. Você pode revogar o acesso a qualquer momento.
          </p>
        </div>
      )}
    </section>
  );
}
