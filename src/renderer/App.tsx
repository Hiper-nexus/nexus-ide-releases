import { useEffect } from 'react';
import { useLayoutStore } from './state/layout-store';
import { WorkspaceBar } from './components/WorkspaceBar';
import { PaneGrid } from './components/PaneGrid';

/**
 * App root: hydrates the saved layout on boot and wires global keyboard
 * shortcuts (split/close) against the currently focused pane.
 */
export function App() {
  const hydrated = useLayoutStore((s) => s.hydrated);
  const hydrate = useLayoutStore((s) => s.hydrate);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.layout.load().then((layout) => {
      if (!cancelled) hydrate(layout);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const { focusedPaneId, split, close } = useLayoutStore.getState();
      if (!focusedPaneId) return;

      const key = e.key.toLowerCase();
      if (key === 'd') {
        e.preventDefault();
        split(focusedPaneId, e.shiftKey ? 'column' : 'row');
      } else if (key === 'w') {
        e.preventDefault();
        close(focusedPaneId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!hydrated) {
    return <div className="boot">Starting NexusIDE…</div>;
  }

  return (
    <div className="app">
      <WorkspaceBar />
      <main className="app__body">
        <PaneGrid />
      </main>
    </div>
  );
}
