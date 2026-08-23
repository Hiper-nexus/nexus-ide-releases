import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Top-level error boundary. Two jobs (see docs/audit QA#3 — "janela preta"):
 *
 * 1. A render/effect crash on boot renders a readable error screen instead of a
 *    black window — with a Reload affordance.
 * 2. componentDidMount fires the main-process mount signal AFTER the first
 *    commit — children OR this fallback. Reaching it means React actually
 *    painted, so the window is alive; the main watchdog stops reloading. This
 *    replaces the old dev-only `[diag]` console log and works in the packaged
 *    app too. If boot hangs before any commit, the signal never fires and the
 *    watchdog recovers.
 *
 * Styles are inline so the error screen renders even if the stylesheet is the
 * thing that failed to load — every var() carries a hardcoded fallback for
 * exactly that case (tokens quando o CSS carregou, cores fixas quando não).
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidMount(): void {
    window.nexus.app.signalMounted(
      this.state.error
        ? { ok: false, error: this.state.error.message || 'React boot failed' }
        : { ok: true },
    );
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[diag] erro no boot do React:', error, info.componentStack);
  }

  private handleReload = (): void => {
    this.setState({ error: null });
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'var(--bg, #0b0e14)',
          color: 'var(--text, #e6e9ef)',
          fontFamily: 'var(--font-ui, system-ui, -apple-system, sans-serif)',
        }}
      >
        <div style={{ maxWidth: 520, textAlign: 'center' }}>
          <h1 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 600 }}>
            NexusIDE não conseguiu iniciar
          </h1>
          <p
            style={{
              margin: '0 0 20px',
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--text-dim, #9aa4b2)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            O Nexus não conseguiu abrir a tela. Seu trabalho continua salvo —
            recarregar costuma resolver.
          </p>
          <details
            style={{
              margin: '0 0 20px',
              fontSize: 12,
              color: 'var(--text-faint, #7c8798)',
              maxWidth: 520,
            }}
          >
            <summary style={{ cursor: 'pointer' }}>Detalhes técnicos</summary>
            <p
              style={{
                margin: '8px 0 0',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                textAlign: 'left',
              }}
            >
              {error.message || 'Erro desconhecido no boot.'}
            </p>
          </details>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '8px 20px',
              fontSize: 13,
              color: 'var(--text, #e6e9ef)',
              background: 'var(--accent-soft, #2a3346)',
              border: '1px solid var(--border-strong, #3a4560)',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            Recarregar
          </button>
        </div>
      </div>
    );
  }
}
