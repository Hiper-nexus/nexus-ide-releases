import { useEffect, useMemo, useState } from 'react';
import type { BrowserDesignAnnotationIntent } from '../../shared/browser-design';
import { DESIGN_ANNOTATION_INTENT_LABELS } from '../../shared/browser-design';
import { setBrowserViewportOverride } from '../browser/browser-host';
import { DESIGN_BREAKPOINTS } from '../browser/viewport-override';
import { listPanes } from '../lib/split-tree';
import { useDesignSelectionStore } from '../state/design-selection-store';
import { useLayoutStore } from '../state/layout-store';
import { PixelIcon } from './PixelIcon';

const EMPTY_SELECTIONS: never[] = [];
const EMPTY_ANNOTATIONS: never[] = [];

const ANNOTATION_INTENTS = Object.entries(
  DESIGN_ANNOTATION_INTENT_LABELS,
) as Array<[BrowserDesignAnnotationIntent, string]>;

function intentLabel(intent: string): string {
  return (
    DESIGN_ANNOTATION_INTENT_LABELS[
      intent as BrowserDesignAnnotationIntent
    ] ?? intent
  );
}

function breakpointLabel(width: number): string {
  if (width <= 480) return 'Mobile';
  if (width <= 1024) return 'Tablet';
  return 'Desktop';
}

function breakpointIcon(width: number): string {
  if (width <= 480) return '📱';
  if (width <= 1024) return '▯';
  return '🖥';
}

/**
 * Erros que significam "o pane/escopo mudou de vida" — lifecycle benigno, não
 * falha do usuário. A barra reseta em silêncio (mesma doutrina do catch vazio
 * do listDesignAnnotations no mount).
 */
export function isBenignDesignLifecycleError(message: string): boolean {
  return /unknown browser pane|renderer has no authorized workspace scope|browser pane belongs to another/i.test(
    message,
  );
}

/** Traduz o wrapper cru do Electron para texto curto e acionável. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const inner = raw.replace(
    /^Error invoking remote method '[^']+':\s*Error:\s*/,
    '',
  );
  if (/live mission agent in the same project checkout/i.test(inner)) {
    return 'envio requer um agente de missão ativo neste workspace — lance uma missão ou use ⧉ copiar';
  }
  if (/frozen context revision/i.test(inner)) {
    return 'o agente alvo não está no contrato atual da missão — reabra a missão ou use ⧉ copiar';
  }
  if (/design mode transition was not applied/i.test(inner)) {
    return 'a página não confirmou o modo Design — recarregue a página e tente de novo';
  }
  return inner;
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

  function reportError(err: unknown): void {
    const raw = err instanceof Error ? err.message : String(err);
    if (isBenignDesignLifecycleError(raw)) {
      // Pane/escopo mudou de vida no meio da chamada — a barra reseta pelos
      // eventos de modo; erro cru aqui só assusta sem ação possível.
      setStatus(null);
      return;
    }
    setStatus(errorText(err));
  }
  const [targetPaneId, setTargetPaneId] = useState<string | null>(null);
  const [annotationIntent, setAnnotationIntent] =
    useState<BrowserDesignAnnotationIntent>('fix');
  const [annotationComment, setAnnotationComment] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
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
      reportError(err);
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
      reportError(err);
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
      reportError(err);
    }
  }

  async function annotate(): Promise<void> {
    if (!selection) return;
    const comment = annotationComment.trim();
    if (!comment) {
      setStatus('escreva o comentário da anotação');
      return;
    }
    try {
      const result = await window.nexus.browser.designAnnotate(paneId, {
        comment,
        intent: annotationIntent,
      });
      setAnnotations(paneId, result.annotations);
      setAnnotationComment('');
      setTrayOpen(true);
      setStatus(`anotação #${result.annotations.length} adicionada ✓`);
    } catch (err) {
      reportError(err);
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
      reportError(err);
    }
  }

  async function clearAnnotations(): Promise<void> {
    try {
      const result = await window.nexus.browser.clearDesignAnnotations(paneId);
      setAnnotations(paneId, result.annotations);
      setTrayOpen(false);
      setStatus('anotações limpas');
    } catch (err) {
      reportError(err);
    }
  }

  async function sendAnnotations(dryRun: boolean): Promise<void> {
    if (annotations.length === 0) return;
    // Copiar (dryRun) funciona SEM agente alvo — nada é injetado.
    if (!dryRun && !effectiveTarget) return;
    setStatus(dryRun ? 'preparando feedback…' : 'enviando feedback…');
    try {
      const result = await window.nexus.browser.sendDesignAnnotations(paneId, {
        ...(dryRun ? { dryRun: true } : {}),
        ...(!dryRun && effectiveTarget ? { targetPaneId: effectiveTarget } : {}),
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
      reportError(err);
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
      {/* Preview responsivo é ferramenta de VISUALIZAÇÃO — vive sempre na
          barra, sem depender do picker do modo Design (achado de operador:
          "modo mobile nem aparece"). */}
      <span className="design-bar__breakpoints">
        {DESIGN_BREAKPOINTS.map((width) => (
          <button
            key={width}
            type="button"
            data-testid={`design-bp-${width}`}
            className={`browser-bar__btn design-bar__bp ${breakpoint === width ? 'design-bar__toggle--on' : ''}`}
            title={`${breakpointLabel(width)} — preview em ${width}px`}
            aria-label={`Preview ${breakpointLabel(width)} (${width}px)`}
            onClick={() => {
              setBreakpoint(width);
              setBrowserViewportOverride(paneId, width);
              // ≤480 também emula device (UA mobile + métricas, com reload):
              // o site serve o layout mobile REAL, não só a largura.
              window.nexus.browser
                .setDeviceEmulation(paneId, width)
                .catch(() => reportError(new Error('emulação de device falhou')));
            }}
          >
            {breakpointIcon(width)} {width}
          </button>
        ))}
        <button
          type="button"
          data-testid="design-bp-full"
          className={`browser-bar__btn design-bar__bp ${breakpoint === null ? 'design-bar__toggle--on' : ''}`}
          title="Largura total do pane"
          aria-label="Largura total do pane"
          onClick={() => {
            setBreakpoint(null);
            setBrowserViewportOverride(paneId, null);
            window.nexus.browser.setDeviceEmulation(paneId, null).catch(() => {
              // desligar emulação é best-effort; navegação seguinte normaliza
            });
          }}
        >
          ⛶
        </button>
      </span>
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
          <button
            type="button"
            data-testid="design-annotate"
            className={`browser-bar__btn design-bar__send ${composerOpen ? 'design-bar__toggle--on' : ''}`}
            aria-pressed={composerOpen}
            title="Anotar: fixa um comentário neste elemento (badge numerado na página) para enviar tudo junto depois"
            onClick={() => setComposerOpen((open) => !open)}
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
            aria-label="Estilos do elemento (sidebar)"
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
          aria-label={`Anotações fixadas nesta página (${annotations.length})`}
          onClick={() => setTrayOpen((open) => !open)}
        >
          📝 {annotations.length}
        </button>
      )}
      {status && (
        <span className="design-bar__status" title={status}>
          {status}
        </span>
      )}
    </div>
      {composerOpen && isActive && selection && (
        <div
          className="design-annotations-composer nodrag"
          data-testid="design-annotation-composer"
        >
          <input
            data-testid="design-annotation-comment"
            className="design-bar__instruction"
            placeholder="comentário da anotação (fixa no elemento selecionado)"
            value={annotationComment}
            spellCheck={false}
            onChange={(e) => setAnnotationComment(e.target.value)}
            onKeyDown={(e) => {
              // Enter AQUI anota — nunca envia nada pro agente.
              if (e.key === 'Enter') void annotate();
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
            {ANNOTATION_INTENTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="design-annotation-add"
            className="browser-bar__btn design-bar__send"
            title="Fixar a anotação neste elemento"
            onClick={() => void annotate()}
          >
            fixar
          </button>
        </div>
      )}
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
                  <PixelIcon name="close" size={11} />
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
              title="Copiar o feedback consolidado (sem enviar; não precisa de agente)"
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
