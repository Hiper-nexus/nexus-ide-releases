import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandBlock } from '../../shared/command-block';
import { commandBlockSchema } from '../../shared/command-block';
import {
  commandSuggestionSchema,
  type CommandSuggestion,
  type CommandSuggestionScope,
} from '../../shared/command-refinery';
import { useToastStore } from '../state/toast-store';
import { getPaneSessionId } from '../terminal/terminal-host';
import { PixelIcon } from './PixelIcon';

export interface CommandBlockMenuProps {
  readonly paneId: string;
  readonly density?: 'full' | 'icons' | 'compact';
}

const SCOPE_LABEL: Readonly<Record<CommandSuggestionScope, string>> = {
  cwd: 'Neste diretório',
  project: 'Neste projeto',
  global: 'Histórico',
};

function parseBlocks(raw: unknown[]): CommandBlock[] {
  return raw.flatMap((item) => {
    const parsed = commandBlockSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function parseSuggestions(raw: unknown[]): CommandSuggestion[] {
  return raw.flatMap((item) => {
    const parsed = commandSuggestionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function statusLabel(status: CommandBlock['status']): string {
  if (status === 'success') return 'ok';
  if (status === 'failed') return 'falhou';
  if (status === 'running') return 'rodando';
  if (status === 'cancelled') return 'cancelado';
  return 'sem status';
}

export function CommandBlockMenu({
  paneId,
  density = 'full',
}: CommandBlockMenuProps) {
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState<CommandBlock[]>([]);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const suggestionRequestRef = useRef(0);
  const pushToast = useToastStore((state) => state.push);

  const refreshBlocks = useCallback(async () => {
    if (!window.nexus?.terminalBlock?.list) {
      setBlocks([]);
      setBlockError('Histórico de comandos indisponível');
      return;
    }
    const sessionId = getPaneSessionId(paneId) ?? undefined;
    const result = await window.nexus.terminalBlock.list({
      paneId,
      sessionId,
      limit: 8,
    });
    setBlockError(result.error ?? null);
    setBlocks(parseBlocks((result.blocks as unknown[]) ?? []));
  }, [paneId]);

  const refreshSuggestions = useCallback(
    async (nextPrefix: string) => {
      const requestId = suggestionRequestRef.current + 1;
      suggestionRequestRef.current = requestId;
      const sessionId = getPaneSessionId(paneId);
      if (!sessionId || !window.nexus?.terminalBlock?.suggest) {
        setSuggestions([]);
        setSuggestionError('Sugestões indisponíveis');
        return;
      }
      try {
        const result = await window.nexus.terminalBlock.suggest({
          sessionId,
          paneId,
          prefix: nextPrefix,
          limit: 8,
        });
        if (requestId !== suggestionRequestRef.current) return;
        setSuggestionError(result.error ?? null);
        setSuggestions(parseSuggestions(result.suggestions ?? []));
      } catch (cause) {
        if (requestId !== suggestionRequestRef.current) return;
        setSuggestions([]);
        setSuggestionError(
          cause instanceof Error ? cause.message : 'Sugestões indisponíveis',
        );
      }
    },
    [paneId],
  );

  const refreshAll = useCallback(async () => {
    setBusy(true);
    setBlockError(null);
    setSuggestionError(null);
    try {
      await Promise.all([refreshBlocks(), refreshSuggestions(prefix)]);
    } catch (cause) {
      setBlockError(
        cause instanceof Error ? cause.message : 'Falha ao atualizar',
      );
    } finally {
      setBusy(false);
    }
  }, [prefix, refreshBlocks, refreshSuggestions]);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    setBlockError(null);
    setSuggestionError(null);
    void Promise.all([refreshBlocks(), refreshSuggestions('')])
      .catch((cause: unknown) => {
        setBlockError(
          cause instanceof Error ? cause.message : 'Falha ao atualizar',
        );
      })
      .finally(() => setBusy(false));
    const onDocumentPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onDocumentKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentPointer);
    document.addEventListener('keydown', onDocumentKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentPointer);
      document.removeEventListener('keydown', onDocumentKey);
    };
  }, [open, refreshBlocks, refreshSuggestions]);

  async function runBlockAction(
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
        pushToast('warn', 'Comando', result.error ?? 'Ação recusada');
        return;
      }
      if (result.clipboardText && action.startsWith('copy_')) {
        try {
          await navigator.clipboard.writeText(result.clipboardText);
          pushToast('success', 'Copiado', result.clipboardText.slice(0, 80));
        } catch {
          pushToast('warn', 'Comando', 'Não foi possível copiar');
        }
      }
      if (action === 'rerun') {
        pushToast('success', 'Executando', block.command.slice(0, 80));
        setOpen(false);
      }
    } catch (cause) {
      pushToast(
        'warn',
        'Comando',
        cause instanceof Error ? cause.message : 'Ação recusada',
      );
    }
  }

  async function runSuggestion(suggestion: CommandSuggestion) {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId) {
      pushToast('warn', 'Comando', 'Sessão indisponível');
      return;
    }
    try {
      const result = await window.nexus.terminalBlock.runSuggestion({
        sessionId,
        paneId,
        command: suggestion.command,
        cwd: suggestion.cwd,
      });
      if (!result.ok) {
        pushToast('warn', 'Comando', result.error ?? 'Execução recusada');
        return;
      }
      pushToast('success', 'Executando', suggestion.command.slice(0, 80));
      setOpen(false);
    } catch (cause) {
      pushToast(
        'warn',
        'Comando',
        cause instanceof Error ? cause.message : 'Execução recusada',
      );
    }
  }

  async function dismissSuggestion(suggestion: CommandSuggestion) {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId) {
      pushToast('warn', 'Comando', 'Sessão indisponível');
      return;
    }
    try {
      const result = await window.nexus.terminalBlock.dismiss({
        sessionId,
        paneId,
        command: suggestion.command,
        cwd: suggestion.cwd,
      });
      if (!result.ok) {
        pushToast(
          'warn',
          'Comando',
          result.error ?? 'Não foi possível dispensar',
        );
        return;
      }
      suggestionRequestRef.current += 1;
      setSuggestions((current) =>
        current.filter(
          (item) =>
            item.command !== suggestion.command || item.cwd !== suggestion.cwd,
        ),
      );
    } catch (cause) {
      pushToast(
        'warn',
        'Comando',
        cause instanceof Error ? cause.message : 'Não foi possível dispensar',
      );
    }
  }

  return (
    <div className="cmd-blocks nodrag" ref={rootRef}>
      <button
        type="button"
        className="toolbar__btn"
        aria-label="Comandos do terminal"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip="Histórico inteligente de comandos"
        onClick={(event) => {
          event.stopPropagation();
          if (!open) setPrefix('');
          setOpen(!open);
        }}
      >
        <PixelIcon name="scroll-bottom" size={11} />
        {density === 'full' && <span className="toolbar__btn-label">Cmds</span>}
      </button>
      {open && (
        <div
          className="cmd-blocks__menu"
          role="dialog"
          aria-label="Histórico de comandos"
          data-testid="command-block-menu"
        >
          <header className="cmd-blocks__head">
            <div>
              <strong>Refinador de comandos</strong>
              <span>frequência · sucesso · recência</span>
            </div>
            <button
              type="button"
              className="cmd-blocks__refresh"
              onClick={() => void refreshAll()}
              disabled={busy}
            >
              {busy ? 'Atualizando…' : 'Atualizar'}
            </button>
          </header>

          <label className="cmd-blocks__search">
            <PixelIcon name="search" size={11} />
            <input
              value={prefix}
              aria-label="Filtrar comandos"
              placeholder="Digite para refinar…"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              onChange={(event) => {
                const nextPrefix = event.currentTarget.value;
                setPrefix(nextPrefix);
                void refreshSuggestions(nextPrefix);
              }}
            />
          </label>

          {(suggestionError || blockError) && (
            <p className="cmd-blocks__error">
              {suggestionError ?? blockError}
            </p>
          )}

          {suggestions.length > 0 && (
            <section className="cmd-refinery" aria-label="Sugestões ranqueadas">
              <div className="cmd-blocks__section-title">Sugestões</div>
              <ul className="cmd-refinery__list">
                {suggestions.map((suggestion) => (
                  <li
                    key={JSON.stringify([suggestion.cwd, suggestion.command])}
                    className="cmd-refinery__item"
                    data-scope={suggestion.scope}
                  >
                    <button
                      type="button"
                      className="cmd-refinery__run"
                      aria-label={`Executar sugestão: ${suggestion.command}`}
                      onClick={() => void runSuggestion(suggestion)}
                    >
                      <span className="cmd-refinery__scope">
                        {SCOPE_LABEL[suggestion.scope]}
                      </span>
                      <code title={suggestion.command}>{suggestion.command}</code>
                      <span className="cmd-refinery__meta">
                        {suggestion.totalCount}× ·{' '}
                        {Math.round(suggestion.successRate * 100)}% sucesso
                      </span>
                    </button>
                    <button
                      type="button"
                      className="cmd-refinery__dismiss"
                      aria-label={`Dispensar sugestão: ${suggestion.command}`}
                      data-tip="Dispensar até o próximo uso"
                      onClick={() => void dismissSuggestion(suggestion)}
                    >
                      <PixelIcon name="close" size={10} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-label="Comandos recentes">
            <div className="cmd-blocks__section-title">Recentes</div>
            {!blockError && blocks.length === 0 && (
              <p className="cmd-blocks__empty">
                Os próximos comandos concluídos aparecerão aqui.
              </p>
            )}
            <ul className="cmd-blocks__list">
              {blocks.map((block) => (
                <li key={block.id} className="cmd-blocks__item">
                  <div className="cmd-blocks__row">
                    <span
                      className={`cmd-blocks__status cmd-blocks__status--${block.status}`}
                    >
                      {statusLabel(block.status)}
                    </span>
                    <code className="cmd-blocks__cmd" title={block.command}>
                      {block.command || '(vazio)'}
                    </code>
                  </div>
                  <div className="cmd-blocks__actions" role="group">
                    <button
                      type="button"
                      onClick={() => void runBlockAction('copy_command', block)}
                    >
                      Copiar
                    </button>
                    <button
                      type="button"
                      onClick={() => void runBlockAction('copy_path', block)}
                    >
                      Diretório
                    </button>
                    <button
                      type="button"
                      disabled={block.status === 'running' || !block.command.trim()}
                      onClick={() => void runBlockAction('rerun', block)}
                    >
                      Executar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
