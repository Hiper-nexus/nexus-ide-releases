import { useRef } from 'react';
import {
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  useRailWidthStore,
} from '../../state/rail-width-store';

const KEYBOARD_STEP = 8;
const KEYBOARD_STEP_COARSE = 24;

/**
 * Alça de largura do rail. DESIGN.md §11 descreve o rail como "largura
 * persistente de 250px (faixa permitida: 200-280px)" — a faixa nunca existiu no
 * produto, então em janela estreita o rail comia um terço do canvas sem escape,
 * e quem queria ler o caminho da pasta não tinha como pedir mais espaço.
 */
export function RailResizer() {
  const width = useRailWidthStore((state) => state.width);
  const setWidth = useRailWidthStore((state) => state.setWidth);
  const dragging = useRef(false);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEYBOARD_STEP_COARSE : KEYBOARD_STEP;
    if (event.key === 'ArrowLeft') setWidth(width - step);
    else if (event.key === 'ArrowRight') setWidth(width + step);
    else if (event.key === 'Home') setWidth(RAIL_WIDTH_MIN);
    else if (event.key === 'End') setWidth(RAIL_WIDTH_MAX);
    else return;
    event.preventDefault();
  }

  return (
    <div
      className="nexus-shell__rail-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Largura da barra lateral"
      aria-valuenow={width}
      aria-valuemin={RAIL_WIDTH_MIN}
      aria-valuemax={RAIL_WIDTH_MAX}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      title="Arraste para ajustar. Duplo clique volta ao padrão."
      onPointerDown={(event) => {
        event.preventDefault();
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const frame = event.currentTarget.parentElement?.getBoundingClientRect();
        setWidth(event.clientX - (frame?.left ?? 0));
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        dragging.current = false;
      }}
      onDoubleClick={() => useRailWidthStore.getState().reset()}
      onKeyDown={handleKeyDown}
    />
  );
}
