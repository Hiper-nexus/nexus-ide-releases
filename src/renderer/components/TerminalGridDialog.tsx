import { useEffect, useRef, useState } from 'react';
import { useTerminalGridDialogStore } from '../state/terminal-grid-dialog-store';
import { useLayoutStore } from '../state/layout-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { createPane } from '../lib/split-tree';
import { PixelIcon } from './PixelIcon';

interface GridPreset {
  readonly count: number;
  readonly label: string;
  readonly description: string;
  readonly layout: string;
}

const PRESETS: readonly GridPreset[] = [
  {
    count: 1,
    label: '1 Terminal',
    description: 'Tela inteira',
    layout: '1×1',
  },
  {
    count: 2,
    label: '2 Terminais',
    description: 'Lado a lado',
    layout: '2×1',
  },
  {
    count: 3,
    label: '3 Terminais',
    description: '1 principal + 2 splits',
    layout: '3',
  },
  {
    count: 4,
    label: '4 Terminais',
    description: 'Grade balanceada',
    layout: '2×2',
  },
  {
    count: 6,
    label: '6 Terminais',
    description: 'Painel multi-serviço',
    layout: '3×2',
  },
];

export function TerminalGridDialog() {
  const isOpen = useTerminalGridDialogStore((s) => s.isOpen);
  const options = useTerminalGridDialogStore((s) => s.options);
  const close = useTerminalGridDialogStore((s) => s.close);

  const [count, setCount] = useState<number>(options.initialCount ?? 2);
  const [replaceExisting, setReplaceExisting] = useState<boolean>(
    options.replaceExisting ?? true,
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      setCount(options.initialCount ?? 2);
      setReplaceExisting(options.replaceExisting ?? true);
      confirmBtnRef.current?.focus();
    }
  }, [isOpen, options]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleLaunch();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [isOpen, count, replaceExisting]);

  if (!isOpen) return null;

  const handleLaunch = () => {
    const validCount = Math.max(1, Math.min(8, count));
    if (replaceExisting) {
      const panes = Array.from({ length: validCount }, () => createPane('shell'));
      useLayoutStore.getState().setPanes(panes);
    } else {
      for (let i = 0; i < validCount; i++) {
        useLayoutStore.getState().addShellPane();
      }
    }
    useProductNavigationStore.getState().openTerminal();
    close();
  };

  return (
    <div
      className="confirm"
      role="dialog"
      aria-modal="true"
      aria-label="Quantos terminais deseja abrir?"
      ref={dialogRef}
    >
      <div className="confirm__overlay" onClick={close} />
      <div className="confirm__panel confirm__panel--terminal-grid">
        <div className="terminal-grid-dialog__header">
          <div className="terminal-grid-dialog__icon" aria-hidden="true">
            <PixelIcon name="terminal" size={18} />
          </div>
          <div>
            <h3 className="confirm__title">Quantos terminais deseja abrir?</h3>
            <p className="confirm__body">
              Escolha a quantidade para organizar o mosaico de terminais no grid.
            </p>
          </div>
        </div>

        <div className="terminal-grid-dialog__presets" role="radiogroup" aria-label="Presets de grid">
          {PRESETS.map((preset) => {
            const isSelected = count === preset.count;
            return (
              <button
                key={preset.count}
                type="button"
                className={`terminal-grid-dialog__preset-btn${
                  isSelected ? ' terminal-grid-dialog__preset-btn--selected' : ''
                }`}
                onClick={() => setCount(preset.count)}
                role="radio"
                aria-checked={isSelected}
              >
                <div className="terminal-grid-dialog__preset-top">
                  <strong className="terminal-grid-dialog__preset-label">
                    {preset.label}
                  </strong>
                  <span className="terminal-grid-dialog__preset-tag">
                    {preset.layout}
                  </span>
                </div>
                <span className="terminal-grid-dialog__preset-desc">
                  {preset.description}
                </span>
              </button>
            );
          })}
        </div>

        <div className="terminal-grid-dialog__stepper-row">
          <span className="terminal-grid-dialog__stepper-label">
            Quantidade personalizada:
          </span>
          <div className="terminal-grid-dialog__stepper">
            <button
              type="button"
              className="terminal-grid-dialog__step-btn"
              disabled={count <= 1}
              onClick={() => setCount((prev) => Math.max(1, prev - 1))}
              aria-label="Diminuir terminais"
            >
              −
            </button>
            <span className="terminal-grid-dialog__step-value" aria-live="polite">
              {count} {count === 1 ? 'terminal' : 'terminais'}
            </span>
            <button
              type="button"
              className="terminal-grid-dialog__step-btn"
              disabled={count >= 8}
              onClick={() => setCount((prev) => Math.min(8, prev + 1))}
              aria-label="Aumentar terminais"
            >
              +
            </button>
          </div>
        </div>

        <label className="terminal-grid-dialog__toggle">
          <input
            type="checkbox"
            checked={replaceExisting}
            onChange={(e) => setReplaceExisting(e.target.checked)}
          />
          <span>Substituir grid atual (abrir novo mosaico limpo)</span>
        </label>

        <div className="confirm__actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="confirm__btn"
            onClick={close}
          >
            Cancelar
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className="confirm__btn confirm__btn--primary"
            onClick={handleLaunch}
          >
            Abrir {count} {count === 1 ? 'Terminal' : 'Terminais'}
          </button>
        </div>
      </div>
    </div>
  );
}
