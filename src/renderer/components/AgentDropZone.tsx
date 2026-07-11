import { useState } from 'react';
import { attachFilesToAgent } from '../lib/agent-attach';

/**
 * Drop zone: drag files/images onto an agent (Sprint A1).
 * Uses the same saveDropped/path injection path as the terminal.
 */
export function AgentDropZone({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  return (
    <div
      className={`agent-drop ${active ? 'agent-drop--active' : ''} ${compact ? 'agent-drop--compact' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        const files = e.dataTransfer.files;
        void attachFilesToAgent(files).then((r) => {
          setNote(
            r.ok
              ? `${r.count} anexo(s) → agent focado`
              : r.error ?? 'falha ao anexar',
          );
        });
      }}
      title="Arraste ficheiros ou imagens para o agent focado"
    >
      <span className="agent-drop__label">
        {compact ? '↓ agent' : 'Arrastar ficheiros → agent'}
      </span>
      {note && <span className="agent-drop__note">{note}</span>}
    </div>
  );
}
