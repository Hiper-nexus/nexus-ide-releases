import { useEffect, useMemo, useState } from 'react';
import type { BrowserDesignAnnotationIntent } from '../../shared/browser-design';
import { setBrowserViewportOverride } from '../browser/browser-host';
import { DESIGN_BREAKPOINTS } from '../browser/viewport-override';
import { listPanes } from '../lib/split-tree';
import { useDesignSelectionStore } from '../state/design-selection-store';
import { useLayoutStore } from '../state/layout-store';

const EMPTY_SELECTIONS: never[] = [];
const EMPTY_ANNOTATIONS: never[] = [];

/** Rótulos PT das intenções de anotação (contrato compartilha o enum). */
const ANNOTATION_INTENTS: Array<{
  value: BrowserDesignAnnotationIntent;
  label: string;
}> = [
  { value: 'fix', label: 'corrigir' },
  { value: 'change', label: 'mudar' },
  { value: 'question', label: 'pergunta' },
  { value: 'approve', label: 'aprovado' },
];

function intentLabel(intent: string): string {
  return (
    ANNOTATION_INTENTS.find((entry) => entry.value === intent)?.label ?? intent
  );
}

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
  const annotations = useDesignSelectionStore(
    (s) => s.byPane[paneId]?.annotations ?? EMPTY_ANNOTATIONS,
  );
  const setAnnotations = useDesignSelectionStore((s) => s.setAnnotations);
  const [breakpoint, setBreakpoint] = useState<number | null>(null);
  const [instruction, setInstruction] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [targetPaneId, setTargetPaneId] = useState<string | null>(null);
  const [annotationIntent, setAnnotationIntent] =
    useState<BrowserDesignAnnotationIntent>('fix');
  const [trayOpen, setTrayOpen] = useState(false);

  // Hidrata a lista do MAIN (fonte de verdade): anotações sobrevivem a
  // remount do pane e ao toggle do picker.
  useEffect(() => {
    let alive = true;
    window.nexus.browser
      .listDesignAnnotations(paneId)
      .then((result) => {
        if (alive) setAnnotations(paneId, result.annotations);
      })
      .catch(() => {
        // Pane ainda não criado no main — a lista continua vazia.
      });
    return () => {
      alive = false;
    };
  }, [paneId, setAnnotations]);

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
      const result = await window.nexus.browser.sendDesignSelection(paneId, {
        targetPaneId: effectiveTarget,
        ...(trimmed ? { instruction: trimmed } : {}),
      });
      setStatus(
        result.designSystemAttached
          ? 'contexto enviado ✓ (+ DESIGN.md)'
          : 'contexto enviado ✓',
      );
      setInstruction('');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyContext(): Promise<void> {
    if (!selection || !effectiveTarget) return;
    setStatus('preparando contexto…');
    try {
      const trimmed = instruction.trim();
      const result = await window.nexus.browser.sendDesignSelection(paneId, {
        targetPaneId: effectiveTarget,
        dryRun: true,
        ...(trimmed ? { instruction: trimmed } : {}),
      });
      if (!result.prompt) {
        setStatus('nada para copiar');
        return;
      }
      await navigator.clipboard.writeText(result.prompt);
      setStatus(`contexto copiado (${result.promptChars} chars) ✓`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function annotate(): Promise<void> {
    if (!selection) return;
    const comment = instruction.trim();
    if (!comment) {
      setStatus('escreva o comentário da anotação no campo de instrução');
      return;
    }
    try {
      const result = await window.nexus.browser.designAnnotate(paneId, {
        comment,
        intent: annotationIntent,
      });
      setAnnotations(paneId, result.annotations);
      setInstruction('');
      setTrayOpen(true);
      setStatus(`anotação #${result.annotations.length} adicionada ✓`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteAnnotation(annotationId: string): Promise<void> {
    try {
      const result = await window.nexus.browser.deleteDesignAnnotation(
        paneId,
        annotationId,
      );
      setAnnotations(paneId, result.annotations);
      if (result.annotations.length === 0) setTrayOpen(false);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearAnnotations(): Promise<void> {
    try {
      const result = await window.nexus.browser.clearDesignAnnotations(paneId);
      setAnnotations(paneId, result.annotations);
      setTrayOpen(false);
      setStatus('anotações limpas');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendAnnotations(dryRun: boolean): Promise<void> {
    if (!effectiveTarget || annotations.length === 0) return;
    setStatus(dryRun ? 'preparando feedback…' : 'enviando feedback…');
    try {
      const result = await window.nexus.browser.sendDesignAnnotations(paneId, {
        targetPaneId: effectiveTarget,
        ...(dryRun ? { dryRun: true } : {}),
      });
      if (dryRun) {
        if (!result.prompt) {
          setStatus('nada para copiar');
          return;
        }
        await navigator.clipboard.writeText(result.prompt);
        setStatus(`feedback copiado (${result.promptChars} chars) ✓`);
        return;
      }
      setStatus(
        result.designSystemAttached
          ? `feedback enviado (${result.annotations}) ✓ (+ DESIGN.md)`
          : `feedback enviado (${result.annotations}) ✓`,
      );
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
    <>
    <div className={`design-bar nodrag ${isActive ? 'design-bar--active' : ''}`}>
      <button
        type="button"
        data-testid="design-toggle"
        className={`browser-bar__btn design-bar__toggle ${isActive ? 'design-bar__toggle--on' : ''}`}
        aria-pressed={isActive}
        title={
          isActive
            ? 'Sair do modo Design (Esc)'
            : 'Modo Design: clicar elementos da página e enviar ao agente'
        }
        aria-label="Modo Design"
        onClick={() => void toggle()}
      >
        <span className="design-bar__toggle-icon" aria-hidden>
          ◎
        </span>
        <span className="design-bar__toggle-label">
          {isActive ? 'Design ON' : 'Design'}
        </span>
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
          <select
            data-testid="design-annotation-intent"
            className="design-bar__target"
            value={annotationIntent}
            aria-label="Intenção da anotação"
            onChange={(e) =>
              setAnnotationIntent(e.target.value as BrowserDesignAnnotationIntent)
            }
          >
            {ANNOTATION_INTENTS.map((intent) => (
              <option key={intent.value} value={intent.value}>
                {intent.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="design-annotate"
            className="browser-bar__btn design-bar__send"
            title="Anotar: fixa o comentário neste elemento (badge numerado na página) para enviar tudo junto depois"
            onClick={() => void annotate()}
          >
            ＋ anotar
          </button>
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
            data-testid="design-copy"
            className="browser-bar__btn design-bar__send"
            disabled={!effectiveTarget}
            title={
              effectiveTarget
                ? 'Copiar o contexto da seleção (sem enviar ao agente)'
                : 'Abra um pane de agente CLI para preparar o contexto'
            }
            onClick={() => void copyContext()}
          >
            ⧉ copiar
          </button>
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
      {annotations.length > 0 && (
        <button
          type="button"
          data-testid="design-annotations-badge"
          className={`browser-bar__btn design-bar__annotations-badge ${trayOpen ? 'design-bar__toggle--on' : ''}`}
          aria-pressed={trayOpen}
          title="Anotações fixadas nesta página (sobrevivem ao modo Design; somem ao navegar)"
          onClick={() => setTrayOpen((open) => !open)}
        >
          📝 {annotations.length}
        </button>
      )}
      {status && <span className="design-bar__status">{status}</span>}
    </div>
      {trayOpen && annotations.length > 0 && (
        <div className="design-annotations-tray nodrag" data-testid="design-annotations-tray">
          <ul className="design-annotations-tray__list">
            {annotations.map((annotation) => (
              <li key={annotation.id} className="design-annotations-tray__item">
                <span
                  className="design-annotations-tray__label"
                  title={annotation.label}
                >
                  #{annotation.index} [{intentLabel(annotation.intent)}]{' '}
                  {annotation.label}
                </span>
                <span className="design-annotations-tray__comment">
                  {annotation.comment}
                </span>
                <button
                  type="button"
                  data-testid={`design-annotation-delete-${annotation.index}`}
                  className="browser-bar__btn design-annotations-tray__delete"
                  title="Excluir esta anotação"
                  aria-label={`Excluir anotação ${annotation.index}`}
                  onClick={() => void deleteAnnotation(annotation.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="design-annotations-tray__actions">
            <button
              type="button"
              data-testid="design-annotations-send"
              className="browser-bar__btn design-bar__send"
              disabled={!effectiveTarget}
              title={
                effectiveTarget
                  ? 'Enviar TODAS as anotações pro agente como um feedback único'
                  : 'Abra um pane de agente CLI para receber o feedback'
              }
              onClick={() => void sendAnnotations(false)}
            >
              → agente ({annotations.length})
            </button>
            <button
              type="button"
              data-testid="design-annotations-copy"
              className="browser-bar__btn"
              disabled={!effectiveTarget}
              title="Copiar o feedback consolidado (sem enviar)"
              onClick={() => void sendAnnotations(true)}
            >
              ⧉ copiar
            </button>
            <button
              type="button"
              data-testid="design-annotations-clear"
              className="browser-bar__btn"
              title="Limpar todas as anotações desta página"
              onClick={() => void clearAnnotations()}
            >
              limpar
            </button>
          </div>
        </div>
      )}
    </>
  );
}
