import { useCallback, useEffect, useRef, useState } from 'react';
import type { PetPlacement, PetPrefs } from '../../shared/pet-types';
import { isPetUrgentEvent } from '../../shared/pet-types';
import { OperatorSprite, type OperatorMood } from '../components/OperatorSprite';
import { CoffeeCup } from './CoffeeCup';
import { CustomPetSprite } from './CustomPetSprite';
import { SheetPetSprite, type SheetAnim } from './SheetPetSprite';
import {
  EMPTY_BALLOON_QUEUE,
  dismissBalloon,
  enqueueBalloon,
  type BalloonQueueState,
} from './pet-balloon-queue';
import { PET_INTERACTIVE_SELECTOR } from './pet-hit-test';

/**
 * Janela do pet: sprite arrastável + balões de evento + menu de contexto.
 * A janela é click-through por padrão; marcar interatividade sob o cursor é
 * responsabilidade daqui (mouseenter/leave → nexusPet.setInteractive).
 *
 * Interatividade operacional:
 * - balão com CTA → Ops Board / main
 * - clique no sprite com aviso de intervenção → mesma ação
 * - menu "Ver missões"
 */

/** Sprite compacto no desktop (evita o pet “gigante” em monitores 1x/2x). */
const SPRITE_SIZE = 96;
/**
 * Altura do sheet no desktop. 144px dá presença aos pets v2 cujo personagem
 * usa margem segura no atlas, sem invadir a área de trabalho.
 */
const SHEET_SIZE = 144;
/** Limiar baixo: o utilizador reportava ter de “forçar” o rato para arrastar. */
const DRAG_THRESHOLD_PX = 2;
/** Re-sync IPC no máximo a cada N ms enquanto o cursor está sobre o hit. */
const INTERACTIVE_RESYNC_MS = 400;
/** Histerese de direção da corrida — micro-dx no arrasto não vira o pet. */
const RUN_DIR_HYSTERESIS_PX = 14;
/** Tempo mínimo numa direção antes de poder inverter (evita piscar L↔R). */
const RUN_DIR_MIN_MS = 90;
const CELEBRATE_MS = 3_000;
/** Mesmo tempo do celebrate: o "cafe" flutua por 3 s e desaparece. */
const CAFEINANDO_MS = CELEBRATE_MS;

/** Preset → props do OperatorSprite (skins já existentes da gamificação). */
function spriteSkinFor(preset: PetPrefs['preset']): string | null {
  return preset === 'operator' || preset === 'custom' ? null : preset;
}

function runBalloonAction(action: 'focus-main' | 'open-ops'): void {
  if (action === 'open-ops') window.nexusPet.openOps();
  else window.nexusPet.focusMain();
}

export function PetApp() {
  const [prefs, setPrefs] = useState<PetPrefs | null>(null);
  const [balloons, setBalloons] = useState<BalloonQueueState>(
    EMPTY_BALLOON_QUEUE,
  );
  // Reação transitória a eventos: comemora (wave), lamenta (failed) ou pede
  // atenção (waiting — intervenção humana). O spritesheet Codex tem linha
  // própria para cada; o OperatorSprite usa o mood celebrating só no feliz.
  // Intervenção NÃO expira por timer: fica até o balão ser dispensado.
  const [reaction, setReaction] = useState<'wave' | 'failed' | 'waiting' | null>(
    null,
  );
  /**
   * Look desligado de propósito neste pet full-res:
   * frames look (peito) + idle (notebook ao lado) alternam e, com residual
   * de compositor, parecem “dois notebooks”. Corrida idle mantém-se.
   * lookDir fixo null; onLook não actualiza UI.
   */
  const lookDir: number | null = null;
  // Arrastando: corre L/R (linhas 1/2 do contrato) — pernas a mexer.
  const [runDir, setRunDir] = useState<'left' | 'right' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [placement, setPlacement] = useState<PetPlacement>({
    horizontal: 'center',
    vertical: 'bottom',
  });
  const celebrateTimer = useRef<number | null>(null);
  /** Flash visual quando um agente fica idle (agent-idle = tarefa concluída). */
  const [cafeinando, setCafeinando] = useState(false);
  const cafeinadoTimer = useRef<number | null>(null);
  const drag = useRef<{ startX: number; startY: number; dragging: boolean } | null>(
    null,
  );
  // Leave-debounce: enter/leave no canto dispara em rajada.
  // NÃO skip o IPC quando interactiveRef já é true — o main pode ter voltado
  // a ignore=true (drag settle / showInactive) e o early-return deixava o pet
  // “de vidro”: visível, mouseenter não re-arma, não arrasta.
  const interactiveRef = useRef(false);
  const leaveTimerRef = useRef<number | null>(null);
  const lastInteractiveSyncAt = useRef(0);
  const hitRef = useRef<HTMLDivElement | null>(null);
  const markInteractive = useCallback((interactive: boolean) => {
    if (interactive) {
      if (leaveTimerRef.current !== null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      const now = performance.now();
      const was = interactiveRef.current;
      interactiveRef.current = true;
      // 1º enter: IPC imediato. Enquanto fica em cima: re-sync throttled
      // (corrige main a perder ignore sem flood a cada mousemove).
      if (!was || now - lastInteractiveSyncAt.current >= INTERACTIVE_RESYNC_MS) {
        lastInteractiveSyncAt.current = now;
        window.nexusPet.setInteractive(true);
      }
      return;
    }
    // Debounce leave: bob/edge micro-leave não desliga o hit-test.
    if (leaveTimerRef.current !== null) return;
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      if (!interactiveRef.current) return;
      // Arrasto a meio: nunca largar o hit-test (mouseup vaza para o IDE).
      if (drag.current?.dragging) return;
      interactiveRef.current = false;
      lastInteractiveSyncAt.current = 0;
      window.nexusPet.setInteractive(false);
    }, 140);
  }, []);

  /**
   * Após balão sumir: se o cursor ainda está no sprite, re-armar interactive
   * (mouseenter não re-dispara). Senão, click-through limpo.
   */
  const releaseInteractiveAfterOverlay = useCallback(() => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    const stillOnHit = Boolean(hitRef.current?.matches(':hover'));
    if (stillOnHit || drag.current?.dragging) {
      interactiveRef.current = true;
      window.nexusPet.setInteractive(true);
      return;
    }
    interactiveRef.current = false;
    window.nexusPet.setInteractive(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.nexusPet.getPrefs().then((loaded) => {
      if (!cancelled) setPrefs(loaded);
    });
    const offPrefs = window.nexusPet.onPrefsChanged(setPrefs);
    const offPlacement = window.nexusPet.onPlacement(setPlacement);
    const offEvents = window.nexusPet.onEvent((event) => {
      setBalloons((state) => enqueueBalloon(state, event));
      const nextReaction: 'wave' | 'failed' | 'waiting' =
        event.kind === 'mission-failed' ||
        event.kind === 'mission-technical-failure' ||
        event.kind === 'agent-exited'
          ? 'failed'
          : event.kind === 'mission-blocked' || event.kind === 'agent-waiting'
            ? 'waiting'
            : 'wave';
      setReaction(nextReaction);
      if (celebrateTimer.current) window.clearTimeout(celebrateTimer.current);
      // Intervenção fica no mood waiting enquanto o balão existir.
      if (!isPetUrgentEvent(event.kind)) {
        celebrateTimer.current = window.setTimeout(
          () => setReaction(null),
          CELEBRATE_MS,
        );
      }
      // Flash "cafe" no pane livre e na missão entregue — o balão
      // continua operacional ("Missão concluída"); o café é a batida.
      if (event.kind === 'agent-idle' || event.kind === 'mission-done') {
        if (cafeinadoTimer.current) window.clearTimeout(cafeinadoTimer.current);
        setCafeinando(true);
        cafeinadoTimer.current = window.setTimeout(
          () => setCafeinando(false),
          CAFEINANDO_MS,
        );
      }
      // Crise urgente: cancela o flash "cafe" imediatamente — café durante
      // intervenção é distração e contradição visual com o badge de alerta.
      if (isPetUrgentEvent(event.kind)) {
        if (cafeinadoTimer.current) {
          window.clearTimeout(cafeinadoTimer.current);
          cafeinadoTimer.current = null;
        }
        setCafeinando(false);
      }
    });
    // StrictMode monta/limpa o primeiro effect de propósito. Adiar um tick e
    // cancelar no cleanup garante que só a assinatura estável libera a fila.
    const readyTimer = window.setTimeout(() => window.nexusPet.ready(), 0);
    // Com ignore+forward o Electron manda mousemove mesmo em click-through.
    // Cobre sprite + balão + menu (não só pet__hit).
    const onWinMove = (e: MouseEvent) => {
      if (drag.current?.dragging) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const over = Boolean(under?.closest?.(PET_INTERACTIVE_SELECTOR));
      if (over) markInteractive(true);
      else markInteractive(false);
    };
    window.addEventListener('mousemove', onWinMove);
    return () => {
      cancelled = true;
      window.clearTimeout(readyTimer);
      offPrefs();
      offPlacement();
      offEvents();
      window.removeEventListener('mousemove', onWinMove);
      if (celebrateTimer.current) window.clearTimeout(celebrateTimer.current);
      if (cafeinadoTimer.current) window.clearTimeout(cafeinadoTimer.current);
      if (leaveTimerRef.current !== null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      interactiveRef.current = false;
      try {
        window.nexusPet.setInteractive(false);
      } catch {
        // preload pode já ter morrido com a janela
      }
    };
  }, [markInteractive]);

  // Um aviso é uma pendência, não um toast: permanece até o usuário clicar
  // em sua ação, em "Depois" ou no próprio pet. Isso evita perder um alerta
  // enquanto o usuário muda de tela ou lê o contexto da missão.
  const currentBalloon = balloons.current;
  const currentBalloonId = currentBalloon?.id ?? null;

  useEffect(() => {
    if (currentBalloonId === null) return undefined;
    const shownFrame = window.requestAnimationFrame(() => {
      if (currentBalloon) window.nexusPet.eventShown(currentBalloon.kind);
    });
    return () => {
      window.cancelAnimationFrame(shownFrame);
    };
  }, [
    currentBalloon,
    currentBalloonId,
  ]);

  const dismissAndAct = useCallback((action: 'focus-main' | 'open-ops') => {
    runBalloonAction(action);
    setBalloons(dismissBalloon);
    setReaction(null);
    setMenuOpen(false);
    releaseInteractiveAfterOverlay();
  }, [releaseInteractiveAfterOverlay]);

  // Drag: limiar em screen coords (clientX “congela” quando a janela segue).
  // Main faz o follow por cursor; pointer capture + interactive forçado.
  const onSpritePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = hitRef.current;
    if (!el) return;
    // Hit-test ON durante todo o gesto (click-through matava o arrasto).
    markInteractive(true);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // captura indisponível — o fluxo ainda funciona no caminho comum
    }
    drag.current = {
      startX: e.screenX,
      startY: e.screenY,
      dragging: false,
    };

    let lastScreenX = e.screenX;
    let runDirLocked: 'left' | 'right' | null = null;
    let runDirSince = 0;
    let dxAccum = 0;

    const finish = (asDrag: boolean) => {
      const state = drag.current;
      drag.current = null;
      setRunDir(null);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onLostCapture);
      if (el.hasPointerCapture(e.pointerId)) {
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
      if (state?.dragging || asDrag) {
        window.nexusPet.dragEnd();
        // settle no main força ignore=true; re-sincroniza se o rato ficou no pet.
        interactiveRef.current = false;
        if (el.matches(':hover')) markInteractive(true);
        else markInteractive(false);
      } else if (state) {
        // Clique sem arrasto: se há intervenção, age; senão abre o menu.
        setBalloons((queue) => {
          const balloon = queue.current;
          if (balloon?.urgent || balloon?.action === 'open-ops') {
            runBalloonAction(balloon.action);
            markInteractive(false);
            setReaction(null);
            setMenuOpen(false);
            return dismissBalloon(queue);
          }
          setMenuOpen((open) => !open);
          return queue;
        });
      }
    };
    const onMove = (move: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      if (!state.dragging) {
        const dist = Math.hypot(
          move.screenX - state.startX,
          move.screenY - state.startY,
        );
        if (dist < DRAG_THRESHOLD_PX) return;
        state.dragging = true;
        markInteractive(true);
        window.nexusPet.dragBegin({ x: move.clientX, y: move.clientY });
      }
      // Corrida L/R pelo screenX (clientX fica parado com a janela a seguir).
      const dx = move.screenX - lastScreenX;
      lastScreenX = move.screenX;
      dxAccum += dx;
      const now = performance.now();
      const want: 'left' | 'right' | null =
        dxAccum > RUN_DIR_HYSTERESIS_PX
          ? 'right'
          : dxAccum < -RUN_DIR_HYSTERESIS_PX
            ? 'left'
            : null;
      if (want === null) return;
      dxAccum = 0;
      if (want === runDirLocked) return;
      if (runDirLocked !== null && now - runDirSince < RUN_DIR_MIN_MS) {
        return;
      }
      runDirLocked = want;
      runDirSince = now;
      setRunDir(want);
    };
    const onUp = () => finish(false);
    // NÃO terminar no blur — matava o drag a meio do ecrã.
    const onCancel = () => finish(true);
    // Captura implícita perdida (botão solto fora da janela, OS roubou o
    // ponteiro): sem isto o pet ficava GRUDADO no mouse até o watchdog do
    // main. É o sinal canônico de "o drag morreu por fora".
    // Sempre como cancelamento: sem pointerup real não é clique — abrir o
    // menu aqui seria fantasma.
    const onLostCapture = () => finish(true);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onLostCapture);
  }, [markInteractive]);

  if (!prefs) return null;

  const celebrating = reaction === 'wave' && runDir === null;
  const needingYou = reaction === 'waiting' && runDir === null;
  const mood: OperatorMood =
    prefs.sleeping && !currentBalloon?.urgent
      ? 'sleeping'
      : celebrating
        ? 'celebrating'
        : 'idle';
  // Prioridade: dormir > correr (arrasto, pernas) > reação > idle.
  const sheetAnim: SheetAnim =
    prefs.sleeping && !currentBalloon?.urgent
      ? 'sleep'
      : runDir !== null
        ? (`run-${runDir}` as SheetAnim)
        : (reaction ?? 'idle');

  const balloon = balloons.current;
  const showAsAwake = !prefs.sleeping || Boolean(balloon?.urgent);

  return (
    <div
      className={`pet pet--${placement.horizontal} pet--${placement.vertical} ${
        prefs.solidBackground ? 'pet--solid' : ''
      } ${
        needingYou || balloon?.urgent ? 'pet--attention' : ''
      }`}
    >
      {balloon && showAsAwake && (
        <div
          className={`pet__balloon pet__balloon--${balloon.kind} ${
            balloon.urgent ? 'pet__balloon--urgent' : ''
          }`}
          onMouseEnter={() => markInteractive(true)}
          onMouseLeave={() => markInteractive(false)}
        >
          <strong className="pet__balloon-title">{balloon.title}</strong>
          <span className="pet__balloon-text" title={balloon.text}>
            {balloon.text}
          </span>
          <div className="pet__balloon-actions">
            <button
              type="button"
              className="pet__balloon-cta"
              onClick={() => dismissAndAct(balloon.action)}
              title={balloon.cta}
            >
              {balloon.cta}
            </button>
            <button
              type="button"
              className="pet__balloon-dismiss"
              onClick={() => {
                setBalloons(dismissBalloon);
                setReaction(null);
                releaseInteractiveAfterOverlay();
              }}
              title="Dispensar por agora"
            >
              Depois
            </button>
          </div>
        </div>
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
              dismissAndAct('open-ops');
            }}
          >
            Ver missões
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet__menu-item"
            onClick={() => {
              void window.nexusPet.setPrefs({ sleeping: !prefs.sleeping });
              setMenuOpen(false);
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
        } ${prefs.sleeping && !balloon?.urgent ? 'pet__hit--sleeping' : ''} ${
          celebrating ? 'pet__hit--celebrating' : ''
        } ${needingYou || balloon?.urgent ? 'pet__hit--waiting' : ''} ${
          runDir !== null ? 'pet__hit--dragging' : ''
        }`}
        onMouseEnter={() => markInteractive(true)}
        onMouseLeave={() => {
          // Durante o arrasto a janela PRECISA continuar interativa, senão o
          // mouseup vaza para a janela de baixo e o drag nunca termina.
          if (!drag.current?.dragging) markInteractive(false);
        }}
        onPointerDown={onSpritePointerDown}
        title={
          balloon?.urgent
            ? `${balloon.title} — clique para intervir`
            : prefs.sleeping
              ? 'Pet dormindo — clique para o menu'
              : 'NexusIDE Pet — clique para menu · arraste para mover'
        }
      >
        <div className="pet__visual">
          {prefs.preset === 'sheet' && prefs.sheet ? (
            <SheetPetSprite
              sheet={prefs.sheet}
              anim={sheetAnim}
              lookDir={lookDir}
              // Reserva altura para o balão dentro do BrowserWindow compacto;
              // com balão o sheet encolhe um pouco para não recortar o aviso.
              size={balloon ? Math.min(SHEET_SIZE, 100) : SHEET_SIZE}
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
          {prefs.sleeping && !balloon?.urgent && (
            <span className="pet__zzz" aria-hidden="true">
              z z z
            </span>
          )}
          {(needingYou || balloon?.urgent) && (
            <span className="pet__alert" aria-hidden="true">
              !
            </span>
          )}
          {/* Xícara de café: visível quando acordado e sem crise ativa.
              Vapor acelera brevemente quando o pet comemora (celebrating). */}
          {showAsAwake && !needingYou && !balloon?.urgent && (
            <div className="pet__coffee" aria-hidden="true">
              <CoffeeCup size={52} celebrating={celebrating} />
            </div>
          )}
          {/* Flash "cafe" — aparece por ~3 s quando um agente fica idle. */}
          {cafeinando && showAsAwake && (
            <span className="pet__cafeinando" aria-hidden="true">
              cafe
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
