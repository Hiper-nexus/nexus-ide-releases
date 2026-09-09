import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useRailWidthStore } from '../../state/rail-width-store';
import { RailResizer } from './RailResizer';

export interface AppShellProps {
  rail: ReactNode;
  content: ReactNode;
  header?: ReactNode;
  inspector?: ReactNode;
  overlays?: ReactNode;
  contentId?: string;
  contentLabel?: string;
  inspectorLabel?: string;
  /** Incremented only when an outgoing destination owned focus. */
  focusRequest?: number;
  className?: string;
}

/**
 * Structural frame for Nexus V2. Product state stays with the caller; the
 * shell only gives each destination a stable landmark and layout slot.
 */
export function AppShell({
  rail,
  content,
  header,
  inspector,
  overlays,
  contentId = 'nexus-product-content',
  contentLabel = 'Conteúdo do produto',
  inspectorLabel = 'Detalhes',
  focusRequest,
  className = '',
}: AppShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const handledFocusRequest = useRef(focusRequest);
  // Chrome do shell, não estado de produto: a largura do rail é preferência da
  // pessoa e precisa ser lida onde a coluna do grid é declarada.
  const railWidth = useRailWidthStore((state) => state.width);

  useLayoutEffect(() => {
    if (
      focusRequest === undefined ||
      handledFocusRequest.current === focusRequest
    ) {
      return;
    }
    handledFocusRequest.current = focusRequest;
    mainRef.current?.focus();
  }, [focusRequest]);
  return (
    <div
      className={`nexus-shell ${className}`.trim()}
      style={
        { '--nexus-shell-rail-width': `${railWidth}px` } as CSSProperties
      }
    >
      <a className="nexus-shell__skip-link" href={`#${contentId}`}>
        Pular para o conteúdo
      </a>

      <div className="nexus-shell__frame">
        <aside className="workspace-rail" aria-label="Navegação do produto">
          {rail}
        </aside>
        <RailResizer />

        <div
          className={`nexus-shell__workspace${
            header == null ? ' nexus-shell__workspace--without-header' : ''
          }`}
        >
          {header != null ? (
            <header className="product-header">{header}</header>
          ) : null}

          <div
            className={`nexus-shell__body${
              inspector != null
                ? ' nexus-shell__body--with-inspector'
                : ''
            }`}
          >
            <main
              ref={mainRef}
              id={contentId}
              className="product-canvas"
              aria-label={contentLabel}
              tabIndex={-1}
            >
              {content}
            </main>

            {inspector != null ? (
              <aside
                className="product-inspector"
                aria-label={inspectorLabel}
              >
                {inspector}
              </aside>
            ) : null}
          </div>
        </div>
      </div>

      {overlays != null ? (
        <div className="nexus-shell__overlays">{overlays}</div>
      ) : null}
    </div>
  );
}
