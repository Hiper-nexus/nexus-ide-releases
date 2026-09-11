import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { LayoutNode } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { buildGridTree, listPanes } from '../lib/split-tree';
import { reconcileHosts, refitAllPanesBeforePaint } from '../terminal/terminal-host';
import { reconcileBrowserPanes } from '../browser/browser-host';
import { minimumPaneGridSize } from '../lib/pane-grid-size';
import { PaneLeaf } from './PaneLeaf';
import { PanePicker } from './PanePicker';

/**
 * Renders the binary layout tree with react-resizable-panels (MIT). Each split
 * node is a two-panel Group with a draggable Separator; leaves render a
 * PaneLeaf. Every group always holds exactly two panels, so the library never
 * sees a changing panel count — reshapes stay warning-free.
 */
function renderNode(node: LayoutNode): React.ReactNode {
  if (node.kind === 'leaf') {
    return <PaneLeaf pane={node.pane} />;
  }

  const orientation = node.direction === 'row' ? 'horizontal' : 'vertical';
  const [a, b] = node.children;

  const axis = node.direction === 'row' ? 'width' : 'height';
  return (
    <Group orientation={orientation} className="panel-group">
      <Panel className="panel" minSize={`${minimumPaneGridSize(a)[axis]}px`} defaultSize="50%">
        {renderNode(a)}
      </Panel>
      <Separator className={`resize-handle resize-handle--${orientation}`} />
      <Panel className="panel" minSize={`${minimumPaneGridSize(b)[axis]}px`} defaultSize="50%">
        {renderNode(b)}
      </Panel>
    </Group>
  );
}

export function PaneGrid({
  visiblePaneIds,
  onPaneCreated,
}: {
  readonly visiblePaneIds?: ReadonlySet<string>;
  /** Repassado ao picker: o id do pane que o operador acabou de criar. */
  readonly onPaneCreated?: (paneId: string) => void;
} = {}) {
  const root = useLayoutStore((s) => s.root);
  const maximizedPaneId = useLayoutStore((s) => s.maximizedPaneId);
  const stageFocusMode = useLayoutStore((s) => s.stageFocusMode);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const toggleStageFocus = useLayoutStore((s) => s.toggleStageFocus);
  const focus = useLayoutStore((s) => s.focus);

  const displayRoot = useMemo(() => {
    if (!visiblePaneIds) return root;
    const visible = listPanes(root).filter((pane) => visiblePaneIds.has(pane.id));
    return visible.length === 0 ? null : buildGridTree(visible);
  }, [root, visiblePaneIds]);
  const maximizedPane = useMemo(() => {
    if (!maximizedPaneId || !displayRoot) return null;
    return (
      listPanes(displayRoot).find((pane) => pane.id === maximizedPaneId) ?? null
    );
  }, [displayRoot, maximizedPaneId]);

  const displayPanes = useMemo(() => {
    return displayRoot ? listPanes(displayRoot) : [];
  }, [displayRoot]);

  const isStageFocusActive = Boolean(
    stageFocusMode && !maximizedPane && displayPanes.length > 1,
  );

  const { stagePane, companionPanes } = useMemo(() => {
    if (!isStageFocusActive) return { stagePane: null, companionPanes: [] };
    const found = displayPanes.find((p) => p.id === focusedPaneId) ?? displayPanes[0]!;
    const companions = displayPanes.filter((p) => p.id !== found.id);
    return { stagePane: found, companionPanes: companions };
  }, [isStageFocusActive, displayPanes, focusedPaneId]);

  // Dispose only when the pane left the CANONICAL tree — never because the
  // vista da missão escondeu o mosaico das outras.
  useEffect(() => {
    const liveIds = new Set(listPanes(root).map((p) => p.id));
    reconcileHosts(liveIds);
    reconcileBrowserPanes(liveIds);
  }, [root]);

  // Fit PRÉ-PAINT: quando a largura da área de panes muda (sidebar/rail abrindo
  // ou fechando, modo foco entrando), o React já comitou o DOM mas o browser
  // ainda não pintou — o container já tem o tamanho novo, então o fit mede
  // certo e o terminal nunca aparece com a grade antiga. Sem isto o caminho
  // debounced deixaria as colunas velhas na tela por todo o debounce.
  //
  // Sem array de deps de propósito: a checagem de largura é barata e é o único
  // sinal confiável de "a área mudou" sem depender de cada flag de layout.
  const sizedRef = useRef<HTMLDivElement | null>(null);
  const lastSizedWidthRef = useRef(0);
  useLayoutEffect(() => {
    const el = sizedRef.current;
    if (!el) return;
    const width = el.clientWidth;
    if (width === lastSizedWidthRef.current) return;
    lastSizedWidthRef.current = width;
    refitAllPanesBeforePaint();
  });

  if (!displayRoot) {
    return (
      <div
        className="grid grid--mission-empty"
        aria-label="Nenhum terminal desta missão"
      />
    );
  }

  return (
    <div
      className={`grid${maximizedPane ? ' grid--pane-maximized' : ''}${
        isStageFocusActive ? ' grid--stage-focus' : ''
      }`}
    >
      {maximizedPane ? (
        <PaneLeaf pane={maximizedPane} />
      ) : isStageFocusActive && stagePane ? (
        <Group orientation="horizontal" className="panel-group panel-group--stage">
          <Panel
            className="panel panel--stage-main"
            defaultSize="72%"
            minSize="40%"
          >
            <PaneLeaf pane={stagePane} />
          </Panel>
          <Separator className="resize-handle resize-handle--horizontal" />
          <Panel
            className="panel panel--stage-rail"
            defaultSize="28%"
            minSize="20%"
          >
            <div
              className="stage-companion-rail"
              role="region"
              aria-label="Companions em background"
            >
              <div className="stage-companion-rail__header">
                <span className="stage-companion-rail__title">
                  Companions ({companionPanes.length})
                </span>
                <button
                  type="button"
                  className="stage-companion-rail__exit"
                  onClick={() => toggleStageFocus()}
                  title="Voltar à grade completa (Cmd+Shift+F)"
                >
                  Sair do Stage
                </button>
              </div>
              <div className="stage-companion-rail__list">
                {companionPanes.map((companion) => (
                  <div
                    key={companion.id}
                    className="stage-companion-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => focus(companion.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        focus(companion.id);
                      }
                    }}
                    title={`Trazer ${companion.title || 'Pane'} para o palco`}
                  >
                    <div className="stage-companion-card__bar">
                      <span className="stage-companion-card__title">
                        {companion.title || `Pane ${companion.id.slice(0, 6)}`}
                      </span>
                      <div className="stage-companion-card__meta">
                        <span className="stage-companion-card__badge">
                          {companion.role ?? companion.kind}
                        </span>
                        <button
                          type="button"
                          className="stage-companion-card__promote-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            focus(companion.id);
                          }}
                        >
                          Palco
                        </button>
                      </div>
                    </div>
                    <div className="stage-companion-card__body">
                      <PaneLeaf pane={companion} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </Group>
      ) : (
        <div className="grid__scroll">
          <div
            ref={sizedRef}
            className="grid__sized"
            style={{
              minWidth: minimumPaneGridSize(displayRoot).width,
              minHeight: minimumPaneGridSize(displayRoot).height,
            }}
          >
            {renderNode(displayRoot)}
          </div>
        </div>
      )}
      {/* Controle flutuante da grelha: abrir um pane novo sem sair do trabalho. */}
      <PanePicker onPaneCreated={onPaneCreated} />
    </div>
  );
}
