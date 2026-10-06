import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PixelIcon } from '../PixelIcon';
import type { GraphOrientation } from './mission-graph-cabling';

export const MIN_GRAPH_ZOOM = 0.6;
export const MAX_GRAPH_ZOOM = 1.5;
type PresentationMode = 'inline' | 'native' | 'overlay';

export function useMissionGraphPresentation(hasAgents: boolean) {
  const [orientation, setOrientation] = useState<GraphOrientation>('vertical');
  const [mode, setMode] = useState<PresentationMode>('inline');
  const [manualZoom, setManualZoom] = useState(1);
  const [fit, setFit] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const sectionRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const focusBefore = useRef<HTMLElement | null>(null);
  const nativeElement = useRef<HTMLElement | null>(null);
  const modeRef = useRef<PresentationMode>('inline');
  const mounted = useRef(true);
  modeRef.current = mode;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (
        nativeElement.current &&
        document.fullscreenElement === nativeElement.current
      ) {
        void document.exitFullscreen?.().catch(() => {});
      }
      if (focusBefore.current?.isConnected) focusBefore.current.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () =>
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, hasAgents]);

  useLayoutEffect(() => {
    if (mode !== 'inline') fullscreenButtonRef.current?.focus();
    else if (focusBefore.current) {
      (focusBefore.current.isConnected
        ? focusBefore.current
        : fullscreenButtonRef.current
      )?.focus();
      focusBefore.current = null;
    }
  }, [mode]);

  const exit = async () => {
    if (
      nativeElement.current &&
      document.fullscreenElement === nativeElement.current
    ) {
      try {
        await document.exitFullscreen();
      } catch {
        return;
      }
    }
    if (mounted.current) setMode('inline');
  };
  useEffect(() => {
    const fullscreenChanged = () => {
      if (
        modeRef.current === 'native' &&
        document.fullscreenElement !== nativeElement.current
      )
        setMode('inline');
    };
    const keydown = (event: KeyboardEvent) => {
      if (modeRef.current === 'inline') return;
      const section = sectionRef.current;
      if (!section || section.closest('[inert], [aria-hidden="true"]')) return;
      const target = event.target as Node | null;
      if (target && target !== document && target !== document.body && !section.contains(target)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        void exit();
      }
      if (event.key === 'Tab') {
        const buttons = [
          ...(sectionRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ];
        const first = buttons[0],
          last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('fullscreenchange', fullscreenChanged);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      document.removeEventListener('keydown', keydown, true);
    };
  }, []);

  useEffect(() => {
    if (!hasAgents && modeRef.current !== 'inline') void exit();
  }, [hasAgents]);

  const enter = async () => {
    if (modeRef.current !== 'inline') return;
    focusBefore.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const section = sectionRef.current;
    if (section?.requestFullscreen) {
      try {
        await section.requestFullscreen();
        if (!mounted.current) {
          if (document.fullscreenElement === section)
            void document.exitFullscreen?.().catch(() => {});
          return;
        }
        if (document.fullscreenElement === section) {
          nativeElement.current = section;
          setMode('native');
          setFit(true);
          return;
        }
      } catch {
        /* Electron may disable native fullscreen; the app overlay still presents the graph. */
      }
    }
    if (mounted.current) {
      setMode('overlay');
      setFit(true);
    }
  };
  return {
    orientation,
    setOrientation,
    mode,
    sectionRef,
    viewportRef,
    fullscreenButtonRef,
    viewport,
    manualZoom,
    fit,
    setFit,
    enter,
    exit,
    changeZoom: (zoom: number) => {
      setFit(false);
      setManualZoom(
        Math.max(
          MIN_GRAPH_ZOOM,
          Math.min(MAX_GRAPH_ZOOM, Math.round(zoom * 10) / 10),
        ),
      );
    },
  };
}

export function MissionGraphToolbar({
  view,
  zoom,
}: {
  view: ReturnType<typeof useMissionGraphPresentation>;
  zoom: number;
}) {
  const expanded = view.mode !== 'inline';
  return (
    <div
      className="mission-graph__toolbar"
      role="toolbar"
      aria-label="Apresentação do grafo"
    >
      <button
        type="button"
        className="mission-graph__fullscreen"
        ref={view.fullscreenButtonRef}
        onClick={() => void (expanded ? view.exit() : view.enter())}
      >
        <PixelIcon name="maximize" />
        {expanded ? 'Sair da tela inteira' : 'Tela inteira'}
      </button>
      <div
        className="mission-graph__orientation"
        role="group"
        aria-label="Direção do grafo"
      >
        <button
          type="button"
          aria-pressed={view.orientation === 'vertical'}
          onClick={() => view.setOrientation('vertical')}
        >
          Vertical
        </button>
        <button
          type="button"
          aria-pressed={view.orientation === 'horizontal'}
          onClick={() => view.setOrientation('horizontal')}
        >
          Horizontal
        </button>
      </div>
      <button
        type="button"
        aria-pressed={view.fit}
        onClick={() => {
          view.setFit(true);
          view.viewportRef.current?.scrollTo?.({ top: 0, left: 0 });
        }}
      >
        Ajustar à tela
      </button>
      <div
        className="mission-graph__zoom-controls"
        role="group"
        aria-label="Zoom do grafo"
      >
        <button
          type="button"
          aria-label="Diminuir zoom"
          disabled={zoom <= MIN_GRAPH_ZOOM}
          onClick={() => view.changeZoom(zoom - 0.1)}
        >
          −
        </button>
        <output className="mission-graph__zoom" aria-label="Zoom atual">
          {Math.round(zoom * 100)}%
        </output>
        <button
          type="button"
          aria-label="Aumentar zoom"
          disabled={zoom >= MAX_GRAPH_ZOOM}
          onClick={() => view.changeZoom(zoom + 0.1)}
        >
          +
        </button>
      </div>
    </div>
  );
}
