import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  PanelAnimationSuppressionProvider,
  PanelExitingProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
  usePanelPresence,
} from '../../lib/panel-presence';
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
  /**
   * Escopo do inspector: workspace/checkout + destino + o que ele hospeda.
   * Fechar no mesmo escopo anima a saída; trocar de escopo remove o conteúdo
   * antigo na hora, e a primeira pintura do escopo novo não anima.
   */
  inspectorScopeKey?: string | null;
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
  inspectorScopeKey = null,
  className = '',
}: AppShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const handledFocusRequest = useRef(focusRequest);
  const inspectorNavigationSuppressed = usePanelNavigationSuppression(
    inspectorScopeKey ?? '',
  );
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

          <PanelAnimationSuppressionProvider
            value={inspectorNavigationSuppressed}
          >
            <ShellBody
              mainRef={mainRef}
              contentId={contentId}
              contentLabel={contentLabel}
              content={content}
              inspector={inspector}
              inspectorLabel={inspectorLabel}
              inspectorScopeKey={inspectorScopeKey}
            />
          </PanelAnimationSuppressionProvider>
        </div>
      </div>

      {overlays != null ? (
        <div className="nexus-shell__overlays">{overlays}</div>
      ) : null}
    </div>
  );
}

interface ShellBodyProps {
  mainRef: RefObject<HTMLElement | null>;
  contentId: string;
  contentLabel: string;
  content: ReactNode;
  inspector: ReactNode;
  inspectorLabel: string;
  inspectorScopeKey: string | null;
}

/**
 * Canvas + inspector. `open` (há inspector agora) controla a saída; `present`
 * controla a montagem: o inspector que fecha fica montado, inerte e oculto da
 * árvore de acessibilidade até a animação terminar. A coluna do grid continua
 * do mesmo tamanho durante a saída — o palco do terminal muda de largura uma
 * única vez, quando o inspector desmonta, nunca animado.
 */
function ShellBody({
  mainRef,
  contentId,
  contentLabel,
  content,
  inspector,
  inspectorLabel,
  inspectorScopeKey,
}: ShellBodyProps) {
  const inspectorOpen = inspector != null;
  const motion = usePanelAnimationSettings();
  const presence = usePanelPresence<ReactNode>(
    inspectorOpen,
    inspectorOpen ? inspector : null,
    motion.active,
    inspectorScopeKey,
    motion.durationMs,
  );
  // Reabrir durante a saída monta um inspector novo: o conteúdo que saía tem
  // estado próprio (ex.: o painel já se marcou oculto) e não volta a ser o vivo.
  const [openCycle, setOpenCycle] = useState(0);
  const [cycleOpen, setCycleOpen] = useState(inspectorOpen);
  if (cycleOpen !== inspectorOpen) {
    setCycleOpen(inspectorOpen);
    if (inspectorOpen) setOpenCycle((cycle) => cycle + 1);
  }

  return (
    <div
      className={`nexus-shell__body${
        presence.present ? ' nexus-shell__body--with-inspector' : ''
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

      {presence.present ? (
        <InspectorFrame
          key={openCycle}
          closing={!inspectorOpen}
          enterAnimated={motion.active}
          durationMs={motion.durationMs}
          label={inspectorLabel}
        >
          {presence.value}
        </InspectorFrame>
      ) : null}
    </div>
  );
}

function InspectorFrame({
  closing,
  enterAnimated,
  durationMs,
  label,
  children,
}: {
  closing: boolean;
  enterAnimated: boolean;
  durationMs: number;
  label: string;
  children: ReactNode;
}) {
  // Decidido na montagem: quando a supressão da navegação acaba, um inspector
  // já pintado não pode "entrar" de novo.
  const [enter] = useState(enterAnimated);
  return (
    <aside
      ref={(node) => {
        node?.toggleAttribute('inert', closing);
      }}
      className="product-inspector"
      aria-label={label}
      aria-hidden={closing ? true : undefined}
      data-state={closing ? 'closing' : 'open'}
      data-enter={enter ? 'animated' : undefined}
      style={{ '--panel-motion-duration': `${durationMs}ms` } as CSSProperties}
    >
      <PanelExitingProvider value={closing}>{children}</PanelExitingProvider>
    </aside>
  );
}
