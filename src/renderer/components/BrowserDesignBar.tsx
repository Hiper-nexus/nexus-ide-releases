import { useEffect, useMemo, useState } from 'react';
import { setBrowserViewportOverride } from '../browser/browser-host';
import { DESIGN_BREAKPOINTS } from '../browser/viewport-override';
import { listPanes } from '../lib/split-tree';
import { useDesignSelectionStore } from '../state/design-selection-store';
import { useLayoutStore } from '../state/layout-store';

const EMPTY_SELECTIONS: never[] = [];

type Props = {
  paneId: string;
  /** F2: toggles the styles sidebar owned by the BrowserPane. */
  stylesOpen?: boolean;
  onToggleStyles?: () => void;
};

/**
 * Design-mode strip of a browser pane (VISUAL-EDIT-001, Fase 1): toggles the
 * in-page picker and pushes the current selection to an agent CLI pane. The
 * picker itself lives in the pane preload; this component only mirrors its
 * state via browser design events (mode/selection) do main.
 */
export function BrowserDesignBar({ paneId, stylesOpen, onToggleStyles }: Props) {
  const isActive = useDesignSelectionStore(
    (s) => s.byPane[paneId]?.isActive ?? false,
  );
  const selection = useDesignSelectionStore(
    (s) => s.byPane[paneId]?.selection ?? null,
  );
  const selections = useDesignSelectionStore(
    (s) => s.byPane[paneId]?.selections ?? EMPTY_SELECTIONS,
  );
  const [breakpoint, setBreakpoint] = useState<number | null>(null);
  const [instruction, setInstruction] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [targetPaneId, setTargetPaneId] = useState<string | null>(null);

  const rootNode = useLayoutStore((s) => s.root);
  const agentPanes = useMemo(
    () => listPanes(rootNode).filter((p) => p.kind === 'cli-agent'),
    [rootNode],
  );
  const effectiveTarget =
    targetPaneId && agentPanes.some((p) => p.id === targetPaneId)
      ? targetPaneId
      : agentPanes[0]?.id ?? null;

  // Nova seleção (ou perda dela) limpa o status da última ação.
  useEffect(() => {
    setStatus(null);
  }, [selection]);

  async function toggle(): Promise<void> {
    try {
      // O estado visível flui pelos eventos de modo (main → store) — inclusive
      // quando a página desliga o picker via Escape.
      await window.nexus.browser.setDesignMode(paneId, !isActive);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function send(): Promise<void> {
    if (!selection || !effectiveTarget) return;
    setStatus('enviando…');
    try {
      const trimmed = instruction.trim();
      await window.nexus.browser.sendDesignSelection(paneId, {
        targetPaneId: effectiveTarget,
        ...(trimmed ? { instruction: trimmed } : {}),
      });
      setStatus('contexto enviado ✓');
      setInstruction('');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  const selectionLabel = selection
    ? `${selection.tag}${selection.id ? `#${selection.id}` : ''}${
        selection.classes.length ? `.${selection.classes.slice(0, 2).join('.')}` : ''
      }`
    : null;

  return (
    <div className="design-bar nodrag">
      <button
        type="button"
        data-testid="design-toggle"
        className={`browser-bar__btn design-bar__toggle ${isActive ? 'design-bar__toggle--on' : ''}`}
        aria-pressed={isActive}
        title={isActive ? 'Sair do Design Mode (Esc)' : 'Design Mode: selecionar elemento'}
        aria-label="Design Mode"
        onClick={() => void toggle()}
      >
        ◎
      </button>
      {isActive && (
        <span className="design-bar__breakpoints">
          {DESIGN_BREAKPOINTS.map((width) => (
            <button
              key={width}
              type="button"
              data-testid={`design-bp-${width}`}
              className={`browser-bar__btn design-bar__bp ${breakpoint === width ? 'design-bar__toggle--on' : ''}`}
              title={`Preview em ${width}px`}
              onClick={() => {
                setBreakpoint(width);
                setBrowserViewportOverride(paneId, width);
              }}
            >
              {width}
            </button>
          ))}
          <button
            type="button"
            data-testid="design-bp-full"
            className={`browser-bar__btn design-bar__bp ${breakpoint === null ? 'design-bar__toggle--on' : ''}`}
            title="Largura total do pane"
            onClick={() => {
              setBreakpoint(null);
              setBrowserViewportOverride(paneId, null);
            }}
          >
            ⛶
          </button>
        </span>
      )}
      {isActive && !selection && (
        <span className="design-bar__hint">clique num elemento da página…</span>
      )}
      {isActive && selection && (
        <>
          <span className="design-bar__label" title={selection.selector}>
            {selectionLabel}
          </span>
          {selections.length > 1 && (
            <span
              data-testid="design-multi-badge"
              className="design-bar__label"
              title="Elementos na seleção (shift+click acumula)"
            >
              ⧉ {selections.length}
            </span>
          )}
          <input
            data-testid="design-instruction"
            className="design-bar__instruction"
            placeholder="instrução pro agente (opcional)"
            value={instruction}
            spellCheck={false}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
          />
          {agentPanes.length > 1 && (
            <select
              data-testid="design-target"
              className="design-bar__target"
              value={effectiveTarget ?? ''}
              aria-label="Pane do agente"
              onChange={(e) => setTargetPaneId(e.target.value)}
            >
              {agentPanes.map((pane) => (
                <option key={pane.id} value={pane.id}>
                  {pane.agentName ?? pane.title}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            data-testid="design-clone"
            className="browser-bar__btn design-bar__send"
            disabled={!effectiveTarget}
            title={
              effectiveTarget
                ? 'Clonar: o agente recria este elemento no seu projeto'
                : 'Abra um pane de agente CLI para clonar'
            }
            onClick={() => {
              if (!effectiveTarget) return;
              setStatus('enviando…');
              window.nexus.browser
                .sendDesignSelection(paneId, {
                  targetPaneId: effectiveTarget,
                  intent: 'clone',
                })
                .then(() => setStatus('clonagem enviada pro agente ✓'))
                .catch((err) =>
                  setStatus(err instanceof Error ? err.message : String(err)),
                );
            }}
          >
            recriar no projeto
          </button>
          {onToggleStyles && (
            <button
              type="button"
              data-testid="design-styles-toggle"
              className={`browser-bar__btn ${stylesOpen ? 'design-bar__toggle--on' : ''}`}
              aria-pressed={Boolean(stylesOpen)}
              title="Estilos do elemento (sidebar)"
              onClick={onToggleStyles}
            >
              ≡
            </button>
          )}
          <button
            type="button"
            data-testid="design-send"
            className="browser-bar__btn design-bar__send"
            disabled={!effectiveTarget}
            title={
              effectiveTarget
                ? 'Enviar seleção pro agente'
                : 'Abra um pane de agente CLI para receber a seleção'
            }
            onClick={() => void send()}
          >
            → agente
          </button>
        </>
      )}
      {status && <span className="design-bar__status">{status}</span>}
    </div>
  );
}
