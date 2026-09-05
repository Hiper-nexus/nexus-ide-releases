import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ProviderLogo } from '../ProviderLogo';
import './model-reel.css';

export interface ModelReelOption {
  adapterId: string;
  adapterLabel: string;
  model: string;
  ready?: boolean;
  reason?: string;
}

interface ModelReelProps<T extends ModelReelOption> {
  options: readonly T[];
  selected?: { adapterId: string; model: string } | null;
  onSelect(option: T): void;
}

/** Browsing never commits a choice; only activating a model changes the roster. */
export function ModelReel<T extends ModelReelOption>({ options, selected, onSelect }: ModelReelProps<T>) {
  const viewport = useRef<HTMLDivElement>(null);
  const center = (button: HTMLButtonElement | null) => {
    const container = viewport.current;
    if (!container || !button) return;
    container.scrollTo?.({
      top: button.offsetTop - container.clientHeight / 2 + button.clientHeight / 2,
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  };
  useEffect(() => {
    center(viewport.current?.querySelector('[aria-pressed="true"]') ?? null);
  }, [selected?.adapterId, selected?.model]);

  const navigate = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(viewport.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const current = buttons.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus({ preventScroll: true });
    center(buttons[next] ?? null);
  };

  return (
    <div className="model-reel" aria-label="Explorar modelos">
      <div className="model-reel__viewport" ref={viewport}>
        {options.map((option) => {
          const active = selected?.adapterId === option.adapterId && selected.model === option.model;
          return (
            <button key={`${option.adapterId}:${option.model}`} type="button" data-model-option
              className="model-reel__option" aria-pressed={active} disabled={option.ready === false}
              title={option.ready === false ? option.reason : `${option.adapterLabel} · ${option.model}`}
              onKeyDown={navigate} onClick={() => onSelect(option)}>
              <ProviderLogo adapterId={option.adapterId} label={option.adapterLabel} size="md" />
              <span className="model-reel__identity"><strong>{option.model}</strong>
                <small>{option.ready === false ? option.reason ?? 'Conecte esta ferramenta' : option.adapterLabel}</small>
              </span>
              <span className="model-reel__selection" aria-hidden="true">{active ? '✓' : '›'}</span>
            </button>
          );
        })}
      </div>
      <span className="model-reel__hint">Role para explorar · clique para escolher</span>
    </div>
  );
}
