/**
 * Minimal CommandBlock UI: list recent semantic commands for a pane and run
 * copy / re-run via window.nexus.terminalBlock (main ownership + policy).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandBlock } from '../../shared/command-block';
import { commandBlockSchema } from '../../shared/command-block';
import { getPaneSessionId } from '../terminal/terminal-host';
import { useToastStore } from '../state/toast-store';
import { PixelIcon } from './PixelIcon';

export interface CommandBlockMenuProps {
  readonly paneId: string;
  readonly density?: 'full' | 'icons' | 'compact';
}

function parseBlocks(raw: unknown[]): CommandBlock[] {
  const out: CommandBlock[] = [];
  for (const item of raw) {
    try {
      out.push(commandBlockSchema.parse(item));
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

function statusLabel(status: CommandBlock['status']): string {
  if (status === 'success') return 'ok';
  if (status === 'failed') return 'fail';
  if (status === 'running') return 'run';
  if (status === 'cancelled') return 'cancel';
  return status;
}

export function CommandBlockMenu({
  paneId,
  density = 'full',
}: CommandBlockMenuProps) {
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState<CommandBlock[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pushToast = useToastStore((s) => s.push);

  const refresh = useCallback(async () => {
    if (!window.nexus?.terminalBlock?.list) {
      setBlocks([]);
      setError('Command blocks API unavailable');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sessionId = getPaneSessionId(paneId) ?? undefined;
      const result = await window.nexus.terminalBlock.list({
        paneId,
        sessionId,
        limit: 12,
      });
      if (result.error) setError(result.error);
      setBlocks(parseBlocks((result.blocks as unknown[]) ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'list failed');
      setBlocks([]);
    } finally {
      setBusy(false);
    }
  }, [paneId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, refresh]);

  async function runAction(
    action: 'copy_command' | 'copy_path' | 'rerun',
    block: CommandBlock,
  ) {
    try {
      const result = await window.nexus.terminalBlock.action({
        action,
        block: {
          id: block.id,
          sessionId: block.sessionId,
          paneId: block.paneId,
          workspaceId: block.workspaceId,
          missionId: block.missionId,
          command: block.command,
          cwd: block.cwd,
          projectRoot: block.projectRoot,
          shell: block.shell,
          status: block.status,
        },
      });
      if (!result.ok) {
        pushToast('warn', 'Command block', result.error ?? 'action failed');
        return;
      }
      if (result.clipboardText && action.startsWith('copy_')) {
        try {
          await navigator.clipboard.writeText(result.clipboardText);
          pushToast('success', 'Copiado', result.clipboardText.slice(0, 80));
        } catch {
          pushToast('success', 'Copiado', 'texto pronto (clipboard blocked)');
        }
      }
      if (action === 'rerun') {
        pushToast('success', 'Re-run', block.command.slice(0, 80));
        setOpen(false);
      }
    } catch (err) {
      pushToast(
        'warn',
        'Command block',
        err instanceof Error ? err.message : 'action failed',
      );
    }
  }

  return (
    <div className="cmd-blocks nodrag" ref={rootRef}>
      <button
        type="button"
        className="toolbar__btn"
        aria-label="Comandos do terminal"
        aria-expanded={open}
        data-tip="Comandos recentes (OSC 133 / CommandBlocks)"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <PixelIcon name="scroll-bottom" size={11} />
        {density === 'full' && (
          <span className="toolbar__btn-label">Cmds</span>
        )}
      </button>
      {open && (
        <div
          className="cmd-blocks__menu"
          role="menu"
          aria-label="Comandos recentes"
          data-testid="command-block-menu"
        >
          <header className="cmd-blocks__head">
            <strong>Comandos</strong>
            <button
              type="button"
              className="cmd-blocks__refresh"
              onClick={() => void refresh()}
              disabled={busy}
            >
              {busy ? '…' : 'Atualizar'}
            </button>
          </header>
          {error && <p className="cmd-blocks__error">{error}</p>}
          {!error && blocks.length === 0 && (
            <p className="cmd-blocks__empty">
              Nenhum bloco ainda. Shells com integração OSC 133 registram
              comandos aqui.
            </p>
          )}
          <ul className="cmd-blocks__list">
            {blocks.map((b) => (
              <li key={b.id} className="cmd-blocks__item" role="none">
                <div className="cmd-blocks__row">
                  <span
                    className={`cmd-blocks__status cmd-blocks__status--${b.status}`}
                  >
                    {statusLabel(b.status)}
                  </span>
                  <code className="cmd-blocks__cmd" title={b.command}>
                    {b.command || '(vazio)'}
                  </code>
                </div>
                <div className="cmd-blocks__actions" role="group">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void runAction('copy_command', b)}
                  >
                    Copiar
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void runAction('copy_path', b)}
                  >
                    Cwd
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={b.status === 'running' || !b.command.trim()}
                    onClick={() => void runAction('rerun', b)}
                  >
                    Re-run
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
