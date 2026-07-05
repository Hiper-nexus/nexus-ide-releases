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
 * thing that failed to load.
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
    window.nexus.app.signalMounted();
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
          background: '#0b0e14',
          color: '#e6e9ef',
          fontFamily: 'system-ui, -apple-system, sans-serif',
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
              color: '#9aa4b2',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message || 'Erro desconhecido no boot.'}
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '8px 20px',
              fontSize: 13,
              color: '#e6e9ef',
              background: '#2a3346',
              border: '1px solid #3a4560',
              borderRadius: 8,
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
