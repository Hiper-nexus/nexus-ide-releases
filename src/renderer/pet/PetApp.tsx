import { useCallback, useEffect, useRef, useState } from 'react';
import type { PetPrefs } from '../../shared/pet-types';
import { OperatorSprite, type OperatorMood } from '../components/OperatorSprite';
import { CustomPetSprite } from './CustomPetSprite';
import { SheetPetSprite, type SheetAnim } from './SheetPetSprite';
import {
  BALLOON_DURATION_MS,
  EMPTY_BALLOON_QUEUE,
  dismissBalloon,
  enqueueBalloon,
  type BalloonQueueState,
} from './pet-balloon-queue';

/**
 * Janela do pet: sprite arrastável + balões de evento + menu de contexto.
 * A janela é click-through por padrão; marcar interatividade sob o cursor é
 * responsabilidade daqui (mouseenter/leave → nexusPet.setInteractive).
 */

const SPRITE_SIZE = 112;
const DRAG_THRESHOLD_PX = 4;
const CELEBRATE_MS = 3_000;

/** Preset → props do OperatorSprite (skins já existentes da gamificação). */
function spriteSkinFor(preset: PetPrefs['preset']): string | null {
  return preset === 'operator' || preset === 'custom' ? null : preset;
}

export function PetApp() {
  const [prefs, setPrefs] = useState<PetPrefs | null>(null);
  const [balloons, setBalloons] = useState<BalloonQueueState>(
    EMPTY_BALLOON_QUEUE,
  );
  // Reação transitória a eventos: comemora (wave), lamenta (failed) ou pede
  // atenção (waiting — intervenção humana). O spritesheet Codex tem linha
  // própria para cada; o OperatorSprite usa o mood celebrating só no feliz.
  const [reaction, setReaction] = useState<'wave' | 'failed' | 'waiting' | null>(
    null,
  );
  // Direção do olhar (0..15) vinda do main — o pet segue o cursor.
  const [lookDir, setLookDir] = useState<number | null>(null);
  // Arrastando, o pet CORRE na direção do movimento (linhas 1/2 do contrato).
  const [runDir, setRunDir] = useState<'left' | 'right' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const celebrateTimer = useRef<number | null>(null);
  const drag = useRef<{ startX: number; startY: number; dragging: boolean } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void window.nexusPet.getPrefs().then((loaded) => {
      if (!cancelled) setPrefs(loaded);
    });
    const offPrefs = window.nexusPet.onPrefsChanged(setPrefs);
    const offEvents = window.nexusPet.onEvent((event) => {
      setBalloons((state) => enqueueBalloon(state, event));
      setReaction(
        event.kind === 'mission-failed' || event.kind === 'agent-exited'
          ? 'failed'
          : event.kind === 'mission-blocked'
            ? 'waiting'
            : 'wave',
      );
      if (celebrateTimer.current) window.clearTimeout(celebrateTimer.current);
      celebrateTimer.current = window.setTimeout(
        () => setReaction(null),
        CELEBRATE_MS,
      );
    });
    const offLook = window.nexusPet.onLook(setLookDir);
    return () => {
      cancelled = true;
      offPrefs();
      offEvents();
      offLook();
      if (celebrateTimer.current) window.clearTimeout(celebrateTimer.current);
    };
  }, []);

  // Balão atual expira sozinho e promove o próximo da fila. A expiração pode
  // acontecer com o cursor sobre o balão (nenhum mouseleave dispara): solta o
  // click-through explicitamente para a janela não engolir cliques do desktop.
  const currentBalloonId = balloons.current?.id ?? null;
  useEffect(() => {
    if (currentBalloonId === null) return undefined;
    const timer = window.setTimeout(() => {
      setBalloons(dismissBalloon);
      window.nexusPet.setInteractive(false);
    }, BALLOON_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [currentBalloonId]);

  const markInteractive = useCallback((interactive: boolean) => {
    window.nexusPet.setInteractive(interactive);
  }, []);

  // Drag manual com desambiguação clique×arrasto (limiar de movimento).
  // Pointer capture prende move/up ao elemento mesmo se o cursor escapar da
  // janela entre ticks do main; blur/pointercancel fecham o arrasto para o
  // timer do main NUNCA ficar preso seguindo o cursor.
  const hitRef = useRef<HTMLDivElement | null>(null);
  const onSpritePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = hitRef.current;
    if (!el) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // captura indisponível — o fluxo ainda funciona no caminho comum
    }
    drag.current = { startX: e.clientX, startY: e.clientY, dragging: false };
    let lastScreenX = e.screenX;

    const finish = (asDrag: boolean) => {
      const state = drag.current;
      drag.current = null;
      setRunDir(null);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (state?.dragging || asDrag) window.nexusPet.dragEnd();
      else if (state) setMenuOpen((open) => !open);
    };
    const onMove = (move: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      if (!state.dragging) {
        const dist = Math.hypot(
          move.clientX - state.startX,
          move.clientY - state.startY,
        );
        if (dist < DRAG_THRESHOLD_PX) return;
        state.dragging = true;
        // Offset do cursor dentro da janela: a janela passa a seguir o cursor
        // no main, então as coordenadas de cliente ficam estáveis.
        window.nexusPet.dragBegin({ x: move.clientX, y: move.clientY });
      }
      // Direção da corrida pelo movimento ABSOLUTO do cursor (screenX): as
      // coordenadas de cliente ficam paradas enquanto a janela persegue o
      // cursor. Histerese de 2px segura o flicker em micro-movimentos.
      const dx = move.screenX - lastScreenX;
      lastScreenX = move.screenX;
      if (dx > 2) setRunDir('right');
      else if (dx < -2) setRunDir('left');
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(true);
    const onBlur = () => finish(true);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
  }, []);

  if (!prefs) return null;

  const celebrating = reaction === 'wave' && runDir === null;
  const mood: OperatorMood = prefs.sleeping
    ? 'sleeping'
    : celebrating
      ? 'celebrating'
      : 'idle';
  // Prioridade: dormir > correr (arrasto) > reação > idle/olhar.
  const sheetAnim: SheetAnim = prefs.sleeping
    ? 'sleep'
    : runDir !== null
      ? (`run-${runDir}` as SheetAnim)
      : (reaction ?? 'idle');

  const balloon = balloons.current;

  return (
    <div className={`pet ${prefs.solidBackground ? 'pet--solid' : ''}`}>
      {balloon && !prefs.sleeping && (
        <button
          type="button"
          className={`pet__balloon pet__balloon--${balloon.kind}`}
          onMouseEnter={() => markInteractive(true)}
          onMouseLeave={() => markInteractive(false)}
          onClick={() => {
            window.nexusPet.focusMain();
            setBalloons(dismissBalloon);
            // O balão some sob o cursor sem mouseleave — devolve o click-through.
            markInteractive(false);
          }}
          title="Abrir o NexusIDE"
        >
          {balloon.text}
        </button>
      )}

      {menuOpen && (
        <div
          className="pet__menu"
          role="menu"
          onMouseEnter={() => markInteractive(true)}
          onMouseLeave={() => markInteractive(false)}
        >
          <button
            type="button"
            role="menuitem"
            className="pet__menu-item"
            onClick={() => {
              void window.nexusPet.setPrefs({ sleeping: !prefs.sleeping });
              setMenuOpen(false);
              // Menu some sob o cursor sem mouseleave — devolve o click-through.
              markInteractive(false);
            }}
          >
            {prefs.sleeping ? 'Acordar' : 'Dormir'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet__menu-item"
            onClick={() => {
              window.nexusPet.openSettings();
              setMenuOpen(false);
              markInteractive(false);
            }}
          >
            Configurar…
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet__menu-item pet__menu-item--danger"
            onClick={() => {
              void window.nexusPet.setPrefs({ enabled: false });
            }}
          >
            Esconder pet
          </button>
        </div>
      )}

      <div
        ref={hitRef}
        className={`pet__hit ${
          prefs.preset === 'sheet' && prefs.sheet
            ? 'pet__hit--sheet'
            : 'pet__hit--pixel'
        } ${prefs.sleeping ? 'pet__hit--sleeping' : ''} ${
          celebrating ? 'pet__hit--celebrating' : ''
        } ${runDir !== null ? 'pet__hit--dragging' : ''}`}
        onMouseEnter={() => markInteractive(true)}
        onMouseLeave={() => {
          // Durante o arrasto a janela PRECISA continuar interativa, senão o
          // mouseup vaza para a janela de baixo e o drag nunca termina.
          if (!drag.current?.dragging) markInteractive(false);
        }}
        onPointerDown={onSpritePointerDown}
        title={prefs.sleeping ? 'Pet dormindo — clique para o menu' : 'NexusIDE Pet'}
      >
        {prefs.preset === 'sheet' && prefs.sheet ? (
          <SheetPetSprite
            sheet={prefs.sheet}
            anim={sheetAnim}
            lookDir={lookDir}
            size={SPRITE_SIZE + 16}
          />
        ) : prefs.preset === 'custom' && prefs.customGrid ? (
          <CustomPetSprite grid={prefs.customGrid} size={SPRITE_SIZE} />
        ) : (
          <OperatorSprite
            size={SPRITE_SIZE}
            tier="ELITE"
            branch="base"
            skin={spriteSkinFor(prefs.preset)}
            mood={mood}
          />
        )}
        {prefs.sleeping && (
          <span className="pet__zzz" aria-hidden="true">
            z z z
          </span>
        )}
      </div>
    </div>
  );
}
